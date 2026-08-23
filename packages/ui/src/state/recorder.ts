/**
 * Grabación de micro a la playlist (el flujo de voz sobre beat de Orbit):
 * el botón de grabar toma el micro, graba mientras suena el transporte y al
 * parar decodifica la toma, la guarda como WAV en userData/recordings
 * (esquema `recording:` en SampleRef.path), la sube al kernel y coloca el
 * clip de audio en el beat donde empezó la grabación — todo en un undo.
 */

import {
  createPlaylistTrack,
  newId,
  type Clip,
  type Command,
  type SampleRef,
} from '@orbit/core';
import { encodeWav } from '@orbit/engine';
import { create } from 'zustand';
import { sha1Hex } from '../browser/sound-actions';
import { currentBeat, engine, ensureAudioReady, play, stopPlayback, store, togglePlay } from './app';
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

/** Pista donde cayó la última toma: la siguiente se apila ahí en otro carril. */
let lastTakeTrackId: string | null = null;
let media: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let startBeat = 0;

/** Fuente del micro; inyectable para QA (fuente sintética, sin micro real). */
let streamFactory: () => Promise<MediaStream> = () =>
  navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });

export function setRecorderStreamFactory(f: () => Promise<MediaStream>): void {
  streamFactory = f;
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
  starting = true;
  try {
    ensureAudioReady();
    media = await streamFactory();
    chunks = [];
    recorder = new MediaRecorder(media);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    startBeat = useUiStore.getState().positionBeats;

    const bars = useRecorderStore.getState().countInBars;
    if (bars > 0 && !useUiStore.getState().playing) {
      const at = await runCountIn(bars, startBeat);
      if (at === null) {
        media?.getTracks().forEach((t) => t.stop());
        media = null;
        recorder = null;
        return;
      }
      // Dónde entra la toma lo dice la cuenta atrás, no `currentBeat()`: ese
      // sale del último frame de medidores y puede ir por detrás del seek, que
      // colocaría el clip en el beat equivocado.
      startBeat = at;
      recorder.start();
      useRecorderStore.setState({ phase: 'recording', error: null });
      return;
    }

    recorder.start();
    useRecorderStore.setState({ phase: 'recording', error: null });
    // Con el transporte parado, arranca para grabar encima del beat.
    if (!useUiStore.getState().playing) void togglePlay();
  } catch (err) {
    media?.getTracks().forEach((t) => t.stop());
    media = null;
    recorder = null;
    useRecorderStore.setState({
      phase: 'idle',
      error: err instanceof Error ? err.message : 'No se pudo abrir el micro',
    });
  } finally {
    starting = false;
  }
}

async function stopRecording(): Promise<void> {
  const rec = recorder;
  const stream = media;
  recorder = null;
  media = null;
  if (!rec) return;
  useRecorderStore.setState({ phase: 'saving' });

  // El micro se cierra SÍ o SÍ (aquí abajo): si `rec.stop()` lanzaba (recorder
  // inactivo, micro desenchufado) o `onstop` no llegaba nunca, la promesa se
  // quedaba sin resolver → fase clavada en 'saving', botón Rec muerto y los
  // tracks del stream nunca se paraban (micro abierto hasta cerrar la app).
  let blob: Blob;
  try {
    blob = await new Promise<Blob>((resolve, reject) => {
      const type = rec.mimeType || 'audio/webm';
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve(new Blob(chunks, { type }));
      };
      rec.onstop = finish;
      rec.onerror = () => {
        if (!done) {
          done = true;
          reject(new Error('El micro falló durante la grabación'));
        }
      };
      // Red de seguridad: si onstop no dispara, se resuelve con lo grabado.
      setTimeout(finish, 4000);
      try {
        if (rec.state !== 'inactive') rec.stop();
        else finish();
      } catch {
        finish();
      }
    });
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    chunks = [];
    useRecorderStore.setState({
      phase: 'idle',
      error: err instanceof Error ? err.message : 'No se pudo cerrar la grabación',
    });
    return;
  }
  stream?.getTracks().forEach((t) => t.stop());
  chunks = [];

  try {
    const api = window.orbit;
    if (!api) throw new Error('Sin puente de escritorio');
    const raw = await blob.arrayBuffer();
    if (raw.byteLength === 0) throw new Error('La toma salió vacía');

    // Decodifica la toma (webm/opus) a PCM y la vuelca a WAV 24-bit.
    const decodeCtx = new OfflineAudioContext(2, 1, 48000);
    const decoded = await decodeCtx.decodeAudioData(raw.slice(0));
    const left = decoded.getChannelData(0).slice();
    const right = (
      decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0)
    ).slice();
    const wav = encodeWav(left, right, decoded.sampleRate, 24);

    const stamp = new Date();
    const two = (n: number) => String(n).padStart(2, '0');
    const name = `Toma ${two(stamp.getHours())}.${two(stamp.getMinutes())}.${two(stamp.getSeconds())}.wav`;
    const file = await api.recording.save(name, wav);

    const sampleId = newId();
    const wavBuf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    await engine.loadSample(sampleId, wavBuf);

    const project = store.project;
    const lengthBeats = Math.max(0.25, (decoded.duration * project.tempo) / 60);
    const arrangementId = project.activeArrangementId;
    const tracks = Object.values(project.playlistTracks)
      .filter((t) => t.arrangementId === arrangementId)
      .sort((a, b) => a.order - b.order);
    const clips = Object.values(project.clips);
    const overlaps = (c: Clip) =>
      c.start < startBeat + lengthBeats && c.start + c.length > startBeat;

    const commands: Command[] = [];
    let trackId: string;
    let lane = 0;

    // Comping: si ya grabaste ahí, la toma nueva se apila en el carril
    // siguiente de la MISMA pista (y calla a las que pisa, que la buena es la
    // última). Si no, pista libre; y si no hay, una nueva.
    const previous = lastTakeTrackId ? project.playlistTracks[lastTakeTrackId] : undefined;
    const previousTakes =
      previous && previous.arrangementId === arrangementId
        ? clips.filter((c) => c.playlistTrackId === previous.id && overlaps(c))
        : [];

    if (previous && previousTakes.length > 0) {
      trackId = previous.id;
      lane = Math.max(...previousTakes.map((c) => c.lane ?? 0)) + 1;
      commands.push({
        type: 'patchClips',
        patches: previousTakes.filter((c) => !c.muted).map((c) => ({ id: c.id, muted: true })),
      });
    } else {
      const free = tracks.find(
        (t) => !clips.some((c) => c.playlistTrackId === t.id && overlaps(c)),
      );
      if (free) {
        trackId = free.id;
      } else {
        const track = createPlaylistTrack(arrangementId, tracks.length);
        track.name = 'Grabaciones';
        commands.push({ type: 'addPlaylistTrack', track });
        trackId = track.id;
      }
    }
    lastTakeTrackId = trackId;

    const sample: SampleRef = {
      id: sampleId,
      name: file.replace(/\.wav$/i, ''),
      path: `recording:${file}`,
      hash: (await sha1Hex(wavBuf)) ?? sampleId,
      duration: decoded.duration,
    };
    commands.push({ type: 'registerSample', sample });

    const clip: Clip = {
      id: newId(),
      kind: 'audio',
      playlistTrackId: trackId,
      start: startBeat,
      length: lengthBeats,
      muted: false,
      sampleId,
      audioOffset: 0,
      audioGain: 1,
      ...(lane > 0 ? { lane } : null),
    };
    commands.push({ type: 'addClips', clips: [clip] });

    const label = `Grabar "${sample.name}"`;
    store.dispatch({ type: 'batch', label, commands }, { label });
    useRecorderStore.setState({ phase: 'idle', error: null });
  } catch (err) {
    useRecorderStore.setState({
      phase: 'idle',
      error: err instanceof Error ? err.message : 'No se pudo guardar la toma',
    });
  }
}

// Gancho de QA solo-dev: inyectar una fuente sintética en vez del micro real.
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__orbitSetRecStream'] = setRecorderStreamFactory;
}
