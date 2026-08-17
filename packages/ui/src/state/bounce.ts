/**
 * Consolidar a audio (bounce): un conjunto de clips → un solo clip de audio,
 * en su sitio y con su sonido.
 *
 * Se renderiza **solo esa selección** pero por la cadena de mixer completa, así
 * que lo que cae es lo que se oía: efectos, sidechain, automatización y LFOs
 * incluidos. El WAV va a userData/recordings (esquema `recording:`, el mismo
 * que las tomas de micro, así que se rehidrata solo al reabrir el proyecto) y
 * todo el cambio —registrar el sample, quitar los clips viejos y poner el
 * nuevo— entra en UN paso de undo.
 *
 * La cola (reverb/delay) se renderiza y se guarda en el archivo, pero el clip
 * conserva la longitud original: la región de la playlist no crece sola. Si
 * luego se alarga el clip, la cola está ahí.
 */

import { compileProject, encodeWav, renderProject } from '@orbit/engine';
import { newId, type Clip, type Command, type SampleRef } from '@orbit/core';
import { create } from 'zustand';
import { sha1Hex } from '../browser/sound-actions';
import { collectPluginSources, collectSamples } from '../export/render-inputs';
import { engine, store } from './app';

/** Cola que se renderiza más allá del final de la selección. */
const TAIL_SECONDS = 2;

interface BounceState {
  /** Etiqueta del trabajo en curso (null = libre). */
  busy: string | null;
  /** Último aviso para la UI (éxito o error); se autolimpia. */
  notice: string | null;
}

export const useBounceStore = create<BounceState>(() => ({ busy: null, notice: null }));

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function notify(notice: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  useBounceStore.setState({ notice });
  noticeTimer = setTimeout(() => useBounceStore.setState({ notice: null }), 5000);
}

/** Clips consolidables de una pista (los de automatización se quedan). */
export function bounceableClipsOfTrack(trackId: string): Clip[] {
  return Object.values(store.project.clips).filter(
    (c) => c.playlistTrackId === trackId && c.kind !== 'automation' && !c.muted,
  );
}

/** Consolida todos los clips de una pista de playlist. */
export async function bounceTrack(trackId: string): Promise<void> {
  const track = store.project.playlistTracks[trackId];
  if (!track) return;
  await bounceClips(bounceableClipsOfTrack(trackId), `pista "${track.name}"`);
}

/** Consolida un clip suelto. */
export async function bounceClip(clipId: string): Promise<void> {
  const clip = store.project.clips[clipId];
  if (!clip || clip.kind === 'automation') return;
  await bounceClips([clip], 'clip');
}

async function bounceClips(clips: Clip[], what: string): Promise<void> {
  if (useBounceStore.getState().busy) return;
  if (clips.length === 0) {
    notify('No hay nada que consolidar ahí.');
    return;
  }
  if (!window.orbit) {
    notify('Consolidar a audio requiere la app de escritorio.');
    return;
  }

  const project = store.project;
  const start = Math.min(...clips.map((c) => c.start));
  const end = Math.max(...clips.map((c) => c.start + c.length));
  const length = end - start;
  const trackId = clips[0]!.playlistTrackId;

  useBounceStore.setState({ busy: `Consolidando ${what}…` });
  try {
    // Ceder un frame para que la UI pinte el estado antes del render (bloquea).
    await new Promise((r) => requestAnimationFrame(() => r(null)));

    const compiled = compileProject(project, { mode: 'song', clipIds: clips.map((c) => c.id) });
    const { samples, missing } = await collectSamples(project, compiled);
    const { plugins, missing: missingPlugins } = collectPluginSources(project);

    const res = renderProject(compiled, {
      samples,
      plugins,
      startBeat: start,
      endBeat: end,
      tailSeconds: TAIL_SECONDS,
    });
    const wav = encodeWav(res.left, res.right, res.sampleRate, 24);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;

    const name = `Consolidado ${what.replace(/[^\p{L}\p{N} _-]/gu, '')} b${start.toFixed(0)}.wav`;
    const file = await window.orbit.recording.save(name, wav);

    // Al kernel en vivo, para que el clip nuevo suene sin recargar el proyecto.
    const sampleId = newId();
    await engine.loadSample(sampleId, buffer);

    const sample: SampleRef = {
      id: sampleId,
      name: file.replace(/\.wav$/i, ''),
      path: `recording:${file}`,
      hash: (await sha1Hex(buffer)) ?? sampleId,
      duration: res.left.length / res.sampleRate,
    };
    const audioClip: Clip = {
      id: newId(),
      kind: 'audio',
      playlistTrackId: trackId,
      start,
      length,
      muted: false,
      sampleId,
      audioOffset: 0,
      audioGain: 1,
    };

    const commands: Command[] = [
      { type: 'registerSample', sample },
      { type: 'removeClips', clipIds: clips.map((c) => c.id) },
      { type: 'addClips', clips: [audioClip] },
    ];
    const label = `Consolidar ${what} a audio`;
    store.dispatch({ type: 'batch', label, commands }, { label });

    const warn = [
      ...(missing.length ? [`sin samples: ${missing.join(', ')}`] : []),
      ...(missingPlugins.length ? [`plugins en bypass: ${missingPlugins.join(', ')}`] : []),
    ];
    notify(
      `Consolidado ${what}: ${clips.length} clip(s) → ${sample.name}` +
        (warn.length ? ` (${warn.join('; ')})` : ''),
    );
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo consolidar.');
  } finally {
    useBounceStore.setState({ busy: null });
  }
}
