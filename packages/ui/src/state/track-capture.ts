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
import { currentBeat, engine, store, togglePlay } from './app';
import { useUiStore } from './ui';

interface TrackCaptureState {
  /** Pista que se está grabando, o null. */
  trackIndex: number | null;
  /** Segundos capturados (para el rótulo del botón). */
  seconds: number;
  error: string | null;
}

export const useTrackCapture = create<TrackCaptureState>(() => ({
  trackIndex: null,
  seconds: 0,
  error: null,
}));

let chunksL: Float32Array[] = [];
let chunksR: Float32Array[] = [];
let total = 0;
let startBeat = 0;
let sampleRate = 48000;

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
  const current = useTrackCapture.getState().trackIndex;
  if (current === trackIndex) return stopTrackCapture();
  if (current !== null) await stopTrackCapture();
  startTrackCapture(trackIndex);
}

function startTrackCapture(trackIndex: number): void {
  if (!window.orbit) {
    useTrackCapture.setState({ error: 'Grabar pistas requiere la app de escritorio' });
    return;
  }
  chunksL = [];
  chunksR = [];
  total = 0;
  sampleRate = engine.sampleRate;
  startBeat = currentBeat();
  useTrackCapture.setState({ trackIndex, seconds: 0, error: null });
  engine.setTrackCapture(trackIndex, true);
  // Parado no hay nada que capturar: arranca el transporte, como el rec de micro.
  if (!useUiStore.getState().playing) void togglePlay();
}

export async function stopTrackCapture(): Promise<void> {
  const { trackIndex } = useTrackCapture.getState();
  if (trackIndex === null) return;
  engine.setTrackCapture(trackIndex, false);
  useTrackCapture.setState({ trackIndex: null, seconds: 0 });

  const left = concat(chunksL, total);
  const right = concat(chunksR, total);
  chunksL = [];
  chunksR = [];
  const captured = total;
  total = 0;
  if (captured < sampleRate * 0.1) {
    useTrackCapture.setState({ error: 'La toma salió demasiado corta' });
    return;
  }

  try {
    const api = window.orbit;
    if (!api) throw new Error('Sin puente de escritorio');
    const project = store.project;
    const trackName = project.mixer[trackIndex]?.name ?? `Insert ${trackIndex}`;
    const wav = encodeWav(left, right, sampleRate, 24);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    const file = await api.recording.save(`Pista ${trackName}.wav`, wav);

    const sampleId = newId();
    await engine.loadSample(sampleId, buffer);

    const duration = captured / sampleRate;
    const lengthBeats = Math.max(0.25, (duration * project.tempo) / 60);
    const sample: SampleRef = {
      id: sampleId,
      name: file.replace(/\.wav$/i, ''),
      path: `recording:${file}`,
      hash: (await sha1Hex(buffer)) ?? sampleId,
      duration,
    };

    // Pista de playlist libre en ese tramo (si no, una nueva "Grabaciones").
    const tracks = Object.values(project.playlistTracks)
      .filter((t) => t.arrangementId === project.activeArrangementId)
      .sort((a, b) => a.order - b.order);
    const clips = Object.values(project.clips);
    const free = tracks.find(
      (t) =>
        !clips.some(
          (c) =>
            c.playlistTrackId === t.id &&
            c.start < startBeat + lengthBeats &&
            c.start + c.length > startBeat,
        ),
    );
    const commands: Command[] = [{ type: 'registerSample', sample }];
    let playlistTrackId: string;
    if (free) {
      playlistTrackId = free.id;
    } else {
      const track = createPlaylistTrack(project.activeArrangementId, tracks.length, 'Grabaciones');
      commands.push({ type: 'addPlaylistTrack', track });
      playlistTrackId = track.id;
    }

    const clip: Clip = {
      id: newId(),
      kind: 'audio',
      playlistTrackId,
      start: startBeat,
      length: lengthBeats,
      muted: false,
      sampleId,
      audioOffset: 0,
      audioGain: 1,
    };
    commands.push({ type: 'addClips', clips: [clip] });

    const label = `Grabar la salida de "${trackName}"`;
    store.dispatch({ type: 'batch', label, commands }, { label });
    useTrackCapture.setState({ error: null });
  } catch (err) {
    useTrackCapture.setState({
      error: err instanceof Error ? err.message : 'No se pudo guardar la toma',
    });
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
