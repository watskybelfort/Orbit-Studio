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
    if (opts.onProgress && written % (MAX_BLOCK * 64) === 0) {
      opts.onProgress(Math.min(0.99, written / estTotal));
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
 */
export function renderStems(
  project: CompiledProject,
  trackIndices: number[],
  opts: RenderOptions = {},
): Map<number, RenderResult> {
  const out = new Map<number, RenderResult>();
  for (const idx of trackIndices) {
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
    out.set(idx, renderProject(solo, opts));
  }
  return out;
}

/**
 * Pistas que deben seguir audibles para aislar el stem de `idx`: la propia, el
 * master y todo lo que transporta su audio hacia el master (routeTo + destinos
 * de sends, transitivamente). Las demás pistas quedan mudas: los buses que se
 * conservan solo llevan lo de `idx`, porque el resto de fuentes están a cero.
 */
function audibleTracksForStem(project: CompiledProject, idx: number): Set<number> {
  const keep = new Set<number>([0, idx]);
  const stack = [idx];
  while (stack.length > 0) {
    const t = stack.pop()!;
    const track = project.mixer[t];
    if (!track) continue;
    if (track.routeTo !== null && !keep.has(track.routeTo)) {
      keep.add(track.routeTo);
      stack.push(track.routeTo);
    }
    for (const send of track.sends) {
      if (!keep.has(send.target)) {
        keep.add(send.target);
        stack.push(send.target);
      }
    }
  }
  return keep;
}
