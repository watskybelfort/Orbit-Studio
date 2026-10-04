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
  beatsInBar,
  meterBeatUnit,
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
import { currentBeat, engine, ensureAudioReady, play, stopPlayback, store } from './app';
import {
  currentInputRoutes,
  currentInputStream,
  inputMonitorGeneration,
  isInputMonitorOpening,
  setInputStreamFactory,
  startInputMonitor,
  stopInputMonitor,
  useInputMonitorStore,
} from './input-monitor';
import { getLatencyCompensationSamples, useLatencyCalibrationStore } from './latency-calibration';
import { compensateClipStart } from './input-latency';
import { collectWorkletSamples, noteRecordingWritten, withPinnedSamples } from './sample-gc';
import { useUiStore } from './ui';

export type RecorderPhase = 'idle' | 'countin' | 'recording' | 'saving';

interface RecorderState {
  phase: RecorderPhase;
  error: string | null;
  /** Compases de cuenta atrás antes de grabar (0 = sin cuenta). */
  countInBars: number;
  /** Beats que faltan durante la cuenta (para el rótulo del botón: 4·3·2·1). */
  countdown: number;
  /** Tomas no insertadas o guardados fallidos de una sesión anterior. */
  recoveryNotice: string | null;
}

export const useRecorderStore = create<RecorderState>(() => ({
  phase: 'idle',
  error: null,
  countInBars: 1,
  countdown: 0,
  recoveryNotice: null,
}));

export function dismissRecorderRecovery(): void {
  useRecorderStore.setState({ recoveryNotice: null });
}

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
/** Estamos recogiendo muestras del kernel. */
let capturing = false;

interface RecordingSession {
  epoch: number;
  projectId: string;
  title: string;
  arrangementId: string;
  tempo: number;
  rate: number;
  latency: number;
  start: number;
  /** El monitor ya abierto o pendiente se toma prestado: no se cierra. */
  ownsInput: boolean;
  inputGeneration: number;
  cancelled: boolean;
  metronome: boolean;
  unsubscribe: () => void;
  finishTail?: () => void;
  stopping?: Promise<void>;
}

let session: RecordingSession | null = null;
const sessionCurrent = (take: RecordingSession) => !take.cancelled &&
  take.epoch === store.historyEpoch && take.projectId === store.project.id;
const ownsRecorder = (take: RecordingSession) => session === take && sessionCurrent(take);

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

async function waitCountIn(bars: number, beatsPerBar: number, unit: number, target: number, take: RecordingSession): Promise<number | null> {
  await engine.init();
  if (!ownsRecorder(take)) return null;
  useUiStore.setState({ positionBeats: target });
  engine.seek(target);
  const beats = bars * beatsPerBar;
  useRecorderStore.setState({ phase: 'countin', countdown: beats / unit, error: null });
  /*
   * La espera se mide con el RELOJ DE AUDIO, que es el mismo con el que el
   * kernel enciende el transporte al cerrar la cuenta. Esperar en cambio a
   * que un frame de medidores diga `playing` mete hasta 46 ms entre el
   * downbeat y el `recorder.start()` de quien llama: la toma entera corrida
   * respecto del beat donde luego se coloca su clip.
   */
  const ctx = engine.audioContext;
  const t0 = ctx?.currentTime ?? 0;
  engine.countIn(beats, beatsPerBar, target, unit);
  const countSec = (beats * 60) / Math.max(1, take.tempo);
  // Red de seguridad por si el audio no llegara a sonar (worklet caído,
  // contexto suspendido): sin esto la espera se queda con el micro abierto.
  const deadline = performance.now() + countSec * 1000 + 1500;
  /** ¿Hemos llegado a ver la cuenta viva? (antes del primer frame, no). */
  let sawCount = false;
  while (!cancelCountIn && ownsRecorder(take)) {
    const left = ctx ? t0 + countSec - ctx.currentTime : Infinity;
    if (left <= 0) break;
    if (useUiStore.getState().playing) break;
    if (performance.now() > deadline) {
      engine.cancelCountIn();
      await play(() => ownsRecorder(take));
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

  if (!ownsRecorder(take)) return null;
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
async function runCountIn(bars: number, target: number, take: RecordingSession): Promise<number | null> {
  const beatsPerBar = beatsInBar(store.project.timeSig);
  const unit = meterBeatUnit(store.project.timeSig);
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
    return waitCountIn(bars, beatsPerBar, unit, target, take);
  }

  useUiStore.setState({ metronome: true, positionBeats: from });
  engine.setMetronome(true);
  engine.seek(from);
  useRecorderStore.setState({ phase: 'countin', countdown: bars * beatsPerBar / unit, error: null });

  await play(() => ownsRecorder(take));

  while (!cancelCountIn && ownsRecorder(take)) {
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
    const left = Math.min(bars * beatsPerBar / unit, Math.max(1, Math.ceil((target - beat) / unit)));

    if (left !== useRecorderStore.getState().countdown) {
      useRecorderStore.setState({ countdown: left });
    }
    await new Promise((r) => setTimeout(r, 25));
  }

  if (!ownsRecorder(take)) return null;
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
  const project = store.project;
  const take: RecordingSession = {
    epoch: store.historyEpoch, projectId: project.id, title: project.meta.title,
    arrangementId: project.activeArrangementId, tempo: project.tempo,
    rate: engine.sampleRate, latency: getLatencyCompensationSamples(), start: 0,
    ownsInput: false, inputGeneration: -1, cancelled: false,
    metronome: useUiStore.getState().metronome, unsubscribe: () => undefined,
  };
  session = take;
  const unsubscribe = store.subscribeBeforeReplace(() => {
    take.cancelled = true;
    take.unsubscribe();
    if (session !== take) return;
    if (useRecorderStore.getState().phase === 'countin') {
      cancelCountIn = true;
      engine.cancelCountIn();
      stopPlayback();
      useUiStore.setState({ metronome: take.metronome });
      engine.setMetronome(take.metronome);
    }
    // Cortar AHORA evita que los120ms de cola o el kernel de B entren en A.
    if (capturing || take.stopping) void stopRecording(take, true);
    else releaseInput(take);
    session = null;
    starting = false;
    lastTakeTrackByRoute.clear();
    useRecorderStore.setState({ phase: 'idle', countdown: 0, error: null });
  });
  take.unsubscribe = () => { unsubscribe(); take.unsubscribe = () => undefined; };
  try {
    await ensureAudioReady();
    if (!ownsRecorder(take)) return;
    // Si el monitor ya tiene el micro abierto, se graba de ESE: abrir un
    // segundo getUserMedia sobre el mismo aparato es pedirle al sistema dos
    // capturas del mismo micro, y en Windows eso va de resamplear por su
    // cuenta a directamente fallar.
    take.ownsInput = currentInputStream() === null && !isInputMonitorOpening();
    if (currentInputStream() === null) {
      const opening = startInputMonitor();
      take.inputGeneration = inputMonitorGeneration();
      const opened = await opening;
      if (!ownsRecorder(take)) return;
      if (!opened) throw new Error(useInputMonitorStore.getState().error ?? 'No se pudo abrir el micro');
    }
    take.rate = engine.sampleRate;
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
    const startBeat = useUiStore.getState().playing
      ? currentBeat()
      : useUiStore.getState().positionBeats;
    take.start = startBeat;

    const bars = useRecorderStore.getState().countInBars;
    if (bars > 0 && !useUiStore.getState().playing) {
      const at = await runCountIn(bars, startBeat, take);
      if (!ownsRecorder(take)) return;
      if (at === null) {
        releaseInput(take);
        take.unsubscribe();
        session = null;
        starting = false;
        return;
      }
      // Dónde entra la toma lo dice la cuenta atrás, no `currentBeat()`: ese
      // sale del último frame de medidores y puede ir por detrás del seek, que
      // colocaría el clip en el beat equivocado.
      take.start = at;
      beginCapture();
      return;
    }

    beginCapture();
    // Con el transporte parado, arranca para grabar encima del beat.
    if (!useUiStore.getState().playing) await play(() => ownsRecorder(take));
  } catch (err) {
    if (ownsRecorder(take)) {
      if (useRecorderStore.getState().phase === 'countin') {
        useUiStore.setState({ metronome: take.metronome });
        engine.setMetronome(take.metronome);
      }
      releaseInput(take);
      take.unsubscribe();
      session = null;
      starting = false;
      useRecorderStore.setState({
        phase: 'idle',
        error: err instanceof Error ? err.message : 'No se pudo abrir el micro',
      });
    }
  } finally {
    if (session === take) starting = false;
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
function releaseInput(take: RecordingSession): void {
  if (session !== take) return;
  capturing = false;
  takes = [];
  engine.setInputCapture(false);
  if (take.ownsInput && take.inputGeneration === inputMonitorGeneration()) stopInputMonitor();
  take.ownsInput = false;
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
  arrangementId = project.activeArrangementId,
): Id {
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

interface RecordedTake { take: TakeBuffer; left: Float32Array; right: Float32Array }

function stopRecording(take: RecordingSession | null = session, immediate = false): Promise<void> {
  if (!take) return Promise.resolve();
  if (take.stopping) {
    if (immediate) take.finishTail?.();
    return take.stopping;
  }
  if (!capturing || session !== take) return Promise.resolve();
  if (ownsRecorder(take)) useRecorderStore.setState({ phase: 'saving' });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let separated = false;
  const recorded = new Promise<RecordedTake[]>((resolve) => {
    take.finishTail = () => {
      if (separated) return;
      separated = true;
      clearTimeout(timer);
      const audio = takes.map((buffer) => ({
        take: buffer, left: concatChunks(buffer.left, buffer.total), right: concatChunks(buffer.right, buffer.total),
      })).filter((item) => item.left.length > 0);
      releaseInput(take);
      resolve(audio);
    };
  });
  take.stopping = (async () => {
    try {
      await saveRecordedTakes(take, await recorded);
    } finally {
      take.unsubscribe();
      if (ownsRecorder(take)) useRecorderStore.setState({ phase: 'idle' });
      if (session === take) session = null;
    }
  })();
  // Al parar normalmente se conserva la cola de los medidores (~43ms/frame).
  // Reemplazar proyecto corta antes: esa cola ya pertenecería a otra sesión.
  if (immediate) take.finishTail!();
  else timer = setTimeout(take.finishTail!, 120);
  return take.stopping;
}

async function saveRecordedTakes(context: RecordingSession, recorded: RecordedTake[]): Promise<void> {
  const sampleRate = context.rate;

  /** Todas las tomas permanecen sujetas hasta el único batch: mientras se
   * guarda/decodifica la segunda, la primera aún no tiene referencias en el
   * proyecto. Así Ctrl+Z no recolecta audio recién grabado. Se insertan juntas
   * para conservar un solo undo y decidir el comping sobre el mismo proyecto;
   * un fallo conserva los WAV completos sin dejar una grabación a medias.
   * withPinnedSamples libera también al cancelar o fallar. */
  const takeIds = recorded.map(() => newId());
  const written: { file: string; bytes: number; sample: SampleRef; take: TakeBuffer }[] = [];
  const failed: string[] = [];
  const unsaved: string[] = [];
  let operationError: string | null = null;
  let uploaded = false;
  let inserted = false;
  const report = (reason: string) => {
    useRecorderStore.setState({ recoveryNotice: [
      `Grabación de «${context.title}»: ${reason}.`,
      ...(written.length ? [
        `WAV conservados: ${written.map((item) => `«${item.file}»`).join(', ')}.`,
        'La ruta de datos está en Ayuda → Acerca de. En esa ruta, abre recordings; puedes arrastrar los WAV al proyecto.',
      ] : []),
      ...(unsaved.length ? [`No se confirmó ningún WAV recuperable para: ${unsaved.join(', ')}.`] : []),
      ...failed,
    ].join(' ') });
  };
  try {
    await withPinnedSamples(takeIds, async () => {
      try {
        const api = window.orbit;
        if (!api) throw new Error('Sin puente de escritorio');
        if (recorded.length === 0) throw new Error('La toma salió vacía');

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
          context.start,
          context.latency,
          sampleRate,
          context.tempo,
        );

        const stamp = new Date();
        const two = (n: number) => String(n).padStart(2, '0');
        const clock = `${two(stamp.getHours())}.${two(stamp.getMinutes())}.${two(stamp.getSeconds())}`;

        for (const [i, { take, left, right }] of recorded.entries()) {
          const human = recorded.length > 1 ? `Toma ${clock} ${take.route.name}` : `Toma ${clock}`;
          let file: string | null = null;
          try {
            // En crudo y directo a WAV de 24 bits: ningún códec de por medio.
            const wav = encodeWav(left, right, sampleRate, 24);
            const duration = left.length / sampleRate;
            const wavBuf = wav.buffer.slice(
              wav.byteOffset,
              wav.byteOffset + wav.byteLength,
            ) as ArrayBuffer;

            // Nombre por CONTENIDO (mismo criterio que `editFileName` del editor).
            // El reloj solo era único dentro de la MISMA vuelta: dos grabaciones a
            // la misma hora —o la otra ventana escribiendo— compartían nombre y
            // `recording:save` pisa, así que la toma nueva se llevaba por delante
            // la de antes con su audio ya irrepetible. La entrada sigue en el
            // nombre para leerse, pero la unicidad la pone el sha1.
            const sampleId = takeIds[i]!;
            const hash = (await sha1Hex(wavBuf)) ?? sampleId;
            // Aun tras abandonar A se conservan TODAS las entradas irrepetibles.
            // Una escritura fallida tampoco impide intentar guardar las restantes.
            file = await api.recording.save(`${human} ${hash}.wav`, wav);
            const sample: SampleRef = {
              id: sampleId,
              // El NOMBRE es el humano, no el del archivo: el auto-mapa de notas
              // lee los nombres y un hash hexadecimal es puro falso positivo.
              name: human,
              path: `recording:${file}`,
              hash,
              duration,
            };
            written.push({ file, sample, take, bytes: wav.byteLength });
            if (sessionCurrent(context) && failed.length === 0) {
              uploaded = true;
              await engine.loadSample(sampleId, wavBuf, () => sessionCurrent(context) && !!store.project.arrangements[context.arrangementId]);
            }
          } catch (err) {
            if (!file) unsaved.push(human);
            operationError = err instanceof Error ? err.message : 'No se pudo guardar o cargar la toma';
            failed.push(`${human}: ${operationError}`);
          }
        }

        if (!sessionCurrent(context)) {
          report('no se insertó porque cambiaste de proyecto');
          return;
        }
        const project = store.project;
        if (!project.arrangements[context.arrangementId]) {
          report('no se insertó porque el arreglo de origen ya no existe');
          return;
        }
        if (failed.length) {
          report('no se insertó la grabación completa');
          if (ownsRecorder(context)) useRecorderStore.setState({ error: operationError });
          return;
        }

        const commands: Command[] = [];
        const claimed = new Set<Id>();
        const names: string[] = [];
        for (const { sample, take } of written) {
          const sampleId = sample.id;
          const lengthBeats = Math.max(0.25, (sample.duration * context.tempo) / 60);
          commands.push({ type: 'registerSample', sample });
          names.push(sample.name);

          const trackId = placeTake(project, take, placedStart, lengthBeats, claimed, commands, context.arrangementId);
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
        inserted = true;
        // El ledger solo reclama tomas que sí pertenecieron a esta sesión. Los
        // WAV conservados para recuperación quedan fuera del GC del proyecto B.
        for (const { sample, bytes } of written) noteRecordingWritten({ sampleId: sample.id, path: sample.path, bytes });
        if (ownsRecorder(context)) useRecorderStore.setState({ error: null });
      } catch (err) {
        const error = err instanceof Error ? err.message : 'No se pudo guardar la toma';
        report(error);
        if (ownsRecorder(context)) useRecorderStore.setState({ error });
      }
    });
  } finally {
    if (uploaded && !inserted) collectWorkletSamples(engine, store.project);
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
 *
 * La CUENTA ATRÁS también es una toma en curso (el micro ya está abierto y la
 * captura entra al cerrar la cuenta): ahí no hay nada que guardar, así que se
 * cancela y se avisa — dejarla seguir arrancaba una toma sin stream.
 */
export async function abortRecordingForLostDevice(reason: string): Promise<void> {
  if (useRecorderStore.getState().phase === 'countin') {
    cancelCountIn = true;
    useRecorderStore.setState({ phase: 'idle', error: reason });
    return;
  }
  if (!capturing) return;
  const take = session;
  await stopRecording();
  if (take && sessionCurrent(take) && session === null) useRecorderStore.setState({ error: reason });
}

// Gancho de QA solo-dev: inyectar una fuente sintética en vez del micro real.
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__orbitSetRecStream'] = setRecorderStreamFactory;
}
