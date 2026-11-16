/**
 * Recuperación de una toma que la app no llegó a cerrar.
 *
 * El diario (`state/recording-journal.ts`) deja PCM crudo en disco. Al
 * arrancar se listan los diarios huérfanos y se ofrece el más reciente: se
 * convierte a WAV, se guarda en `recordings/` y, si el proyecto abierto es el
 * mismo en que se grabó, se inserta en una pista «Toma recuperada» en un solo
 * undo. Si el proyecto no coincide, el WAV queda en recordings y se dice el
 * nombre — el audio no se pierde, que es lo único irrepetible.
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
import { store } from './app';
import { latencyBeats, placeRecordedClip } from './input-latency';
import { useRecorderStore } from './recorder';
import { heightForTakeLanes, recordedTakeSegments } from './take-stack';

interface RecoveryState {
  /** El diario huérfano más reciente, si hay. */
  offer: JournalInfo | null;
  busy: boolean;
  error: string | null;
}

export const useTakeRecovery = create<RecoveryState>(() => ({
  offer: null,
  busy: false,
  error: null,
}));

/** Busca diarios huérfanos al arrancar. Silencioso si no hay escritorio. */
export async function checkRecordingRecovery(): Promise<void> {
  const api = typeof window === 'undefined' ? undefined : window.orbit?.recording?.journal;
  if (!api) return;
  try {
    const list = await api.list();
    if (list.length > 0) useTakeRecovery.setState({ offer: list[0]!, error: null });
  } catch {
    // Sin diarios legibles no hay nada que ofrecer; no es un error de arranque.
  }
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

function clockOf(at: number): string {
  const d = new Date(at);
  return `${two(d.getHours())}.${two(d.getMinutes())}.${two(d.getSeconds())}`;
}

/**
 * Recupera el diario ofrecido. Devuelve el texto que ve el usuario.
 */
export async function recoverInterruptedTake(): Promise<void> {
  const offer = useTakeRecovery.getState().offer;
  const api = typeof window === 'undefined' ? undefined : window.orbit?.recording?.journal;
  if (!offer || !api) return;
  useTakeRecovery.setState({ busy: true, error: null });
  const saved: string[] = [];
  try {
    const journal = await api.read(offer.id);
    let inserted = false;
    const commands: Command[] = [];
    for (const route of journal.routes) {
      const left = new Float32Array(route.left);
      const right = new Float32Array(route.right);
      if (left.length === 0) continue;
      const wav = encodeWav(left, right, journal.meta.sampleRate, 24);
      const hash = (await sha1Hex(wav.buffer.slice(
        wav.byteOffset,
        wav.byteOffset + wav.byteLength,
      ) as ArrayBuffer)) ?? newId();
      const human = `Toma recuperada ${clockOf(offer.startedAt)}${route.name ? ` ${route.name}` : ''}`;
      const file = await window.orbit!.recording.save(`${human} ${hash}.wav`, wav);
      saved.push(file);
      // Insertar solo si es el MISMO proyecto: las posiciones (beat, tempo,
      // loop) son de aquel estado, no del que haya abierto ahora.
      if (journal.meta.projectId !== store.project.id) continue;
      const arrangementId = journal.meta.arrangementId;
      if (!store.project.arrangements[arrangementId]) continue;

      const beatSec = 60 / journal.meta.tempo;
      const totalBeats = left.length / journal.meta.sampleRate / beatSec;
      const segments = recordedTakeSegments(journal.meta.start, totalBeats, journal.meta.loop);
      const first = placeRecordedClip(
        segments[0]!.start,
        segments[0]!.length * beatSec,
        journal.meta.latency,
        journal.meta.sampleRate,
        journal.meta.tempo,
      );
      const latencia = latencyBeats(journal.meta.latency, journal.meta.sampleRate, journal.meta.tempo);
      const sampleId = newId();
      const sample: SampleRef = {
        id: sampleId,
        name: human,
        path: `recording:${file}`,
        hash,
        duration: left.length / journal.meta.sampleRate,
      };
      const tracks = Object.values(store.project.playlistTracks)
        .filter((track) => track.arrangementId === arrangementId)
        .sort((a, b) => a.order - b.order);
      const track = createPlaylistTrack(arrangementId, tracks.length, 'Toma recuperada');
      track.height = heightForTakeLanes(56, segments.length);
      commands.push({ type: 'registerSample', sample });
      commands.push({ type: 'addPlaylistTrack', track });
      const clips: Clip[] = segments.map((segment, index) => ({
        id: newId(),
        kind: 'audio',
        playlistTrackId: track.id,
        start: index === 0 ? first.start : Math.max(0, segment.start - latencia),
        length: index === 0 ? first.lengthBeats : segment.length,
        muted: index < segments.length - 1,
        sampleId,
        audioOffset: index === 0 ? first.audioOffset : segment.offsetBeats * beatSec,
        audioGain: 1,
        ...(index > 0 ? { lane: index } : null),
      }));
      commands.push({ type: 'addClips', clips });
      inserted = true;
    }

    if (inserted) {
      store.dispatch(
        { type: 'batch', label: 'Recuperar toma interrumpida', commands },
        { label: 'Recuperar toma interrumpida' },
      );
    }
    await api.discard(offer.id);
    useTakeRecovery.setState({ offer: null, busy: false });
    useRecorderStore.setState({
      notice: inserted
        ? `Toma interrumpida recuperada en la pista «Toma recuperada» (${saved.join(', ')}).`
        : `Toma interrumpida recuperada como ${saved.join(', ')}. Está en recordings; arrástrala al proyecto.`,
    });
  } catch (err) {
    useTakeRecovery.setState({
      busy: false,
      error: err instanceof Error ? err.message : 'No se pudo recuperar la toma',
    });
  }
}

/** Descarta el diario ofrecido (el usuario no la quiere). */
export async function discardInterruptedTake(): Promise<void> {
  const offer = useTakeRecovery.getState().offer;
  const api = typeof window === 'undefined' ? undefined : window.orbit?.recording?.journal;
  useTakeRecovery.setState({ offer: null, error: null });
  if (offer && api) await api.discard(offer.id).catch(() => undefined);
}
