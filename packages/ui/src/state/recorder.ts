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
import { engine, ensureAudioReady, store, togglePlay } from './app';
import { useUiStore } from './ui';

export type RecorderPhase = 'idle' | 'recording' | 'saving';

export const useRecorderStore = create<{ phase: RecorderPhase; error: string | null }>(() => ({
  phase: 'idle',
  error: null,
}));

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
  if (phase === 'idle') return startRecording();
}

async function startRecording(): Promise<void> {
  if (!window.orbit) {
    useRecorderStore.setState({ error: 'Grabar requiere la app de escritorio' });
    return;
  }
  try {
    ensureAudioReady();
    media = await streamFactory();
    chunks = [];
    recorder = new MediaRecorder(media);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    startBeat = useUiStore.getState().positionBeats;
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
  }
}

async function stopRecording(): Promise<void> {
  const rec = recorder;
  const stream = media;
  recorder = null;
  media = null;
  if (!rec) return;
  useRecorderStore.setState({ phase: 'saving' });

  const blob = await new Promise<Blob>((resolve) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType }));
    rec.stop();
  });
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
    const free = tracks.find(
      (t) =>
        !clips.some(
          (c) =>
            c.playlistTrackId === t.id &&
            c.start < startBeat + lengthBeats &&
            c.start + c.length > startBeat,
        ),
    );

    const commands: Command[] = [];
    let trackId: string;
    if (free) {
      trackId = free.id;
    } else {
      const track = createPlaylistTrack(arrangementId, tracks.length);
      track.name = 'Grabaciones';
      commands.push({ type: 'addPlaylistTrack', track });
      trackId = track.id;
    }

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
