/**
 * Grabar la salida de una pista del mixer.
 *
 * A diferencia de consolidar (que es un render offline de unos clips), esto
 * captura lo que SUENA: el kernel copia la salida post-fader de la pista y la
 * manda en cada frame de medidores. Sirve para quedarse con una pasada
 * concreta —con las perillas que moviste en ese momento— y para bajar la voz
 * ya procesada por su cadena.
 *
 * Al parar, la toma se escribe como WAV en userData/recordings (esquema
 * `recording:`, rehidratado solo al reabrir) y cae como clip de audio en el
 * beat donde empezó, igual que la grabación de micro.
 */

import { encodeWav } from '@orbit/engine';
import { createPlaylistTrack, newId, type Clip, type Command, type SampleRef } from '@orbit/core';
import { create } from 'zustand';
import { sha1Hex } from '../browser/sound-actions';
// Ciclo a propósito con master-stream: los dos se pelean por el ÚNICO tap del
// kernel y cada uno tiene que poder preguntar por el otro. Ninguno de los dos
// toca el store del otro fuera de una función, así que el ciclo no muerde.
import { useMasterStream } from '../collab/master-stream';
import { currentBeat, engine, store, togglePlay } from './app';
import { collectWorkletSamples, noteRecordingWritten, withPinnedSample } from './sample-gc';
import { useUiStore } from './ui';

interface TrackCaptureState {
  /** Pista que se está grabando, o null. */
  trackIndex: number | null;
  /** Segundos capturados (para el rótulo del botón). */
  seconds: number;
  error: string | null;
  /** Resultado de una toma no insertada; independiente de una captura nueva. */
  recoveryNotice: string | null;
}

export const useTrackCapture = create<TrackCaptureState>(() => ({
  trackIndex: null,
  seconds: 0,
  error: null,
  recoveryNotice: null,
}));

let chunksL: Float32Array[] = [];
let chunksR: Float32Array[] = [];
let total = 0;
let startBeat = 0;
let sampleRate = 48000;

interface CaptureContext {
  epoch: number;
  projectId: string;
  projectTitle: string;
  arrangementId: string;
  trackName: string;
  tempo: number;
  startBeat: number;
  sampleRate: number;
  request: number;
}

let activeCapture: CaptureContext | null = null;
let unsubscribeCapture: (() => void) | null = null;
let captureRequest = 0;
let startRequest = 0;

function captureContext(trackIndex: number): CaptureContext {
  const project = store.project;
  return {
    epoch: store.historyEpoch,
    projectId: project.id,
    projectTitle: project.meta.title,
    arrangementId: project.activeArrangementId,
    trackName: project.mixer[trackIndex]?.name ?? `Insert ${trackIndex}`,
    tempo: project.tempo,
    startBeat,
    sampleRate,
    request: ++captureRequest,
  };
}

export function dismissCaptureRecovery(): void {
  useTrackCapture.setState({ recoveryNotice: null });
}

/** Trozo de audio de un frame del kernel (lo llama el puente de medidores). */
export function pushCaptureChunk(left: Float32Array, right: Float32Array): void {
  if (useTrackCapture.getState().trackIndex === null) return;
  chunksL.push(left);
  chunksR.push(right);
  total += left.length;
  const seconds = total / sampleRate;
  // El rótulo solo necesita décimas: evita re-renderizar 20 veces por segundo.
  if (Math.abs(seconds - useTrackCapture.getState().seconds) >= 0.1) {
    useTrackCapture.setState({ seconds });
  }
}

export async function toggleTrackCapture(trackIndex: number): Promise<void> {
  const request = ++startRequest;
  const epoch = store.historyEpoch;
  const isCurrent = () => request === startRequest && epoch === store.historyEpoch;
  const current = useTrackCapture.getState().trackIndex;
  if (current === trackIndex) return stopTrackCapture();
  if (current !== null) await stopTrackCapture();
  if (!isCurrent()) return;
  // El AudioContext puede no existir todavía (esta puede ser la primera acción
  // de audio de la sesión). `engine.sampleRate` devolvería 44100 por defecto y
  // la toma se escribiría declarando 44.1 kHz cuando el motor va a 48: un 8,8 %
  // más lenta, casi un tono por debajo, y con la duración mal.
  try {
    await engine.init();
    if (isCurrent()) startTrackCapture(trackIndex);
  } catch (err) {
    if (isCurrent()) useTrackCapture.setState({ error: err instanceof Error ? err.message : 'No se pudo iniciar la captura' });
  }
}

function startTrackCapture(trackIndex: number): void {
  if (!window.orbit) {
    useTrackCapture.setState({ error: 'Grabar pistas requiere la app de escritorio' });
    return;
  }
  // El kernel solo tiene UN tap. El emisor del master ya se niega si hay una
  // grabación en marcha; sin el espejo, grabar una pista mientras emites hacía
  // dos cosas malas seguidas: la sala pasaba a oír ESA pista como si fuera tu
  // master, y al parar la grabación la emisión se quedaba muda con el botón
  // diciendo que seguía emitiendo.
  if (useMasterStream.getState().broadcasting) {
    useTrackCapture.setState({
      error: 'Estás emitiendo tu master a la sala: el kernel solo puede tapar una pista.',
    });
    return;
  }
  chunksL = [];
  chunksR = [];
  total = 0;
  sampleRate = engine.sampleRate;
  startBeat = currentBeat();
  activeCapture = captureContext(trackIndex);
  // Finalizar es síncrono hasta haber separado los buffers y apagado el tap.
  // El guardado continuará con el contexto de A aunque ya se haya abierto B.
  unsubscribeCapture = store.subscribeBeforeReplace(() => { void stopTrackCapture(); });
  useTrackCapture.setState({ trackIndex, seconds: 0, error: null });
  engine.setTrackCapture(trackIndex, true);
  // Parado no hay nada que capturar: arranca el transporte, como el rec de micro.
  if (!useUiStore.getState().playing) void togglePlay();
}

export async function stopTrackCapture(): Promise<void> {
  const { trackIndex } = useTrackCapture.getState();
  if (trackIndex === null) return;
  const context = activeCapture ?? captureContext(trackIndex);
  activeCapture = null;
  unsubscribeCapture?.();
  unsubscribeCapture = null;
  const isCurrent = () => context.epoch === store.historyEpoch && context.projectId === store.project.id;
  const ownsStatus = () => context.request === captureRequest;
  const { sampleRate: capturedRate, startBeat: capturedStart, trackName } = context;
  engine.setTrackCapture(trackIndex, false);
  useTrackCapture.setState({ trackIndex: null, seconds: 0 });

  const left = concat(chunksL, total);
  const right = concat(chunksR, total);
  chunksL = [];
  chunksR = [];
  const captured = total;
  total = 0;
  if (captured < capturedRate * 0.1) {
    if (ownsStatus()) useTrackCapture.setState({ error: 'La toma salió demasiado corta' });
    return;
  }

  let savedFile: string | null = null;
  let uploadStarted = false;
  let inserted = false;
  const preserveTake = (reason: string) => {
    useTrackCapture.setState({
      recoveryNotice: `La toma de «${context.projectTitle}» se conservó como «${savedFile}». ${reason} ` +
        'La ruta de datos está en Ayuda → Acerca de. En esa ruta, abre recordings; puedes arrastrar ese WAV al proyecto.',
    });
  };
  try {
    const api = window.orbit;
    if (!api) throw new Error('Sin puente de escritorio');
    const wav = encodeWav(left, right, capturedRate, 24);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;

    // Nombre por CONTENIDO, como el de las ediciones del editor
    // (`editFileName`) y lo importado (`storedNameFor`). Aquí el borrado
    // silencioso era el peor de los tres escritores: `recording:save` pisa por
    // nombre y `Pista <nombre>.wav` colisionaba SIEMPRE —la segunda captura de
    // la misma pista se llevaba por delante el audio de la primera, una pasada
    // EN VIVO que no se puede volver a tocar— y ni siquiera hacían falta dos
    // relojes iguales. Con el sha1 del wav en el nombre, «mismo nombre»
    // significa «mismo contenido»: pisar es escribir lo mismo encima. El hash
    // va ANTES del save porque el nombre sale de él. Aunque la sesión termine
    // durante el hash, se guarda la pasada irrepetible; solo se cancela su
    // inserción, no la conservación del audio que ya se tocó.
    const sampleId = newId();
    const hash = (await sha1Hex(buffer)) ?? sampleId;
    const file = await api.recording.save(`Pista ${trackName} ${hash}.wav`, wav);
    savedFile = file;
    const path = `recording:${file}`;
    if (!isCurrent()) {
      preserveTake('No se insertó porque cambiaste de proyecto.');
      return;
    }

    // Sujeto desde antes de subirlo y hasta DESPUÉS del dispatch, como en el
    // editor de audio y por lo mismo (`state/sample-gc.ts`): entre `loadSample`
    // y `registerSample` ese id no lo nombra nada del modelo, y el
    // `decodeAudioData` que hay en medio es justo por donde entra el
    // `collectSessionSamples()` del Ctrl+Z. Aquí, además, lo que se perdería es
    // una PASADA EN VIVO —con las perillas que se movieron en ese momento— que
    // no se puede volver a renderizar: repetirla es volver a tocarla.
    await withPinnedSample(sampleId, async () => {
      uploadStarted = true;
      await engine.loadSample(sampleId, buffer);
      if (!isCurrent()) {
        preserveTake('No se insertó porque cambiaste de proyecto.');
        return;
      }
      const project = store.project;
      if (!project.arrangements[context.arrangementId]) {
        preserveTake('No se insertó porque el arreglo de origen ya no existe.');
        return;
      }

      const duration = captured / capturedRate;
      const lengthBeats = Math.max(0.25, (duration * context.tempo) / 60);
      const sample: SampleRef = {
        id: sampleId,
        // El NOMBRE es el humano, no el del archivo: el auto-mapa de notas lee
        // los nombres y un hash hexadecimal es puro falso positivo.
        name: `Pista ${trackName}`,
        path,
        hash,
        duration,
      };

      // Pista de playlist libre en ese tramo (si no, una nueva "Grabaciones").
      const tracks = Object.values(project.playlistTracks)
        .filter((t) => t.arrangementId === context.arrangementId)
        .sort((a, b) => a.order - b.order);
      const clips = Object.values(project.clips);
      const free = tracks.find(
        (t) =>
          !clips.some(
            (c) =>
              c.playlistTrackId === t.id &&
              c.start < capturedStart + lengthBeats &&
              c.start + c.length > capturedStart,
          ),
      );
      const commands: Command[] = [{ type: 'registerSample', sample }];
      let playlistTrackId: string;
      if (free) {
        playlistTrackId = free.id;
      } else {
        const track = createPlaylistTrack(context.arrangementId, tracks.length, 'Grabaciones');
        commands.push({ type: 'addPlaylistTrack', track });
        playlistTrackId = track.id;
      }

      const clip: Clip = {
        id: newId(),
        kind: 'audio',
        playlistTrackId,
        start: capturedStart,
        length: lengthBeats,
        muted: false,
        sampleId,
        audioOffset: 0,
        audioGain: 1,
      };
      commands.push({ type: 'addClips', clips: [clip] });

      const label = `Grabar la salida de "${trackName}"`;
      store.dispatch({ type: 'batch', label, commands }, { label });
      inserted = true;
      // Una toma conservada para recuperación queda FUERA del ledger de otra
      // sesión y no puede reclamarse como un archivo huérfano de B. La toma
      // insertada sí participa en la política normal de undo/GC.
      noteRecordingWritten({ sampleId, path, bytes: wav.byteLength });
      if (ownsStatus()) useTrackCapture.setState({ error: null });
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'No se pudo guardar la toma';
    if (savedFile) preserveTake('No se pudo insertar en el proyecto.');
    else useTrackCapture.setState({
      // El cambio de sesión retira el permiso para insertar en B, no el deber
      // de avisar de una pasada perdida de A. No se promete un archivo cuya
      // escritura nunca llegó a confirmarse, ni se pisa el error de B.
      recoveryNotice: `No se pudo guardar la toma de «${context.projectTitle}»: ${error}. No se confirmó ningún WAV recuperable.`,
    });
    if (isCurrent() && ownsStatus()) useTrackCapture.setState({
      error,
    });
  } finally {
    // withPinnedSample ya soltó la sujeción. Un decode que terminó después de
    // cambiar de proyecto no debe dejar audio sin lector en el motor de B.
    if (uploadStarted && !inserted) collectWorkletSamples(engine, store.project);
  }
}

// Gancho de QA solo-dev: inspeccionar/controlar la captura desde CDP sin
// importar el módulo (un import por /@fs crea OTRA instancia y engaña).
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w['__orbitTrackCapture'] = { useTrackCapture, toggleTrackCapture, stopTrackCapture };
}

function concat(chunks: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
