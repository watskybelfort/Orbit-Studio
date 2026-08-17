/**
 * Acciones sobre un parámetro concreto (`ParamRef`): crear su clip de
 * automatización o ponerle/quitarle un LFO.
 *
 * Las usan el menú contextual de la perilla, la paleta de comandos y la
 * grabación de movimientos. Todo pasa por el bus de comandos y cada acción
 * deja UN solo paso de undo (batch cuando hace falta crear también la pista).
 */

import {
  createLfo,
  createPlaylistTrack,
  newId,
  paramRefKey,
  paramRefNorm,
  describeParamRef,
  type AutomationPoint,
  type Clip,
  type Command,
  type Lfo,
  type ParamRef,
  type Project,
} from '@orbit/core';
import { store } from './app';
import { useUiStore } from './ui';

/** Longitud por defecto de un clip creado desde la perilla: 4 compases. */
export function defaultClipLength(project: Project): number {
  return Math.max(4, project.timeSig.num * 4);
}

/**
 * Pista del arrangement activo sin clips en [start, start+length); si todas
 * están ocupadas encola la creación de una nueva ("Automatización").
 */
export function pickFreeTrack(
  project: Project,
  start: number,
  length: number,
  commands: Command[],
  newTrackName = 'Automatización',
): string {
  const tracks = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === project.activeArrangementId)
    .sort((a, b) => a.order - b.order);
  const clips = Object.values(project.clips);
  const free = tracks.find(
    (t) =>
      !clips.some(
        (c) =>
          c.playlistTrackId === t.id && c.start < start + length && c.start + c.length > start,
      ),
  );
  if (free) return free.id;
  const track = createPlaylistTrack(project.activeArrangementId, tracks.length, newTrackName);
  commands.push({ type: 'addPlaylistTrack', track });
  return track.id;
}

/**
 * Crea el clip de automatización de un destino y lo abre en el editor.
 * Empieza plano en el valor actual del parámetro: dibujar es cosa del usuario
 * (o de la grabación de perillas, que sí trae puntos).
 */
export function createAutomationClipFor(
  ref: ParamRef,
  opts: { start?: number; length?: number; points?: AutomationPoint[] } = {},
): string {
  const project = store.project;
  const value = paramRefNorm(ref, project) ?? 0.5;
  const start = opts.start ?? 0;
  const length = opts.length ?? defaultClipLength(project);
  const points = opts.points;

  const commands: Command[] = [];
  const playlistTrackId = pickFreeTrack(project, start, length, commands);
  const clip: Clip = {
    id: newId(),
    kind: 'automation',
    playlistTrackId,
    start,
    length,
    muted: false,
    target: ref,
    points: points ?? [
      { id: newId(), time: 0, value, tension: 0 },
      { id: newId(), time: length, value, tension: 0 },
    ],
  };
  commands.push({ type: 'addClips', clips: [clip] });

  const label = `Automatización de ${describeParamRef(ref, project)}`;
  store.dispatch({ type: 'batch', label, commands }, { label });
  useUiStore.setState({ automationClipId: clip.id });
  useUiStore.getState().openWindow('automation');
  return clip.id;
}

/** LFO que ya modula ese destino, si lo hay. */
export function findLfoFor(ref: ParamRef, project: Project): Lfo | undefined {
  const key = paramRefKey(ref);
  return Object.values(project.lfos).find((l) => paramRefKey(l.target) === key);
}

/** Pone un LFO en el destino (o abre el que ya tenía) y muestra el panel. */
export function addLfoFor(ref: ParamRef): string {
  const project = store.project;
  const existing = findLfoFor(ref, project);
  if (existing) {
    useUiStore.getState().openWindow('lfo');
    return existing.id;
  }
  // Un ciclo por compás: musical de partida en cualquier tempo.
  const lfo = createLfo(ref, Math.max(1, project.timeSig.num));
  const label = `LFO en ${describeParamRef(ref, project)}`;
  store.dispatch({ type: 'addLfos', lfos: [lfo] }, { label });
  useUiStore.getState().openWindow('lfo');
  return lfo.id;
}

export function removeLfo(lfoId: string): void {
  const lfo = store.project.lfos[lfoId];
  if (!lfo) return;
  store.dispatch(
    { type: 'removeLfos', lfoIds: [lfoId] },
    { label: `Quitar LFO de ${describeParamRef(lfo.target, store.project)}` },
  );
}
