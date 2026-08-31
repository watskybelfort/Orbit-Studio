/**
 * Grabación de micro a la playlist (el flujo de voz sobre beat de Orbit):
 * el botón de grabar abre el micro, graba mientras suena el transporte y al
 * parar guarda la toma como WAV en userData/recordings (esquema `recording:`
 * en SampleRef.path), la sube al kernel y coloca el clip de audio en el beat
 * donde empezó — todo en un undo.
 *
 * **La toma la captura el KERNEL, en crudo.** Antes esto lo hacía
 * `MediaRecorder`, que en este Electron solo sabe webm/opus: cada toma se
 * comprimía con pérdida y se volvía a decodificar para escribirla como WAV de
 * 24 bits que ya no tenía 24 bits de información. Ahora el micro entra por la
 * entrada del nodo del kernel y sus muestras vuelven tal cual en los frames de
 * medidores. Además arranca en el bloque siguiente al mensaje (~3 ms) en vez
 * de cuando el navegador tenga a bien abrir su codificador.
 *
 * **Y una toma por ENTRADA ARMADA, no una sola.** Con una interfaz de varias
 * entradas, cada ruta armada (`model/input-routing.ts` de `@orbit/core`)
 * graba lo suyo y cae en SU pista, todo en el mismo paso de undo: dos micros
 * a la vez salen de UN stream multicanal, nunca de dos `getUserMedia` sobre el
 * mismo aparato — el motivo está tres párrafos más abajo, en `startRecording`.
 */

import {
  armedInputRoutes,
  createPlaylistTrack,
  newId,
  type Clip,
  type Command,
  type Id,
  type Project,
  type ResolvedInputRoute,
  type SampleRef,
} from '@orbit/core';
import { encodeWav, type InputCaptureChunk } from '@orbit/engine';
import { create } from 'zustand';
import { sha1Hex } from '../browser/sound-actions';
import { currentBeat, engine, ensureAudioReady, play, stopPlayback, store, togglePlay } from './app';
import {
  currentInputRoutes,
  currentInputStream,
  setInputStreamFactory,
  startInputMonitor,
  stopInputMonitor,
  useInputMonitorStore,
} from './input-monitor';
import { getLatencyCompensationSamples, useLatencyCalibrationStore } from './latency-calibration';
import { compensateClipStart } from './input-latency';
import { pinSample, unpinSample } from './sample-gc';
import { useUiStore } from './ui';

export type RecorderPhase = 'idle' | 'countin' | 'recording' | 'saving';

interface RecorderState {
  phase: RecorderPhase;
  error: string | null;
  /** Compases de cuenta atrás antes de grabar (0 = sin cuenta). */
  countInBars: number;
  /** Beats que faltan durante la cuenta (para el rótulo del botón: 4·3·2·1). */
  countdown: number;

}

export const useRecorderStore = create<RecorderState>(() => ({
  phase: 'idle',
  error: null,
  countInBars: 1,
  countdown: 0,
}));

/** Cambia la cuenta atrás: 0 (sin cuenta) → 1 → 2 compases. */
export function cycleCountIn(): void {
  const bars = useRecorderStore.getState().countInBars;
  useRecorderStore.setState({ countInBars: bars >= 2 ? 0 : bars + 1 });
}

/**
 * Pista donde cayó la última toma DE CADA ENTRADA: la siguiente se apila ahí
 * en otro carril. Va por ruta y no global porque con dos micros a la vez cada
 * uno tiene su propia pila de tomas — apilar la guitarra encima de la voz
 * sería comping entre cosas distintas.
 *
 * La clave es el id de la ruta; la entrada implícita (sin enrutado declarado)
 * usa la cadena vacía, o sea el comportamiento de siempre.
 */
const lastTakeTrackByRoute = new Map<string, Id>();
/**
 * ¿El micro lo abrió esta grabación? Si ya estaba abierto es del monitor de
 * entrada: cerrarlo al guardar la toma dejaría al usuario sin oírse justo
 * después de cantar.
 */
let ownsInput = false;
/** Estamos recogiendo muestras del kernel. */
let capturing = false;
let startBeat = 0;

/** Una toma en curso: los trozos que va soltando el kernel para UNA ruta. */
interface TakeBuffer {
  /** Índice de la ruta dentro de `currentInputRoutes()`. */
  index: number;
  route: ResolvedInputRoute;
  left: Float32Array[];
  right: Float32Array[];
  total: number;
  /** Carril de comping que le tocó al colocarla (lo pone `placeTake`). */
  lane?: number;
}

/**
 * Las tomas de esta grabación, una por entrada armada y en orden de índice.
 * Vacío = no se está grabando.
 */
let takes: TakeBuffer[] = [];

/**
 * Índice de la ruta cuyo audio llega por el camino de SIEMPRE —el
 * `inputCaptureL/R` del frame de medidores, que el kernel rellena con la
 * primera ruta que grabe—. Las demás llegan por `engine.onInputCaptures`.
 *
 * Que la primera siga viniendo por donde vino siempre no es una peculiaridad
 * gratuita: es lo que deja intacto el caso normal (un micro, una toma) y con
 * él la calibración de latencia, que se cuelga de ese mismo camino.
 */
let primaryRoute = 0;

/**
 * Sumidero alternativo para la entrada en crudo: lo usa la calibración de
 * latencia (`latency-calibration.ts`) para quedarse con los paquetes en vez
 * de que caigan en la toma. Las dos cosas NUNCA corren a la vez —grabar una
 * toma y calibrar el bucle del aparato se rechazan mutuamente, ver
 * `startRecording` y `runLatencyCalibration`— así que no hace falta
 * repartir, solo desviar.
 */
let rawInputSink: ((left: Float32Array, right: Float32Array) => void) | null = null;

export function setRawInputSink(
  sink: ((left: Float32Array, right: Float32Array) => void) | null,
): void {
  rawInputSink = sink;
}

/**
 * Trozo de entrada en crudo de un frame del kernel (lo llama el puente de
 * medidores). Llegan cada ~43 ms y se pegan al final sin copiar nada: la
 * concatenación se hace UNA vez, al cerrar la toma.
 *
 * Este camino trae SIEMPRE la primera ruta que esté grabando, y es el que
 * comparte con la calibración: mientras su sumidero está puesto, aquí no se
 * queda nada. Las rutas de más (grabar dos micros a la vez) no pasan por aquí
 * —pasan por `handleInputCaptures`— justamente para que este desvío siga
 * siendo lo que era: un `if` al principio y nada más.
 */
export function pushInputChunk(left: Float32Array, right: Float32Array): void {
  if (rawInputSink) {
    rawInputSink(left, right);
    return;
  }
  if (!capturing) return;
  pushTakeChunk(primaryRoute, left, right);
}

/** Pega un trozo a la toma de una ruta (si esa ruta está grabando). */
function pushTakeChunk(routeIndex: number, left: Float32Array, right: Float32Array): void {
  const take = takes.find((t) => t.index === routeIndex);
  if (!take) return;
  take.left.push(left);
  take.right.push(right);
  take.total += left.length;
}

/**
 * Las rutas de MÁS de una grabación multicanal, tal como las manda el motor.
 *
 * Se salta la primera a propósito: esa ya llegó por `pushInputChunk` con el
 * mismo Float32Array, y recogerla dos veces duplicaría la toma. Y con la
 * calibración en marcha `takes` está vacío, así que esto no hace nada — las
 * dos cosas no corren nunca a la vez (ver `startRecording`).
 */
function handleInputCaptures(chunks: InputCaptureChunk[]): void {
  if (!capturing || takes.length < 2) return;
  for (const chunk of chunks) {
    if (chunk.routeIndex === primaryRoute) continue;
    pushTakeChunk(chunk.routeIndex, chunk.left, chunk.right);
  }
}

function concatChunks(parts: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Fuente del micro, inyectable para QA (fuente sintética, sin micro real). Se
 * queda como envoltorio del monitor de entrada, que es quien abre el micro
 * ahora, para no romper el gancho que ya existía.
 */
export function setRecorderStreamFactory(f: () => Promise<MediaStream>): void {
  setInputStreamFactory(() => f());
}

export async function toggleRecording(): Promise<void> {
  const { phase } = useRecorderStore.getState();
  if (phase === 'recording') return stopRecording();
  if (phase === 'countin') {
    // Cancelar durante la cuenta: ni toma ni clip.
    cancelCountIn = true;
    return;
  }
  if (phase === 'idle') return startRecording();
}

/** Bandera de cancelación mientras corre la cuenta atrás. */
let cancelCountIn = false;
/** Hay un arranque de grabación en vuelo (ver la guarda de `startRecording`). */
let starting = false;

/**
 * Cuenta atrás SIN sitio por delante (grabar desde el compás 1): el transporte
 * se queda parado en el beat objetivo y la cuenta la lleva el KERNEL —clic por
 * beat al tempo del proyecto y, un beat después del último, el transporte
 * entra solo en `target`.
 *
 * Antes esto era un `setTimeout` por compás con el metrónomo puesto, y el
 * metrónomo del kernel solo clica rodando: la cuenta no sonaba. Y el arranque
 * llegaba cuando despertaba el temporizador, no en el beat.
 *
 * Devuelve el beat de entrada JUSTO cuando se cierra la cuenta (medido con el
 * reloj de audio), que es cuando quien llama tiene que abrir el micro.
 */

async function waitCountIn(bars: number, beatsPerBar: number, target: number): Promise<number | null> {
  await engine.init();
  useUiStore.setState({ positionBeats: target });
  engine.seek(target);
  const beats = bars * beatsPerBar;
  useRecorderStore.setState({ phase: 'countin', countdown: beats, error: null });
  /*
   * La espera se mide con el RELOJ DE AUDIO, que es el mismo con el que el
   * kernel enciende el transporte al cerrar la cuenta. Esperar en cambio a
   * que un frame de medidores diga `playing` mete hasta 46 ms entre el
   * downbeat y el `recorder.start()` de quien llama: la toma entera corrida
   * respecto del beat donde luego se coloca su clip.
   */
  const ctx = engine.audioContext;
  const t0 = ctx?.currentTime ?? 0;
  engine.countIn(beats, beatsPerBar, target);
  const countSec = (beats * 60) / Math.max(1, store.project.tempo);
  // Red de seguridad por si el audio no llegara a sonar (worklet caído,
  // contexto suspendido): sin esto la espera se queda con el micro abierto.
  const deadline = performance.now() + countSec * 1000 + 1500;
  /** ¿Hemos llegado a ver la cuenta viva? (antes del primer frame, no). */
  let sawCount = false;
  while (!cancelCountIn) {
    const left = ctx ? t0 + countSec - ctx.currentTime : Infinity;
    if (left <= 0) break;
    if (useUiStore.getState().playing) break;
    if (performance.now() > deadline) {
      engine.cancelCountIn();
      await play();
      break;
    }
    const beatsLeft = engine.lastMeters?.countInBeatsLeft ?? 0;
    // La cuenta estaba viva y ha desaparecido sin encender el transporte:
    // alguien dio a Stop por otro lado (el kernel cancela la cuenta con el
    // stop). Sin esto la espera seguía hasta el plazo y arrancaba sola.
    if (sawCount && beatsLeft === 0) {
      cancelCountIn = true;
      break;
    }
    if (beatsLeft > 0) sawCount = true;
    if (beatsLeft !== useRecorderStore.getState().countdown) {
      useRecorderStore.setState({ countdown: beatsLeft });
    }
    // Fino en el último tramo: el corte tiene que caer EN el downbeat.
    await new Promise((r) => setTimeout(r, left > 0.05 ? 20 : 2));
  }

  useRecorderStore.setState({ countdown: 0 });
  if (cancelCountIn) {
    cancelCountIn = false;
    engine.cancelCountIn();
    useRecorderStore.setState({ phase: 'idle' });
    return null;
  }
  return target;
}

/**
 * Cuenta atrás antes de grabar: el transporte arranca un par de compases

 * antes con el metrónomo puesto y la toma empieza EXACTA en el beat donde
 * estaba el caret, que es donde el usuario quería empezar a cantar.
 */
async function runCountIn(bars: number, target: number): Promise<number | null> {
  const beatsPerBar = Math.max(1, store.project.timeSig.num);
  const from = Math.max(0, target - bars * beatsPerBar);
  const wasMetronome = useUiStore.getState().metronome;
  cancelCountIn = false;

  // Grabando desde el compás 1 no hay sitio ANTES para el pre-roll: `from` se
  // recorta a 0, que ya es `target`, y la condición de salida del bucle se
  // cumplía en la primera vuelta — la cuenta atrás no contaba nada y la
  // grabación entraba al instante. Y es el caso más normal de todos: arrancar
  // la app, o darle a Stop, deja el caret justo ahí. Sin sitio por delante, la
  // cuenta se hace con el transporte PARADO y el metrónomo puesto.
  if (target - from <= 1e-6) {
    return waitCountIn(bars, beatsPerBar, target);
  }

  useUiStore.setState({ metronome: true, positionBeats: from });
  engine.setMetronome(true);
  engine.seek(from);
  useRecorderStore.setState({ phase: 'countin', countdown: bars * beatsPerBar, error: null });

  await play();

  while (!cancelCountIn) {
    // Si el transporte se para por otro lado (Space, Stop) durante la cuenta,
    // currentBeat() se congela y este bucle sondearía cada 25 ms para siempre,
    // dejando la fase en 'countin' con el micro abierto. Se aborta.
    if (!useUiStore.getState().playing) {
      cancelCountIn = true;
      break;
    }
    const beat = currentBeat();
    if (beat >= target - 1e-3) break;
    // La cuenta se enseña en BEATS (4·3·2·1), igual que la del kernel. Tope
    // arriba: el primer frame de medidores puede llegar con la posición vieja
    // y la cuenta arrancaría con un beat de más.
    const left = Math.min(bars * beatsPerBar, Math.max(1, Math.ceil(target - beat)));

    if (left !== useRecorderStore.getState().countdown) {
      useRecorderStore.setState({ countdown: left });
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  if (!wasMetronome) {
    useUiStore.setState({ metronome: false });
    engine.setMetronome(false);
  }
  useRecorderStore.setState({ countdown: 0 });
  if (cancelCountIn) {
    cancelCountIn = false;
    stopPlayback();
    useRecorderStore.setState({ phase: 'idle' });
    return null;
  }
  // El transporte viene rodando desde la cuenta: aquí es donde está de verdad.
  return currentBeat();
}

async function startRecording(): Promise<void> {
  if (!window.orbit) {
    useRecorderStore.setState({ error: 'Grabar requiere la app de escritorio' });
    return;
  }
  // `toggleRecording` decide por `phase`, pero `phase` no pasa a 'recording'
  // hasta DESPUÉS de pedir el micro: dos clics rápidos en Rec entraban los dos.
  // El segundo pisaba `media`, la referencia al primer stream se perdía y sus
  // tracks no los paraba nadie —el micro se quedaba abierto hasta cerrar la
  // app— mientras los dos MediaRecorder empujaban al mismo array de trozos.
  if (starting) return;
  // La calibración de latencia se queda con los paquetes de entrada en
  // crudo (ver `rawInputSink`): grabar mientras corre le robaría la toma
  // entera y las tomas saldrían vacías.
  if (useLatencyCalibrationStore.getState().status === 'measuring') {
    useRecorderStore.setState({ error: 'Calibrando la latencia de entrada: espera a que termine.' });
    return;
  }
  starting = true;
  try {
    ensureAudioReady();
    await engine.init();
    // Si el monitor ya tiene el micro abierto, se graba de ESE: abrir un
    // segundo getUserMedia sobre el mismo aparato es pedirle al sistema dos
    // capturas del mismo micro, y en Windows eso va de resamplear por su
    // cuenta a directamente fallar.
    ownsInput = currentInputStream() === null;
    if (ownsInput && !(await startInputMonitor())) {
      throw new Error(useInputMonitorStore.getState().error ?? 'No se pudo abrir el micro');
    }
    /*
     * Qué se graba: las entradas ARMADAS del proyecto, resueltas contra el
     * aparato que acaba de abrirse. Sin enrutado declarado sale una sola —la
     * implícita, el par 1-2— y todo lo de abajo se comporta exactamente como
     * cuando esto solo sabía grabar un micro.
     *
     * Las rutas que apuntan a canales que este aparato no tiene se quedan
     * fuera (`armedInputRoutes`): armar una entrada que no existe no puede
     * dejar la grabación esperando una toma que no va a llegar nunca.
     */
    const armed = armedInputRoutes(currentInputRoutes());
    if (armed.length === 0) {
      throw new Error(
        'Ninguna entrada armada con canales disponibles: revisa Ajustes → Entradas.',
      );
    }
    takes = armed.map(({ index, route }) => ({ index, route, left: [], right: [], total: 0 }));
    primaryRoute = takes[0]!.index;
    // Rodando, la posición buena es la extrapolada: la del store viene del
    // último frame de medidores y puede ir hasta 46 ms por detrás.
    startBeat = useUiStore.getState().playing
      ? currentBeat()
      : useUiStore.getState().positionBeats;

    const bars = useRecorderStore.getState().countInBars;
    if (bars > 0 && !useUiStore.getState().playing) {
      const at = await runCountIn(bars, startBeat);
      if (at === null) {
        releaseInput();
        return;
      }
      // Dónde entra la toma lo dice la cuenta atrás, no `currentBeat()`: ese
      // sale del último frame de medidores y puede ir por detrás del seek, que
      // colocaría el clip en el beat equivocado.
      startBeat = at;
      beginCapture();
      return;
    }

    beginCapture();
    // Con el transporte parado, arranca para grabar encima del beat.
    if (!useUiStore.getState().playing) void togglePlay();
  } catch (err) {
    releaseInput();
    useRecorderStore.setState({
      phase: 'idle',
      error: err instanceof Error ? err.message : 'No se pudo abrir el micro',
    });
  } finally {
    starting = false;
  }
}

/** Le dice al kernel que empiece a mandar la entrada en crudo. */
function beginCapture(): void {
  capturing = true;
  // El gancho se engancha AQUÍ y no al cargar el módulo: `engine` viene de
  // `./app`, que a su vez importa esto, y tocarlo mientras se evalúa el módulo
  // es tocarlo a medio construir.
  engine.onInputCaptures = handleInputCaptures;
  engine.setInputCapture(true, takes.map((t) => t.index));
  useRecorderStore.setState({ phase: 'recording', error: null });
}

/** Deja de capturar y cierra el micro SI era nuestro. */
function releaseInput(): void {
  capturing = false;
  takes = [];
  engine.setInputCapture(false);
  if (ownsInput) stopInputMonitor();
  ownsInput = false;
}

/**
 * Dónde cae la toma de una ruta y en qué carril.
 *
 * Es la regla de comping de siempre —la toma nueva se apila encima de la
 * anterior y calla a las que pisa, porque la buena es la última— con dos
 * añadidos que vienen del enrutado:
 *
 * - Una ruta puede DECLARAR su pista (`playlistTrackId`): entonces manda ella,
 *   que es la gracia de "el micro de la voz siempre a la pista de la voz".
 * - `claimed` son las pistas que ya se ha llevado otra toma de ESTA misma
 *   grabación: sin eso, dos micros a la vez caerían los dos en la primera
 *   pista libre, uno encima del otro.
 */
function placeTake(
  project: Project,
  take: TakeBuffer,
  placedStart: number,
  lengthBeats: number,
  claimed: Set<Id>,
  commands: Command[],
): Id {
  const arrangementId = project.activeArrangementId;
  const clips = Object.values(project.clips);
  const overlaps = (c: Clip) =>
    c.start < placedStart + lengthBeats && c.start + c.length > placedStart;
  const routeKey = take.route.routeId ?? '';

  const declared = take.route.playlistTrackId
    ? project.playlistTracks[take.route.playlistTrackId]
    : undefined;
  const previousId = declared ? declared.id : lastTakeTrackByRoute.get(routeKey);
  const previous = previousId ? project.playlistTracks[previousId] : undefined;
  const previousTakes =
    previous && previous.arrangementId === arrangementId
      ? clips.filter((c) => c.playlistTrackId === previous.id && overlaps(c))
      : [];

  // Sobre la pista declarada se apila SIEMPRE, aunque esté vacía: es la pista
  // que el usuario eligió para esa entrada, no una sugerencia.
  if (previous && previous.arrangementId === arrangementId && (declared || previousTakes.length > 0)) {
    if (previousTakes.length > 0) {
      commands.push({
        type: 'patchClips',
        patches: previousTakes.filter((c) => !c.muted).map((c) => ({ id: c.id, muted: true })),
      });
    }
    take.lane =
      previousTakes.length > 0 ? Math.max(...previousTakes.map((c) => c.lane ?? 0)) + 1 : 0;
    claimed.add(previous.id);
    lastTakeTrackByRoute.set(routeKey, previous.id);
    return previous.id;
  }

  const tracks = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === arrangementId)
    .sort((a, b) => a.order - b.order);
  const free = tracks.find(
    (t) => !claimed.has(t.id) && !clips.some((c) => c.playlistTrackId === t.id && overlaps(c)),
  );
  take.lane = 0;
  if (free) {
    claimed.add(free.id);
    lastTakeTrackByRoute.set(routeKey, free.id);
    return free.id;
  }
  const track = createPlaylistTrack(arrangementId, tracks.length + claimed.size);
  // Con enrutado declarado la pista nace con el nombre de la entrada: abrir el
  // proyecto mañana y ver "Voz" y "Guitarra" en vez de dos "Grabaciones".
  track.name = take.route.routeId ? take.route.name : 'Grabaciones';
  commands.push({ type: 'addPlaylistTrack', track });
  claimed.add(track.id);
  lastTakeTrackByRoute.set(routeKey, track.id);
  return track.id;
}

async function stopRecording(): Promise<void> {
  if (!capturing) return;
  useRecorderStore.setState({ phase: 'saving' });

  /*
   * El kernel acumula la entrada y la entrega en el SIGUIENTE frame de
   * medidores (~43 ms). Cortar la captura aquí mismo tiraría ese último trozo:
   * el final de cada toma se perdería. Se le da un par de frames de margen —
   * lo que entra de más es cola de sala, que no molesta a nadie.
   */
  await new Promise((r) => setTimeout(r, 120));
  capturing = false;
  engine.setInputCapture(false);

  const sampleRate = engine.sampleRate;
  const recorded = takes.map((take) => ({
    take,
    left: concatChunks(take.left, take.total),
    right: concatChunks(take.right, take.total),
  })).filter((t) => t.left.length > 0);
  takes = [];
  if (ownsInput) stopInputMonitor();
  ownsInput = false;

  /**
   * Las tomas de esta vuelta, sujetas desde que suben al motor hasta DESPUÉS
   * del dispatch — y TODAS a la vez, no la que se está guardando.
   *
   * El bucle de abajo sube cada toma al kernel y acumula sus comandos, pero no
   * despacha hasta el final: entre el `loadSample` de la primera y ese dispatch
   * no hay NADA que nombre su id —ni el proyecto, ni un clip, ni un canal—, así
   * que `sampleKeepSet` no la incluye y un `collectSessionSamples()` que caiga
   * ahí le dice al motor que la suelte. Y la ventana es larga de verdad: por
   * cada toma que queda hay un `recording.save` (escritura de un WAV de varios
   * megas al disco) y un `sha1Hex` de ese mismo WAV. Con dos micros armados son
   * cientos de milisegundos en los que el audio RECIÉN CANTADO por el usuario
   * no lo sujeta nadie, y el Ctrl+Z de `useShortcuts` recolecta sin preguntar.
   *
   * **Por qué se sostienen todas hasta el dispatch final y no se despacha por
   * toma.** Despachar por toma acortaría cada sujeción, pero no la quitaría —la
   * toma en curso seguiría teniendo su propia ventana entre subir y registrar—,
   * así que no ahorra este código: solo lo cobra en otro sitio. Y lo que cobra
   * es caro y no es de implementación:
   *
   *  - **Cambia el historial.** Hoy una vuelta de grabación es UN paso de undo
   *    a propósito (ver el comentario del dispatch): las tomas de dos micros se
   *    grabaron juntas y deshacerlas de una en una deja media grabación puesta
   *    —una voz sin su guitarra— sin que la playlist diga cuál falta.
   *  - **Cambia dónde caen las tomas.** `placeTake` decide contra `project`,
   *    leído UNA vez antes del bucle, y lleva estado entre tomas (`claimed`,
   *    `lastTakeTrackByRoute`, los `addPlaylistTrack` que empuja al mismo
   *    array). Despachar a mitad haría que la toma 2 viera el clip de la toma 1
   *    como un clip ya existente de esa pista, o sea como una toma ANTERIOR: se
   *    la mutearía y se la mandaría un carril abajo. Es un cambio de
   *    comportamiento, no un reordenado.
   *  - **Rompe el todo-o-nada.** El `batch` de core hace rollback entero; en
   *    trozos, un fallo a mitad deja registradas unas tomas y otras no.
   *
   * El coste de sostenerlas todas es un `Set` con N ids durante esos
   * milisegundos: el pin no retiene audio, solo impide soltarlo.
   *
   * La baja va en el `finally` de abajo, que cubre también el camino de error
   * (un `recording.save` que revienta con dos tomas ya subidas) — un pin que se
   * queda puesto es la misma fuga del otro lado.
   */
  const pinnedTakes: string[] = [];

  try {
    const api = window.orbit;
    if (!api) throw new Error('Sin puente de escritorio');
    if (recorded.length === 0) throw new Error('La toma salió vacía');

    const project = store.project;
    // El clip nace corrido hacia atrás lo que tarda el bucle salida→entrada
    // de ESTE aparato (calibrado en `latency-calibration.ts`): sin esto, cada
    // toma cae unos milisegundos tarde respecto de lo que el usuario oyó
    // cantar, y hoy eso se corregía a ojo arrastrando el clip en la playlist.
    // Sin calibrar (0 muestras) esto no mueve nada — mismo comportamiento de
    // siempre. La cuenta en sí vive en `input-latency.ts` (pura, testeada).
    //
    // Es el MISMO desplazamiento para todas las tomas de la vuelta: entraron
    // por el mismo aparato y por el mismo bloque de audio, así que corregirlas
    // por separado sería inventarse diferencias que no existen.
    const placedStart = compensateClipStart(
      startBeat,
      getLatencyCompensationSamples(),
      sampleRate,
      project.tempo,
    );

    const stamp = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const clock = `${two(stamp.getHours())}.${two(stamp.getMinutes())}.${two(stamp.getSeconds())}`;

    const commands: Command[] = [];
    const claimed = new Set<Id>();
    const names: string[] = [];

    for (const { take, left, right } of recorded) {
      // En crudo y directo a WAV de 24 bits: ningún códec de por medio.
      const wav = encodeWav(left, right, sampleRate, 24);
      const duration = left.length / sampleRate;
      const lengthBeats = Math.max(0.25, (duration * project.tempo) / 60);

      // El nombre lleva la entrada cuando hay más de una: dos tomas del mismo
      // segundo comparten archivo si no, y la segunda pisa a la primera.
      const name =
        recorded.length > 1 ? `Toma ${clock} ${take.route.name}.wav` : `Toma ${clock}.wav`;
      const file = await api.recording.save(name, wav);

      const sampleId = newId();
      // Sujeta ANTES de subir y hasta el `finally` de esta función: ver el
      // bloque de `pinnedTakes` arriba.
      pinSample(sampleId);
      pinnedTakes.push(sampleId);
      const wavBuf = wav.buffer.slice(
        wav.byteOffset,
        wav.byteOffset + wav.byteLength,
      ) as ArrayBuffer;
      await engine.loadSample(sampleId, wavBuf);

      const sample: SampleRef = {
        id: sampleId,
        name: file.replace(/\.wav$/i, ''),
        path: `recording:${file}`,
        hash: (await sha1Hex(wavBuf)) ?? sampleId,
        duration,
      };
      commands.push({ type: 'registerSample', sample });
      names.push(sample.name);

      const trackId = placeTake(project, take, placedStart, lengthBeats, claimed, commands);
      const lane = take.lane ?? 0;
      const clip: Clip = {
        id: newId(),
        kind: 'audio',
        playlistTrackId: trackId,
        start: placedStart,
        length: lengthBeats,
        muted: false,
        sampleId,
        audioOffset: 0,
        audioGain: 1,
        ...(lane > 0 ? { lane } : null),
      };
      commands.push({ type: 'addClips', clips: [clip] });
    }

    // Todas las tomas de la vuelta en UN paso de undo: se grabaron juntas y
    // deshacerlas de una en una dejaría media grabación puesta.
    const label =
      names.length === 1 ? `Grabar "${names[0]}"` : `Grabar ${names.length} entradas`;
    store.dispatch({ type: 'batch', label, commands }, { label });
    useRecorderStore.setState({ phase: 'idle', error: null });
  } catch (err) {
    useRecorderStore.setState({
      phase: 'idle',
      error: err instanceof Error ? err.message : 'No se pudo guardar la toma',
    });
  } finally {
    // La baja de TODAS, y estructural: llegue el dispatch o reviente el guardado
    // con dos tomas ya subidas, aquí no queda ningún id sujeto.
    for (const id of pinnedTakes) unpinSample(id);
  }
}

/**
 * Para la grabación por una causa AJENA a quien graba: el micro desapareció a
 * mitad de la toma (hot-unplug, o el dispositivo activo dejó de estar
 * disponible tras un cambio de dispositivo del sistema — ver
 * `input-monitor.ts:handleStreamLost`, quien es el único que llama a esto).
 * Eso no se puede bloquear —el cable ya se fue—, así que se guarda lo que se
 * alcanzó a capturar, igual que cualquier `stopRecording` normal, y se
 * sobreescribe el motivo con uno que dice CLARO que la toma se cortó ahí, para
 * que quien cantó sepa que tiene que repetirla en vez de descubrirlo al
 * escuchar un clip corto sin ninguna pista de por qué.
 */
export async function abortRecordingForLostDevice(reason: string): Promise<void> {
  if (!capturing) return;
  await stopRecording();
  useRecorderStore.setState({ error: reason });
}

// Gancho de QA solo-dev: inyectar una fuente sintética en vez del micro real.
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__orbitSetRecStream'] = setRecorderStreamFactory;
}
