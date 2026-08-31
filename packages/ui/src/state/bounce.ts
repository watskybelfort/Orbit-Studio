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
import {
  canUseRenderWorker,
  renderProjectInWorker,
} from '../export/render-in-worker';
import { engine, store } from './app';
import { nextPaint } from './next-paint';
import { withPinnedSample } from './sample-gc';

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

/**
 * El aviso de una línea de la app (la tira `app-notice` de `App.tsx`).
 *
 * Vive aquí por dónde nació —consolidar a audio—, pero el banner es UNO solo y
 * ya lo comparten el editor de automatización y el import de archivos. Mejor un
 * `notify` con el dueño raro que tres copias del mismo temporizador, que es
 * como estaba a punto de quedarse.
 */
export function notifyBanner(text: string): void {
  notify(text);
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

/**
 * Congela una pista: la renderiza como el bounce, pero **sin borrar nada**.
 * Los clips originales se quedan muteados en el carril de abajo y el audio
 * manda arriba; descongelar quita el audio y los devuelve a su sitio. Es el
 * cambio que ahorra CPU en un proyecto grande sin perder la posibilidad de
 * volver a editar.
 */
export async function freezeTrack(trackId: string): Promise<void> {
  const track = store.project.playlistTracks[trackId];
  if (!track) return;
  const clips = bounceableClipsOfTrack(trackId);
  if (clips.length === 0) {
    notify('Esa pista no tiene nada que congelar.');
    return;
  }
  await bounceClips(clips, `pista "${track.name}"`, { freeze: true });
}

/** Clip congelado de una pista, si lo hay. */
export function frozenClipOfTrack(trackId: string): Clip | undefined {
  return Object.values(store.project.clips).find(
    (c) => c.playlistTrackId === trackId && c.frozenFrom !== undefined,
  );
}

/** Descongela: quita el audio y devuelve los clips originales a su carril. */
export function unfreezeTrack(trackId: string): void {
  const frozen = frozenClipOfTrack(trackId);
  if (!frozen) return;
  const sources = (frozen.frozenFrom ?? [])
    .map((id) => store.project.clips[id])
    .filter((c): c is Clip => c !== undefined);
  const label = 'Descongelar pista';
  store.dispatch(
    {
      type: 'batch',
      label,
      commands: [
        { type: 'removeClips', clipIds: [frozen.id] },
        {
          // Freeze subió el carril con (lane ?? 0)+1; descongelar lo revierte en
          // vez de aplanar a 0, que en un comping tiraba la toma buena (lane 2)
          // encima de las muteadas.
          type: 'patchClips',
          patches: sources.map((c) => ({ id: c.id, muted: false, lane: Math.max(0, (c.lane ?? 1) - 1) })),
        },
      ],
    },
    { label },
  );
}

/** Consolida un clip suelto. */
export async function bounceClip(clipId: string): Promise<void> {
  const clip = store.project.clips[clipId];
  if (!clip || clip.kind === 'automation') return;
  await bounceClips([clip], 'clip');
}

async function bounceClips(
  clips: Clip[],
  what: string,
  opts: { freeze?: boolean } = {},
): Promise<void> {
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

  useBounceStore.setState({ busy: `${opts.freeze ? 'Congelando' : 'Consolidando'} ${what}…` });
  try {
    // Ceder un frame para que la UI pinte el estado antes del render (bloquea).
    // nextPaint lleva un timeout de respaldo: con la ventana oculta no hay rAF y
    // sin él el freeze se quedaba clavado en "Congelando…" indefinidamente.
    await nextPaint();

    const compiled = compileProject(project, { mode: 'song', clipIds: clips.map((c) => c.id) });
    const { samples, missing } = await collectSamples(project, compiled);
    const { plugins, missing: missingPlugins } = collectPluginSources(project);

    // El render (donde se ejecutan los plugins) va en el worker aislado; en
    // Node/tests, sin Worker, cae al render directo.
    const renderOpts = {
      samples,
      plugins,
      startBeat: start,
      endBeat: end,
      tailSeconds: TAIL_SECONDS,
    };
    const res = canUseRenderWorker()
      ? await renderProjectInWorker(compiled, renderOpts)
      : renderProject(compiled, renderOpts);
    const wav = encodeWav(res.left, res.right, res.sampleRate, 24);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;

    const name = `Consolidado ${what.replace(/[^\p{L}\p{N} _-]/gu, '')} b${start.toFixed(0)}.wav`;
    const file = await window.orbit.recording.save(name, wav);

    // Al kernel en vivo, para que el clip nuevo suene sin recargar el proyecto.
    const sampleId = newId();
    // Sujeto desde antes de subirlo y hasta DESPUÉS del dispatch (el mismo
    // arreglo y por el mismo motivo que el editor de audio, ver
    // `state/sample-gc.ts`): entre `loadSample` y `registerSample` ese id no lo
    // nombra nada del modelo, así que un `collectSessionSamples()` de otro
    // origen —el Ctrl+Z de `useShortcuts`, que entra por el `await` de
    // `sha1Hex`— le diría al motor que suelte el consolidado recién renderizado
    // y el clip nuevo nacería MUDO. Con el `finally` de `withPinnedSample` los
    // dos «no se consolidó» de aquí abajo sueltan el pin igual que el camino
    // bueno: si no, un bounce abortado dejaría su id protegido para siempre.
    await withPinnedSample(sampleId, async () => {
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

      // Revalidar contra el proyecto de AHORA: el render pudo tardar segundos y en
      // ese hueco un peer/Claude/el usuario pudo borrar clips o la pista destino.
      // Sin esto el batch referencia ids muertos (con el rollback de core: se cae
      // entero y no consolida nada) o deja un clip huérfano sobre una pista que ya
      // no existe.
      const now = store.project;
      if (!now.playlistTracks[trackId]) {
        notify('No se consolidó: la pista destino ya no existe.');
        return;
      }
      const liveClips = clips.filter((c) => now.clips[c.id]);
      if (liveClips.length === 0) {
        notify('No se consolidó: esos clips ya no están.');
        return;
      }

      // Congelar conserva los clips originales (muteados y un carril más abajo);
      // consolidar los sustituye.
      const commands: Command[] = [{ type: 'registerSample', sample }];
      if (opts.freeze) {
        audioClip.frozenFrom = liveClips.map((c) => c.id);
        commands.push({
          type: 'patchClips',
          patches: liveClips.map((c) => ({ id: c.id, muted: true, lane: (c.lane ?? 0) + 1 })),
        });
      } else {
        commands.push({ type: 'removeClips', clipIds: liveClips.map((c) => c.id) });
      }
      commands.push({ type: 'addClips', clips: [audioClip] });
      const label = opts.freeze ? `Congelar ${what}` : `Consolidar ${what} a audio`;
      store.dispatch({ type: 'batch', label, commands }, { label });

      const warn = [
        ...(missing.length ? [`sin samples: ${missing.join(', ')}`] : []),
        ...(missingPlugins.length ? [`plugins en bypass: ${missingPlugins.join(', ')}`] : []),
      ];
      notify(
        `${opts.freeze ? 'Congelada' : 'Consolidado'} ${what}: ${liveClips.length} clip(s) → ${sample.name}` +
          (warn.length ? ` (${warn.join('; ')})` : ''),
      );
    });
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo consolidar.');
  } finally {
    useBounceStore.setState({ busy: null });
  }
}
