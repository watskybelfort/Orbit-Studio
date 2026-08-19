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

/** Carácter rítmico del riff (cómo caen las notas dentro del compás). */
export type RiffCharacter = 'sostenido' | 'sincopado' | 'puntillo';

export interface RiffOptions {
  /** Semilla del RNG determinista (mulberry32): misma semilla = mismo riff. */
  seed: number;
  /** Tónica en semitonos 0..11 (0 = C). */
  root: number;
  /** Escala: intervalos en semitonos desde la tónica (como SCALES). */
  scale: readonly number[];
  /** Longitud en compases (≥ 1). */
  bars: number;
  /** Pulsos por compás (4 = 4/4). Por defecto 4. */
  beatsPerBar?: number;
  /** Densidad: notas por compás (se redondea y se limita a 1..32). */
  density: number;
  /** Octava más grave del rango (convención FL: C5 = 60 → octava 5). */
  octaveLow: number;
  /** Cuántas octavas abarca el riff desde `octaveLow` (≥ 1). */
  octaves: number;
  /** Carácter rítmico. */
  character: RiffCharacter;
  /** Beat inicial dentro del patrón (por defecto 0). */
  start?: number;
  /** Velocity de referencia 0..1 (por defecto 0.8). */
  velocity?: number;
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

/** Tope de densidad del riff (notas por compás) — más es ruido, no música. */
const RIFF_MAX_DENSITY = 32;

/**
 * Pasos del paseo melódico, en GRADOS de la escala. Los cortos aparecen
 * repetidos: el riff se mueve casi siempre por grados vecinos y solo de vez en
 * cuando pega un salto (así suena a motivo y no a arpegio aleatorio).
 */
const RIFF_STEPS = [0, 1, -1, 1, -1, 2, -2, 1, -1, 2, -2, 3, -3, 4, -4, 1];

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

/**
 * Riff machine: genera un motivo melódico sobre una escala y tónica.
 *
 * El ritmo sale de una rejilla de `density` notas por compás (siempre
 * `density × bars` notas exactas) que el `character` desplaza y recorta:
 * 'sostenido' llena la rejilla ligado, 'sincopado' ancla el pie del compás y
 * manda el resto al contratiempo dejando huecos, y 'puntillo' hace parejas
 * larga-corta 3:1. Ninguna nota se solapa con la siguiente ni rebasa el final.
 *
 * Las alturas son un paseo por los GRADOS de la escala dentro del rango de
 * octavas (pasos cortos casi siempre, saltos sueltos; ver RIFF_STEPS), que
 * rebota en los bordes del rango. Cada compás tiende a empezar en nota del
 * acorde de tónica (grados 1, 3 y 5) para que el motivo tenga pie.
 *
 * **Determinista**: la misma `seed` con las mismas opciones da exactamente las
 * mismas notas (mulberry32, cero Math.random). Lo único que cambia entre dos
 * llamadas son los `id`, que siempre son nuevos (newId).
 */
export function riff(opts: RiffOptions): Note[] {
  const bars = Math.floor(opts.bars);
  if (bars <= 0) throw new Error(`riff: bars debe ser > 0 (${opts.bars})`);
  const beatsPerBar = opts.beatsPerBar ?? 4;
  if (beatsPerBar <= 0) throw new Error(`riff: beatsPerBar debe ser > 0 (${beatsPerBar})`);
  const perBar = Math.min(RIFF_MAX_DENSITY, Math.max(1, Math.round(opts.density)));
  const octaves = Math.max(1, Math.floor(opts.octaves));

  // Grados únicos y ordenados de la escala (0..11 desde la tónica).
  const degrees = [...new Set(opts.scale.map((s) => ((s % 12) + 12) % 12))].sort((a, b) => a - b);
  if (degrees.length === 0) throw new Error('riff: la escala no tiene ni un grado');
  const root = ((Math.round(opts.root) % 12) + 12) % 12;
  const inSc = (key: number) => degrees.includes((((key - root) % 12) + 12) % 12);

  // Pool de alturas: las de la escala dentro del rango de octavas pedido.
  const lowKey = Math.max(0, Math.floor(opts.octaveLow) * 12);
  const highKey = Math.min(127, lowKey + octaves * 12 - 1);
  const pool: number[] = [];
  for (let k = lowKey; k <= highKey; k++) if (inSc(k)) pool.push(k);
  if (pool.length === 0) throw new Error('riff: ninguna nota de la escala cabe en el rango');
  const last = pool.length - 1;
  /** Índices del pool que son nota del acorde de tónica (grados 1, 3 y 5). */
  const chordKeys = new Set(
    [0, 2, 4].map((d) => (root + (degrees[d % degrees.length] ?? 0)) % 12),
  );

  const rand = mulberry32(opts.seed);
  const riffStart = Math.max(0, opts.start ?? 0);
  const riffEnd = riffStart + bars * beatsPerBar;
  const baseVel = opts.velocity ?? 0.8;
  const slot = beatsPerBar / perBar;

  // ── Rejilla rítmica (starts y duraciones "de intención") ──
  const starts: number[] = [];
  const durations: number[] = [];
  for (let b = 0; b < bars; b++) {
    for (let i = 0; i < perBar; i++) {
      const slotStart = riffStart + b * beatsPerBar + i * slot;
      if (opts.character === 'sincopado') {
        // Ancla el pie del compás y manda el resto al contratiempo (con hueco).
        starts.push(slotStart + (i === 0 ? 0 : slot / 2));
        durations.push(slot * 0.5);
      } else if (opts.character === 'puntillo') {
        const off = i % 2 === 1;
        starts.push(slotStart + (off ? slot * 0.5 : 0));
        durations.push(slot * (off ? 0.5 : 1.5));
      } else {
        starts.push(slotStart);
        durations.push(slot);
      }
    }
  }
  // Recorte: nadie pisa a la siguiente ni rebasa el final del riff.
  for (let i = 0; i < starts.length; i++) {
    const limit = (i + 1 < starts.length ? starts[i + 1]! : riffEnd) - starts[i]!;
    durations[i] = Math.max(MIN_DUR, Math.min(durations[i]!, limit));
  }

  // ── Alturas: paseo por grados con rebote en los bordes del rango ──
  // Arranca en la tónica más cercana al centro del rango (o el centro si la
  // escala no tiene tónica, p. ej. una escala exótica sin el grado 0).
  const mid = Math.floor(last / 2);
  let idx = mid;
  for (let d = 0; d <= pool.length; d++) {
    if (pool[mid - d] !== undefined && pool[mid - d]! % 12 === root) { idx = mid - d; break; }
    if (pool[mid + d] !== undefined && pool[mid + d]! % 12 === root) { idx = mid + d; break; }
  }

  const out: Note[] = [];
  for (let n = 0; n < starts.length; n++) {
    if (n > 0) {
      const barHead = n % perBar === 0;
      if (barHead && rand() < 0.65) {
        // Pie de compás: a la nota del acorde de tónica más cercana.
        if (!chordKeys.has(pool[idx]! % 12)) {
          for (let d = 1; d <= pool.length; d++) {
            const down = idx - d;
            if (down >= 0 && chordKeys.has(pool[down]! % 12)) { idx = down; break; }
            const up = idx + d;
            if (up <= last && chordKeys.has(pool[up]! % 12)) { idx = up; break; }
          }
        }
      } else {
        const step = RIFF_STEPS[Math.floor(rand() * RIFF_STEPS.length)] ?? 0;
        let next = idx + step;
        // Rebote: en vez de clavarse en el borde, el motivo da la vuelta.
        if (next < 0) next = -next;
        if (next > last) next = 2 * last - next;
        idx = Math.min(last, Math.max(0, next));
      }
    }
    const onBeat = Math.abs(starts[n]! - Math.round(starts[n]!)) < EPS;
    const velocity = Math.min(
      1,
      Math.max(0.05, baseVel + (onBeat ? 0.08 : -0.06) + (rand() - 0.5) * 0.12),
    );
    out.push({
      id: newId(),
      start: starts[n]!,
      duration: durations[n]!,
      key: pool[idx]!,
      velocity,
      pan: 0,
      slide: false,
    });
  }
  return out.sort(byStartThenKey);
}

// ── Acordes sobre notas ya escritas ──────────────────────────────────────────

export interface ChordifyOptions {
  /** Intervalos del acorde en semitonos desde la nota (0 = la propia nota). */
  intervals: readonly number[];
  /**
   * Escala a la que ajustar las notas añadidas. Sin ella el acorde es FIJO
   * (los mismos semitonos siempre); con ella cada nota se arrima al grado mas
   * cercano de la escala, que es lo que hace que una progresión suene a
   * tonalidad y no a la misma forma copiada arriba y abajo.
   */
  scale?: readonly number[];
  /** Tónica de la escala en semitonos 0..11 (0 = C). Solo con `scale`. */
  root?: number;
  /** Tecla más aguda permitida (por defecto 127). */
  maxKey?: number;
  /**
   * Notas que YA existen en el canal. Lo que caiga encima de una de ellas no
   * se añade: si no, aplicar el acorde dos veces (o sobre una nota que ya
   * forma parte de otro acorde) apila notas idénticas que suenan +6 dB y solo
   * se ven al moverlas.
   */
  existing?: readonly Note[];
}

/** Arrima una tecla al grado más cercano de la escala (empate: hacia abajo). */
function nearestInScale(key: number, root: number, scale: readonly number[], maxKey: number): number {
  if (inScaleList(key, root, scale)) return key;
  for (let d = 1; d <= 6; d++) {
    if (key - d >= 0 && inScaleList(key - d, root, scale)) return key - d;
    if (key + d <= maxKey && inScaleList(key + d, root, scale)) return key + d;
  }
  return key;
}

function inScaleList(midi: number, root: number, scale: readonly number[]): boolean {
  const rel = (((midi - root) % 12) + 12) % 12;
  return scale.includes(rel);
}

/**
 * Convierte cada nota en un acorde y devuelve SOLO las notas nuevas.
 *
 * Devuelve lo que hay que añadir, no el conjunto entero, porque así el que
 * llama lo manda con un único `addNotes` y deshacer quita exactamente el
 * acorde sin tocar las notas originales (que conservan su id, su velocity y
 * su slide).
 *
 * Las notas generadas heredan start, duración, velocity y pan de su nota
 * madre, y nunca llevan slide: el glide es de la fundamental.
 */
export function chordify(notes: readonly Note[], opts: ChordifyOptions): Note[] {
  const maxKey = opts.maxKey ?? 127;
  const intervals = [...new Set(opts.intervals)].sort((a, b) => a - b);
  if (intervals.length === 0) return [];

  const taken = new Set<string>();
  const at = (key: number, start: number) => `${key}@${start.toFixed(6)}`;
  for (const n of opts.existing ?? notes) taken.add(at(n.key, n.start));

  const out: Note[] = [];
  for (const n of notes) {
    for (const iv of intervals) {
      let key = n.key + iv;
      if (opts.scale && opts.scale.length > 0) {
        key = nearestInScale(key, ((opts.root ?? 0) % 12 + 12) % 12, opts.scale, maxKey);
      }
      if (key < 0 || key > maxKey) continue;
      const slot = at(key, n.start);
      if (taken.has(slot)) continue;
      taken.add(slot);
      out.push({
        id: newId(),
        start: n.start,
        duration: n.duration,
        key,
        velocity: n.velocity,
        pan: n.pan,
        slide: false,
      });
    }
  }
  return out.sort(byStartThenKey);
}
