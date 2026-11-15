/**
 * Tomas apiladas de una pista (comping de voz): cuántos carriles hay, qué alto
 * necesita la pista para que se lean, y qué `patchClips` deja sonando UNA.
 *
 * Vive aquí y no en `Playlist.tsx` porque hay dos consumidores que tienen que
 * estar de acuerdo y no pueden derivar: el grabador, que decide en qué carril
 * cae la toma nueva y cuánto crece la pista (`state/recorder.ts`), y el editor,
 * que dibuja los carriles y ofrece elegir cuál suena. Si cada uno calculara el
 * alto a su manera, la toma recién grabada podría nacer en un carril que el
 * dibujo recorta —justo el fallo que esta pieza viene a cerrar—.
 *
 * La regla de comping es la de siempre: la toma nueva se apila encima de la
 * anterior y calla a las que pisa, porque la buena es la última. Lo que cambia
 * es que ahora la pista crece para que cada carril conserve altura legible, y
 * que elegir una toma es una acción visible (menú de la cabecera) en vez de un
 * clic central que nadie descubre.
 */

import type { Clip, Id } from '@orbit/core';

/**
 * Alto mínimo de un carril de toma, en píxeles.
 *
 * 30 y no 26: la franja del nombre mide hasta 13 px y el clip reserva 4 px de
 * marco y 5 px de aire, así que por debajo de 22 px no queda ni un píxel para
 * la forma de onda (`ah > 4`). Con 26 justos el carril quedaba en 4 px de onda
 * y el guard la saltaba; 30 deja 8 px de onda y coincide con la altura mínima
 * que la Playlist ya permite arrastrar.
 */
export const TAKE_LANE_MIN_H = 30;

/** Cuántos carriles necesita una pista para sus tomas (mínimo 1). */
export function takeLaneCount(clips: Iterable<Clip>): number {
  let max = 0;
  for (const clip of clips) {
    // Un clip de patrón o de automatización no es una toma: puede vivir en la
    // misma pista y no debe contar carriles, ni salir en el menú de tomas.
    if (clip.kind !== 'audio') continue;
    max = Math.max(max, Math.max(0, Math.floor(clip.lane ?? 0)));
  }
  return max + 1;
}

/** Alto que necesita una pista para que `lanes` carriles sean legibles. */
export function heightForTakeLanes(height: number, lanes: number): number {
  if (!Number.isFinite(lanes)) return height;
  const safeLanes = Math.max(1, Math.ceil(lanes));
  return Math.max(height, safeLanes * TAKE_LANE_MIN_H);
}

/** ¿Los dos intervalos [start, start+length) se pisan? */
export function clipsOverlap(
  a: Pick<Clip, 'start' | 'length'>,
  b: Pick<Clip, 'start' | 'length'>,
): boolean {
  return a.start < b.start + b.length && b.start < a.start + a.length;
}

/**
 * Parches que dejan sonando `targetId` y callan las tomas que pisa.
 *
 * Devuelve `null` si la toma no está en la lista: quien llama puede entonces
 * distinguir "no hay nada que hacer" de "hay un patch vacío". Los clips que no
 * se pisan no se tocan —elegir una toma no puede mutear una segunda voz que
 * suena en otro compás de la misma pista—, y el objetivo se desmutea siempre:
 * una toma elegida dos veces tiene que sonar, no alternar.
 */
export function chooseTakePatches(
  clips: readonly Clip[],
  targetId: Id,
): { id: Id; muted: boolean }[] | null {
  const target = clips.find((clip) => clip.id === targetId);
  if (!target) return null;
  const patches: { id: Id; muted: boolean }[] = [];
  for (const clip of clips) {
    // Solo las tomas de audio se mutean entre sí: un patrón que suena encima
    // de la voz no es una toma y no puede desaparecer al elegir un compás.
    if (clip.kind !== 'audio') continue;
    if (!clipsOverlap(clip, target)) continue;
    const muted = clip.id !== target.id;
    // Solo se emite lo que cambia: un patch redundante ensucia el undo.
    if (clip.muted !== muted) patches.push({ id: clip.id, muted });
  }
  return patches;
}

export interface TakeRow {
  clip: Clip;
  /** Carril 1-based, el que ve el usuario. */
  number: number;
  /** ¿Es la que está sonando? (no muteada) */
  active: boolean;
}

/**
 * Las tomas de una pista en orden de carril y luego de tiempo, con su número
 * visible y si están activas. Es lo que pinta el menú de la cabecera.
 */
export function takeRows(clips: readonly Clip[]): TakeRow[] {
  return clips
    .filter((clip) => clip.kind === 'audio')
    .slice()
    .sort((a, b) => (a.lane ?? 0) - (b.lane ?? 0) || a.start - b.start)
    .map((clip) => ({
      clip,
      number: Math.max(0, Math.floor(clip.lane ?? 0)) + 1,
      active: !clip.muted,
    }));
}

/**
 * Parches para renumerar los carriles 0..n-1 después de borrar una toma.
 *
 * Sin esto, borrar la toma 2 de 4 deja carriles 0, 2 y 3: el alto de la pista
 * sigue reservando cuatro y la numeración visible miente. La renumeración
 * conserva el ORDEN (no reordena tomas), solo cierra huecos. Devuelve `[]` si
 * ya está compacto, para no ensuciar el undo.
 */
export function compactTakeLanePatches(clips: readonly Clip[]): { id: Id; lane: number }[] {
  const lanes = [
    ...new Set(
      clips
        .filter((clip) => clip.kind === 'audio')
        .map((clip) => Math.max(0, Math.floor(clip.lane ?? 0))),
    ),
  ].sort((a, b) => a - b);
  const remap = new Map(lanes.map((lane, index) => [lane, index]));
  const patches: { id: Id; lane: number }[] = [];
  for (const clip of clips) {
    if (clip.kind !== 'audio') continue;
    const before = Math.max(0, Math.floor(clip.lane ?? 0));
    const after = remap.get(before)!;
    if (after !== before) patches.push({ id: clip.id, lane: after });
  }
  return patches;
}
