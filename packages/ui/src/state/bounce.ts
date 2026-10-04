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
import { collectWorkletSamples, noteRecordingWritten, withPinnedSample } from './sample-gc';

/** Cola que se renderiza más allá del final de la selección. */
const TAIL_SECONDS = 2;

interface BounceState {
  /** Etiqueta del trabajo en curso (null = libre). */
  busy: string | null;
  /** Último aviso para la UI (éxito o error); se autolimpia. */
  notice: string | null;
  /** WAV ya escrito que no llegó a insertarse; se conserva hasta reconocerlo. */
  recoveryNotice: string | null;
}

export const useBounceStore = create<BounceState>(() => ({ busy: null, notice: null, recoveryNotice: null }));

export function dismissBounceRecovery(): void {
  useBounceStore.setState({ recoveryNotice: null });
}

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let noticeRevision = 0;
let activeBounce: symbol | null = null;

function notify(notice: string): void {
  noticeRevision++;
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
  const arrangementId = project.playlistTracks[trackId]?.arrangementId;
  if (!arrangementId || !project.arrangements[arrangementId]) {
    notify('No se consolidó: el arreglo de destino ya no existe.');
    return;
  }

  const api = window.orbit;
  const epoch = store.historyEpoch;
  const version = store.version;
  const request = Symbol('bounce');
  activeBounce = request;
  const noticeAtStart = noticeRevision;
  const sameSession = () => store.historyEpoch === epoch && store.project.id === project.id;
  const ownsUi = () => activeBounce === request && sameSession();
  const ownsNotice = () => ownsUi() && noticeRevision === noticeAtStart;
  let file: string | null = null;
  let uploaded = false;
  let inserted = false;
  const reportRecovery = (reason: string) => {
    if (!file) return; // Un save rechazado no confirma que exista un WAV recuperable.
    useBounceStore.setState({ recoveryNotice:
      `Consolidado de «${project.meta.title}» no insertado: ${reason}. WAV conservado: «${file}». ` +
      'La ruta de datos está en Ayuda → Acerca de. En esa ruta, abre recordings; puedes arrastrar el WAV al proyecto.',
    });
  };
  const canContinue = () => {
    // Cualquier edición puede cambiar el audio (notas, tempo, mixer, plugins…).
    // Es conservador incluso ante un renombrado: nunca sustituir una revisión
    // nueva con el render anterior. Navegar o mover el caret no cambia version.
    if (ownsUi() && store.version === version) return true;
    const reason = sameSession() ? 'el proyecto cambió; vuelve a consolidar' : 'cambiaste de proyecto';
    reportRecovery(reason);
    if (ownsNotice()) notify(`No se consolidó: ${reason}.`);
    return false;
  };
  let unsubscribe: () => void = () => undefined;
  const off = store.subscribeBeforeReplace(() => {
    unsubscribe();
    if (activeBounce !== request) return;
    activeBounce = null;
    useBounceStore.setState({ busy: null });
  });
  unsubscribe = () => { off(); unsubscribe = () => undefined; };

  useBounceStore.setState({ busy: `${opts.freeze ? 'Congelando' : 'Consolidando'} ${what}…` });
  try {
    // Ceder un frame para que la UI pinte el estado antes del render (bloquea).
    // nextPaint lleva un timeout de respaldo: con la ventana oculta no hay rAF y
    // sin él el freeze se quedaba clavado en "Congelando…" indefinidamente.
    await nextPaint();
    if (!canContinue()) return;

    const compiled = compileProject(project, { mode: 'song', clipIds: clips.map((c) => c.id) });
    const { samples, missing } = await collectSamples(project, compiled);
    if (!canContinue()) return;
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
    if (!canContinue()) return;
    const wav = encodeWav(res.left, res.right, res.sampleRate, 24);
    const buffer = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;

    // Nombre por CONTENIDO (mismo criterio que `editFileName` del editor):
    // `Consolidado <qué> b<compás>.wav` colisionaba entre dos consolidados del
    // mismo tramo —y del todo entre dos ventanas— y `recording:save` pisa por
    // nombre, así que la segunda se llevaba por delante el audio de la
    // primera. Con el sha1 del wav en el nombre, pisar es escribir el mismo
    // contenido encima. El hash va ANTES del save porque el nombre sale de él
    // —y después del await se revalida la sesión antes de escribir nada.
    const sampleId = newId();
    const hash = (await sha1Hex(buffer)) ?? sampleId;
    if (!canContinue()) return;
    const base = `Consolidado ${what.replace(/[^\p{L}\p{N} _-]/gu, '')} b${start.toFixed(0)}`;
    file = await api.recording.save(`${base} ${hash}.wav`, wav);
    if (!canContinue()) return;

    // Al kernel en vivo, para que el clip nuevo suene sin recargar el proyecto.
    // Sujeto desde antes de subirlo y hasta DESPUÉS del dispatch (el mismo
    // arreglo y por el mismo motivo que el editor de audio, ver
    // `state/sample-gc.ts`): entre `loadSample` y `registerSample` ese id no lo
    // nombra nada del modelo, así que un `collectSessionSamples()` de otro
    // origen —el Ctrl+Z de `useShortcuts`, que entra por el
    // `decodeAudioData`— le diría al motor que suelte el consolidado recién
    // renderizado y el clip nuevo nacería MUDO. Con el `finally` de
    // `withPinnedSample` los dos «no se consolidó» de aquí abajo sueltan el pin
    // igual que el camino bueno: si no, un bounce abortado dejaría su id
    // protegido para siempre.
    await withPinnedSample(sampleId, async () => {
      uploaded = true;
      await engine.loadSample(sampleId, buffer, () => ownsUi() && store.version === version);
      if (!canContinue()) return;

      const sample: SampleRef = {
        id: sampleId,
        // El NOMBRE es el humano, no el del archivo: el auto-mapa de notas lee
        // los nombres y un hash hexadecimal es puro falso positivo.
        name: base,
        path: `recording:${file}`,
        hash,
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

      // La revisión no cambió: todas las fuentes y el arreglo siguen siendo
      // los renderizados, también al restaurar un proyecto con los mismos IDs.
      const liveClips = clips;

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
      inserted = true;
      // Solo el archivo insertado pertenece al ledger de esta sesión. Si A ya
      // terminó, su WAV recuperable nunca se ofrece al recolector del proyecto B.
      noteRecordingWritten({ sampleId, path: `recording:${file}`, bytes: wav.byteLength });

      const warn = [
        ...(missing.length ? [`sin samples: ${missing.join(', ')}`] : []),
        ...(missingPlugins.length ? [`plugins en bypass: ${missingPlugins.join(', ')}`] : []),
      ];
      if (ownsNotice()) notify(
        `${opts.freeze ? 'Congelada' : 'Consolidado'} ${what}: ${liveClips.length} clip(s) → ${sample.name}` +
          (warn.length ? ` (${warn.join('; ')})` : ''),
      );
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : 'No se pudo consolidar';
    if (!inserted) reportRecovery(error);
    if (ownsNotice()) notify(error);
  } finally {
    unsubscribe();
    if (uploaded && !inserted) collectWorkletSamples(engine, store.project);
    if (activeBounce === request) {
      activeBounce = null;
      useBounceStore.setState({ busy: null });
    }
  }
}
