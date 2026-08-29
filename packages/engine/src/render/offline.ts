/**
 * Render offline: el MISMO KernelCore que suena en vivo, en un bucle puro.
 * Determinista (misma entrada → mismos samples) y más rápido que tiempo real.
 * Corre en Node (export CLI/tests) y en el navegador (Web Worker o directo).
 */

import { KernelCore, MAX_BLOCK } from '../kernel-core';
import type { CompiledProject } from '../protocol';
import type { SampleData } from '../dsp/voices';

export interface RenderOptions {
  sampleRate?: number;
  /** Cola de reverb/delay tras el final, en segundos. */
  tailSeconds?: number;
  samples?: Map<string, SampleData>;
  /** Plugins JS de usuario (pluginId → código fuente) usados por el proyecto. */
  plugins?: Map<string, string>;
  /**
   * Renderiza solo un tramo del timeline (consolidar un clip, por ejemplo).
   * Automatización y LFOs se derivan de la posición, así que arrancar en
   * `startBeat` da EXACTAMENTE lo mismo que renderizar todo y recortar; lo
   * único que no viaja es la cola de lo que sonaba antes del tramo.
   */
  startBeat?: number;
  endBeat?: number;
  onProgress?: (fraction: number) => void;
  /**
   * Punto de comprobación de cancelación DENTRO del render, no solo entre
   * pistas. Se lee con la MISMA cadencia que `onProgress` (cada 64 bloques,
   * ver el bucle de abajo) para no añadir coste al bucle caliente: es la
   * comprobación de `onProgress` la que ya paga el `written % ... === 0`, así
   * que colgar `isCancelled` del mismo `if` no cuesta un branch más por
   * bloque, solo uno más cada ~8192 muestras (~186 ms a 44,1 kHz). Sin esto,
   * cancelar un export solo podía cortar ENTRE pistas (`renderStems` en
   * `run-export.ts`): para una sola pista de una canción larga, eso no basta
   * — el usuario espera esa pista entera igual.
   *
   * No sirve para el worker (una función no sobrevive un `postMessage`): ahí
   * la cancelación de verdad la hace `cancelActiveRenderWorker` tirando el
   * worker entero (ver `packages/ui/src/export/render-in-worker.ts`), que
   * además es gratis en el bucle caliente porque no comprueba nada dentro.
   * Este flag es el mecanismo para Node/tests (sin `Worker`) y para quien
   * llame a `renderProject`/`renderStems` directo.
   */
  isCancelled?: () => boolean;
}

/** Señal de que un render se cortó porque lo pidió quien llama, no un fallo del DSP. */
export class RenderCancelledError extends Error {
  constructor() {
    super('Render cancelado.');
    this.name = 'RenderCancelledError';
  }
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

const HARD_CAP_SECONDS = 60 * 20;

/**
 * Copia lo ÚNICO que el kernel ESCRIBE del proyecto compilado: los params de
 * canal y de efecto, los faders y el EQ (ahí es donde aterrizan la
 * automatización y los LFOs).
 *
 * Sin esto, un render deja el compilado tocado y el siguiente arranca de otro
 * estado: renderizar la mezcla y luego cada stem con el MISMO compilado —que es
 * exactamente lo que hace el export— daba stems que no cuadraban con la mezcla,
 * y pedir dos veces el mismo stem daba dos archivos distintos. Medido: 39 039
 * muestras distintas entre dos renders del mismo stem, y `volume` derivando
 * 0.78 → 0.7654 tras cuatro renders.
 */
function isolate(p: CompiledProject): CompiledProject {
  return {
    ...p,
    channels: p.channels.map((c) => ({
      ...c,
      params: { ...c.params },
      ...(c.fx ? { fx: c.fx.map((s) => (s ? { ...s, params: { ...s.params } } : null)) } : null),
    })),
    mixer: p.mixer.map((t) => ({
      ...t,
      slots: t.slots.map((s) => (s ? { ...s, params: { ...s.params } } : null)),
      sends: t.sends.map((s) => ({ ...s })),
    })),
  };
}

export function renderProject(
  fullProject: CompiledProject,
  opts: RenderOptions = {},
): RenderResult {
  const sr = opts.sampleRate ?? 44100;
  const tail = opts.tailSeconds ?? 2;
  const core = new KernelCore(sr);

  // El kernel para cuando la posición alcanza lengthBeats: acortar el timeline
  // es lo que define el final del tramo.
  const startBeat = Math.max(0, opts.startBeat ?? 0);
  const project =
    opts.endBeat !== undefined && opts.endBeat < fullProject.lengthBeats
      ? { ...fullProject, lengthBeats: Math.max(startBeat + 1e-6, opts.endBeat) }
      : fullProject;

  if (opts.samples) {
    for (const [id, s] of opts.samples) {
      core.handleMessage({
        type: 'loadSample',
        sampleId: id,
        left: s.left,
        right: s.right,
        sampleRate: s.rate,
      });
    }
  }
  if (opts.plugins) {
    for (const [id, code] of opts.plugins) {
      core.handleMessage({ type: 'registerPlugin', pluginId: id, code });
    }
  }
  core.handleMessage({ type: 'snapshot', project: isolate(project) });
  core.handleMessage({ type: 'setLoop', start: 0, end: project.lengthBeats, enabled: false });
  core.handleMessage({ type: 'play', fromBeat: startBeat });

  // El tempo del beat 0 no vale para estimar cuánto dura esto: un marcador
  // puede bajarlo a mitad de canción y entonces el tope corta el render antes
  // de que se acabe la música (medido: 42 s amputados en un 120 → 30 BPM).
  let slowest = project.tempo;
  for (const t of project.tempoMap ?? []) if (t.tempo > 0 && t.tempo < slowest) slowest = t.tempo;
  const estSeconds =
    (Math.max(0, project.lengthBeats - startBeat) * 60) / Math.max(1, slowest) + tail;
  const capSamples = Math.ceil(Math.min(HARD_CAP_SECONDS, estSeconds * 3 + 10) * sr);
  const chunks: Float32Array[] = [];
  const chunksR: Float32Array[] = [];
  const blockL = new Float32Array(MAX_BLOCK);
  const blockR = new Float32Array(MAX_BLOCK);

  let written = 0;
  let tailLeft = Math.ceil(tail * sr);
  const estTotal = Math.ceil(estSeconds * sr);

  while (written < capSamples) {
    core.process(blockL, blockR, MAX_BLOCK);
    chunks.push(blockL.slice());
    chunksR.push(blockR.slice());
    written += MAX_BLOCK;
    if (!core.playing) {
      tailLeft -= MAX_BLOCK;
      if (tailLeft <= 0) break;
    }
    // Mismo guard que antes (`opts.onProgress &&`, ahora + `opts.isCancelled`):
    // sin ninguno de los dos registrado, el módulo ni se calcula — no pagar
    // nada en el caso común (bounce/consolidar, que no pasa ninguno de los dos).
    if ((opts.onProgress || opts.isCancelled) && written % (MAX_BLOCK * 64) === 0) {
      if (opts.isCancelled?.()) {
        core.dispose();
        throw new RenderCancelledError();
      }
      opts.onProgress?.(Math.min(0.99, written / estTotal));
    }
  }

  // El kernel se tira aquí, pero sus voces pueden seguir vivas (cola cortada,
  // tope duro alcanzado). Hay que soltarlas: los pools de recursos que usan
  // algunos instrumentos son de módulo, así que lo que no se devuelva se
  // pierde para el resto del proceso, no solo para este render.
  core.dispose();

  const left = new Float32Array(written);
  const right = new Float32Array(written);
  for (let i = 0; i < chunks.length; i++) {
    left.set(chunks[i]!, i * MAX_BLOCK);
    right.set(chunksR[i]!, i * MAX_BLOCK);
  }
  opts.onProgress?.(1);
  return { left, right, sampleRate: sr };
}

/**
 * Stems: un render por pista del mixer, aislando su audio pero pasando por la
 * cadena completa (efectos de master incluidos).
 *
 * No basta con dejar audibles la pista y el master: si la pista va ruteada a un
 * bus intermedio (routeTo) o manda a un retorno de reverb (send), esas pistas
 * también llevan su audio hasta el master. Silenciarlas dejaba el stem mudo (por
 * bus) o seco (sin la cola del send). Se mantiene audible el cierre "aguas abajo"
 * de la pista: su cadena de routeTo y los destinos de sus sends, transitivamente.
 *
 * Y también el de aguas ARRIBA, o el stem de una pista de bus —la de la carpeta
 * de batería, por ejemplo— saldría en silencio: el bus no genera nada, solo suma
 * lo que le llega. Ver `audibleTracksForStem`.
 */
export interface StemBatchResult {
  /** Stems que sí se pudieron renderizar, por índice de pista. */
  results: Map<number, RenderResult>;
  /** Pistas del lote que reventaron al renderizar, con el motivo. */
  errors: Map<number, string>;
}

/**
 * Un `try/catch` POR PISTA: si el render de una revienta (una excepción real
 * del kernel, no algo que se pueda validar antes), NO tira con ella las demás
 * pistas del mismo lote que ya se habían renderizado con éxito.
 *
 * Antes de esto, la excepción de una sola pista subía sin capturar y `renderStems`
 * entero fallaba: para un lote de `STEM_BATCH_SIZE` (ver run-export.ts) eso podía
 * perder hasta 3 stems buenos por uno malo. Con lotes más grandes que 1 —que es
 * justo lo que se pidió para no clonar `samples` una vez por pista— aislar por
 * pista dentro del lote pasa de ser un detalle a ser obligatorio.
 *
 * La decisión de qué hacer con el resto del export es de quien llama a esto
 * (run-export.ts): aquí solo se garantiza no perder lo que ya salió bien. Ver
 * `errors` para el motivo de cada pista que faltó — el llamante decide si eso
 * es aviso o excepción, pero nunca borra un `Map` entero por una sola entrada.
 *
 * Cancelación (`opts.isCancelled`): se comprueba ANTES de cada pista del lote
 * —parada entre pistas, barata— y si `renderProject` la corta A MITAD de una
 * pista con `RenderCancelledError`, ese `break` también corta el lote ahí
 * mismo. En los dos casos se conserva `results` con lo que YA se había
 * renderizado de pistas anteriores del mismo lote (nada se descarta, nada se
 * escribe todavía: eso lo hace `run-export.ts`), y la pista cortada no entra
 * en `errors` — cancelar no es un fallo de esa pista, es que dejó de pedirse.
 */
export function renderStems(
  project: CompiledProject,
  trackIndices: number[],
  opts: RenderOptions = {},
): StemBatchResult {
  const results = new Map<number, RenderResult>();
  const errors = new Map<number, string>();
  for (const idx of trackIndices) {
    if (opts.isCancelled?.()) break;
    try {
      const keep = audibleTracksForStem(project, idx);
      const solo: CompiledProject = {
        ...project,
        mixer: project.mixer.map((t, i) => ({
          ...t,
          slots: t.slots.map((s) => (s ? { ...s, params: { ...s.params } } : null)),
          sends: t.sends.map((s) => ({ ...s })),
          audible: keep.has(i) ? t.audible : false,
        })),
      };
      results.set(idx, renderProject(solo, opts));
    } catch (e) {
      if (e instanceof RenderCancelledError) break;
      // `renderProject` puede reventar a mitad de render (tras haber llamado ya
      // a `opts.onProgress` con fracciones intermedias) sin llegar nunca a su
      // `onProgress(1)` de cierre incondicional. `trackStemProgress` (en
      // packages/ui/src/export/stem-progress.ts) numera las pistas siguientes
      // contando esos cierres: sin este `onProgress(1)` sintético aquí, la
      // pista rota se queda "abierta" para siempre y el resto del lote se
      // anuncia con el índice corrido en uno.
      opts.onProgress?.(1);
      errors.set(idx, e instanceof Error ? e.message : String(e));
    }
  }
  return { results, errors };
}

/**
 * Pistas que deben seguir audibles para aislar el stem de `idx`: la propia, el
 * master, todo lo que transporta su audio hacia el master (aguas ABAJO: routeTo
 * + destinos de sends, transitivamente) y todo lo que desemboca en ella (aguas
 * ARRIBA). Las demás quedan mudas.
 *
 * Lo de aguas arriba es lo que hace que un BUS tenga stem. Sin ello, el stem de
 * la pista de bus de la batería salía en silencio absoluto: el bus no genera
 * nada por sí mismo y las seis pistas que lo alimentan estaban muteadas. Lo
 * mismo le pasaba a un retorno de reverb (su stem salía sin nada que reverberar)
 * y al propio Master, cuyo "stem" era solo lo que entra directo en él. Aguas
 * arriba, el stem de una pista es todo lo que suena EN esa pista, que es lo que
 * quiere decir la palabra.
 *
 * Y no rompe el aislamiento de una pista normal: de una hoja del grafo —una
 * pista de instrumento— no cuelga nada aguas arriba, así que su stem sale
 * exactamente igual que antes.
 */
export function audibleTracksForStem(project: CompiledProject, idx: number): Set<number> {
  const keep = new Set<number>([0, idx]);

  // Aguas abajo: por dónde sale lo de `idx` camino del master.
  const down = [idx];
  while (down.length > 0) {
    const t = down.pop()!;
    const track = project.mixer[t];
    if (!track) continue;
    if (track.routeTo !== null && !keep.has(track.routeTo)) {
      keep.add(track.routeTo);
      down.push(track.routeTo);
    }
    for (const send of track.sends) {
      if (!keep.has(send.target)) {
        keep.add(send.target);
        down.push(send.target);
      }
    }
  }

  // Aguas arriba: quién alimenta a `idx`. Se hace sobre el grafo INVERSO, que
  // se construye una vez; seguirlo desde el master traería todo el proyecto,
  // pero eso es precisamente el stem del master (la mezcla).
  const feeders = new Map<number, number[]>();
  project.mixer.forEach((track, i) => {
    const targets = new Set<number>();
    if (track.routeTo !== null) targets.add(track.routeTo);
    for (const send of track.sends) targets.add(send.target);
    targets.delete(i);
    for (const target of targets) {
      const list = feeders.get(target);
      if (list) list.push(i);
      else feeders.set(target, [i]);
    }
  });
  const up = [idx];
  const seenUp = new Set<number>([idx]);
  while (up.length > 0) {
    const t = up.pop()!;
    for (const from of feeders.get(t) ?? []) {
      if (seenUp.has(from)) continue;
      seenUp.add(from);
      keep.add(from);
      up.push(from);
    }
  }
  return keep;
}
