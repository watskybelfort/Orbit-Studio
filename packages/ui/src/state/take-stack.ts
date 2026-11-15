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

/**
 * Carriles que quedan DESPUÉS de compactar (huecos cerrados).
 *
 * `takeLaneCount` devuelve max+1, que tras borrar un carril intermedio miente:
 * carriles {0,2} dan 3 cuando la compactación los deja en {0,1}. La altura se
 * calculaba con el número viejo y la pista se quedaba con un carril de más.
 */
export function takeLaneCountCompact(clips: Iterable<Clip>): number {
  const lanes = new Set<number>();
  for (const clip of clips) {
    if (clip.kind !== 'audio') continue;
    lanes.add(Math.max(0, Math.floor(clip.lane ?? 0)));
  }
  return Math.max(1, lanes.size);
}

/** Alto que necesita una pista para que `lanes` carriles sean legibles. */
export function heightForTakeLanes(height: number, lanes: number): number {
  if (!Number.isFinite(lanes)) return height;
  const safeLanes = Math.max(1, Math.ceil(lanes));
  return Math.max(height, safeLanes * TAKE_LANE_MIN_H);
}

/**
 * Franja vertical de un carril dentro de su pista, en píxeles relativos al
 * `top` de la fila.
 *
 * Existe porque el dibujo, el hit-test y la marquesina tienen que coincidir
 * EXACTAMENTE: si la marquesina siguiera seleccionando por fila entera, un
 * rectángulo dibujado sobre la toma 2 se llevaría también las tomas 1 y 3, que
 * el usuario no tocó. `lanes` se acota a 1 y `lane` a [0, lanes-1] para que un
 * `lane` viejo (una toma movida de una pista con menos carriles) no salga de
 * su pista.
 */
export function laneBand(
  trackHeight: number,
  lanes: number,
  lane: number,
): { top: number; height: number } {
  const count = Math.max(1, Math.ceil(Number.isFinite(lanes) ? lanes : 1));
  const h = Math.max(0, Number.isFinite(trackHeight) ? trackHeight : 0) / count;
  const index = Math.min(count - 1, Math.max(0, Math.floor(Number.isFinite(lane) ? lane : 0)));
  return { top: index * h, height: h };
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

export interface TakeSegment {
  /** Beat absoluto donde empieza esta pieza. */
  start: number;
  /** Cuántos beats de audio caen en esta pieza. */
  length: number;
  /** Segundos de la toma que hay que saltar para llegar a esta pieza. */
  offsetBeats: number;
}

/**
 * Parte una toma en las piezas que el LOOP hizo sonar en sitios distintos.
 *
 * Con el loop activo el transporte vuelve a `loop.start` a mitad de la toma: un
 * solo clip con toda la duración pondría el audio de la segunda vuelta sobre el
 * timeline de la primera. Aquí se corta en el mismo sitio en que el kernel
 * vuelve, y cada pieza conserva su `offsetBeats` dentro de la toma.
 *
 * Sin región (o con una inválida) devuelve la toma entera: el camino de
 * siempre no cambia.
 */
export function recordedTakeSegments(
  startBeat: number,
  totalBeats: number,
  loop?: { start: number; end: number } | null,
): TakeSegment[] {
  if (!(totalBeats > 0)) return [{ start: Math.max(0, startBeat), length: 0.25, offsetBeats: 0 }];
  const loopOk = loop !== undefined && loop !== null && loop.end > loop.start;
  // Empezar fuera de la región no es un wrap: se graba lineal y ya.
  if (!loopOk || startBeat < loop.start || startBeat >= loop.end) {
    return [{ start: Math.max(0, startBeat), length: totalBeats, offsetBeats: 0 }];
  }
  const out: TakeSegment[] = [];
  let at = startBeat;
  let consumed = 0;
  for (let guard = 0; guard < 256 && consumed < totalBeats - 1e-9; guard++) {
    const room = Math.max(0, loop.end - at);
    const length = Math.min(room, totalBeats - consumed);
    if (length <= 1e-9) break;
    out.push({ start: at, length, offsetBeats: consumed });
    consumed += length;
    at = loop.start;
  }
  if (out.length === 0) {
    return [{ start: Math.max(0, startBeat), length: totalBeats, offsetBeats: 0 }];
  }
  return out;
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
