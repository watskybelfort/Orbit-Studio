/**
 * Herramientas de composición del Piano Roll.
 *
 * Todas las funciones son puras: reciben `readonly Note[]` y devuelven un
 * array NUEVO sin mutar la entrada. Las notas transformadas conservan su `id`
 * salvo que se indique; las creadas usan `newId()`. El resultado siempre viene
 * ordenado por `start` y después `key` (determinismo).
 */

import { newId } from './ids';
import type { Note } from './model/types';

/** Tolerancia para comparar tiempos en beats. */
const EPS = 1e-6;
/** Duración mínima de un trozo/nota generada. */
const MIN_DUR = 1e-3;

export interface ArpeggiateOptions {
  /** Duración de cada nota generada, en beats. */
  rate: number;
  /** Recorrido de las alturas del acorde. */
  mode: 'up' | 'down' | 'updown';
  /** Octavas del ciclo (1 = solo las alturas originales; N añade +12·k). */
  octaves?: number;
}

export interface StrumOptions {
  /** Duración total del abanico, en beats. */
  spread: number;
  /** 'up' = la grave primero; 'down' = la aguda primero. */
  direction: 'up' | 'down';
}

export interface HumanizeOptions {
  /** Desplazamiento máximo de start, ±beats. */
  timing: number;
  /** Desplazamiento máximo de velocity, ±. */
  velocity: number;
  /** Semilla del RNG determinista (mulberry32). */
  seed: number;
}

export interface ChopOptions {
  /** Tamaño de cada trozo, en beats. */
  grid: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Orden canónico del resultado: start y después key (sort estable). */
function byStartThenKey(a: Note, b: Note): number {
  return a.start - b.start || a.key - b.key;
}

/**
 * Agrupa las notas que se solapan en el tiempo (transitividad: A∩B y B∩C
 * juntan A, B y C). Tocarse justo en el borde no cuenta como solape.
 */
function groupOverlapping(notes: readonly Note[]): Note[][] {
  const src = [...notes].sort(byStartThenKey);
  const groups: Note[][] = [];
  let current: Note[] = [];
  let currentEnd = -Infinity;
  for (const n of src) {
    if (current.length > 0 && n.start < currentEnd - EPS) {
      current.push(n);
      currentEnd = Math.max(currentEnd, n.start + n.duration);
    } else {
      if (current.length > 0) groups.push(current);
      current = [n];
      currentEnd = n.start + n.duration;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/** RNG determinista mulberry32 → floats uniformes en [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Herramientas ─────────────────────────────────────────────────────────────

/**
 * Arpegia acordes: agrupa las notas que se solapan y cada grupo se convierte
 * en una secuencia de notas de duración `rate` que recorre sus alturas según
 * `mode` ('updown' sube y baja sin repetir los extremos; `octaves` N extiende
 * el ciclo con copias a +12·k), rellenando la ventana del grupo de inicio a
 * fin (la última nota se recorta al borde). Cada nota generada hereda
 * velocity y pan de la nota de origen de su altura; todas son nuevas (newId)
 * y sin slide.
 */
export function arpeggiate(notes: readonly Note[], opts: ArpeggiateOptions): Note[] {
  if (opts.rate <= 0) throw new Error(`arpeggiate: rate debe ser > 0 (${opts.rate})`);
  const octaves = Math.max(1, Math.floor(opts.octaves ?? 1));
  const out: Note[] = [];

  for (const group of groupOverlapping(notes)) {
    const start = Math.min(...group.map((n) => n.start));
    const end = Math.max(...group.map((n) => n.start + n.duration));

    // Pool de alturas: cada nota del grupo × octavas, en orden ascendente.
    const pool: { key: number; src: Note }[] = [];
    for (let k = 0; k < octaves; k++) {
      for (const n of group) pool.push({ key: n.key + 12 * k, src: n });
    }
    pool.sort((a, b) => a.key - b.key);

    let cycle: { key: number; src: Note }[];
    if (opts.mode === 'up') cycle = pool;
    else if (opts.mode === 'down') cycle = [...pool].reverse();
    // updown: [p0..pn-1, pn-2..p1] — sin repetir extremos.
    else cycle = pool.length > 2 ? [...pool, ...[...pool].reverse().slice(1, -1)] : pool;

    for (let i = 0, t = start; t < end - EPS; i++, t += opts.rate) {
      const step = cycle[i % cycle.length]!;
      out.push({
        id: newId(),
        start: t,
        duration: Math.min(opts.rate, end - t),
        key: step.key,
        velocity: step.src.velocity,
        pan: step.src.pan,
        slide: false,
      });
    }
  }
  return out.sort(byStartThenKey);
}

/**
 * Rasguea acordes: para cada grupo de notas que empiezan en el mismo beat
 * (tolerancia 1e-6), escalona sus inicios en orden de altura ('up' = la grave
 * primero) repartiendo `spread` beats entre las n notas (la primera queda en
 * su sitio, la última a +spread). El final de cada nota no cambia: la
 * duración se acorta (mínimo 1e-3). Conserva ids.
 */
export function strum(notes: readonly Note[], opts: StrumOptions): Note[] {
  const src = [...notes].sort(byStartThenKey);
  const out: Note[] = [];

  let i = 0;
  while (i < src.length) {
    const anchor = src[i]!.start;
    const group: Note[] = [];
    while (i < src.length && Math.abs(src[i]!.start - anchor) <= EPS) {
      group.push(src[i]!);
      i++;
    }
    if (group.length === 1) {
      out.push({ ...group[0]! });
      continue;
    }
    const ordered = [...group].sort((a, b) =>
      opts.direction === 'up' ? a.key - b.key : b.key - a.key,
    );
    const step = opts.spread / (ordered.length - 1);
    ordered.forEach((n, idx) => {
      const start = n.start + step * idx;
      const end = n.start + n.duration;
      out.push({ ...n, start, duration: Math.max(MIN_DUR, end - start) });
    });
  }
  return out.sort(byStartThenKey);
}

/**
 * Humaniza timing y dinámica: desplaza cada start en ±`timing` beats (clamp a
 * ≥0) y cada velocity en ±`velocity` (clamp a 0.05..1). RNG determinista por
 * `seed` (mulberry32): la misma semilla y entrada dan el mismo resultado.
 * Conserva ids y duraciones.
 */
export function humanize(notes: readonly Note[], opts: HumanizeOptions): Note[] {
  const rand = mulberry32(opts.seed);
  const out = notes.map((n) => {
    const dt = (rand() * 2 - 1) * opts.timing;
    const dv = (rand() * 2 - 1) * opts.velocity;
    return {
      ...n,
      start: Math.max(0, n.start + dt),
      velocity: Math.min(1, Math.max(0.05, n.velocity + dv)),
    };
  });
  return out.sort(byStartThenKey);
}

/**
 * Trocea cada nota en trozos consecutivos de `grid` beats desde su start
 * hasta cubrir su duración. El último trozo puede ser más corto (mínimo
 * 1e-3: un resto menor se absorbe en el trozo anterior). El primer trozo
 * conserva el id, los demás usan newId(); key/velocity/pan se copian y slide
 * solo queda en el último trozo si la nota lo tenía.
 */
export function chop(notes: readonly Note[], opts: ChopOptions): Note[] {
  if (opts.grid <= 0) throw new Error(`chop: grid debe ser > 0 (${opts.grid})`);
  const out: Note[] = [];

  for (const n of notes) {
    const pieces: number[] = [];
    let remaining = n.duration;
    while (remaining > opts.grid + MIN_DUR) {
      pieces.push(opts.grid);
      remaining -= opts.grid;
    }
    pieces.push(Math.max(MIN_DUR, remaining));

    let t = n.start;
    pieces.forEach((duration, idx) => {
      out.push({
        ...n,
        id: idx === 0 ? n.id : newId(),
        start: t,
        duration,
        slide: idx === pieces.length - 1 ? n.slide : false,
      });
      t += duration;
    });
  }
  return out.sort(byStartThenKey);
}
