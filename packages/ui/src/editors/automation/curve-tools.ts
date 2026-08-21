/**
 * Aritmética de las herramientas de curva (lápiz, recta y formas).
 *
 * Aquí no hay React ni canvas: solo lo que decide qué puntos quedan en el clip.
 * Es la parte que se equivoca en silencio —un tramo que se sustituye mal deja
 * un salto en mitad del barrido y solo se nota al oírlo—, así que vive aparte y
 * con tests.
 *
 * Todo trabaja en la misma unidad que el modelo: `time` en beats desde el
 * inicio del clip y `value` normalizado 0..1.
 */

import { newId, type AutomationPoint } from '@orbit/core';
import { simplifyCurve, type CurveSample } from '../../state/simplify';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

/**
 * Separación mínima entre dos puntos que representan un salto vertical.
 *
 * El motor interpola entre puntos consecutivos, así que un flanco de verdad
 * (una sierra, una cuadrada) se dibuja con dos puntos casi en el mismo beat.
 * No pueden estar en el MISMO beat: `evalCurve` devuelve el segundo cuando el
 * tramo mide cero, y entonces el flanco depende del orden del array en vez de
 * la posición. 1/512 de beat es inaudible y sobrevive al redondeo.
 */
export const EDGE = 1 / 512;

/** Un punto nuevo, con id fresco y tensión lineal salvo que se diga otra cosa. */
function point(time: number, value: number, tension = 0): AutomationPoint {
  return { id: newId(), time, value: clamp01(value), tension };
}

// ── Cuantización de valor ────────────────────────────────────────────────────

/**
 * Redondea el valor a `steps` divisiones (0 = libre).
 *
 * Es el snap del eje vertical: con 12 divisiones, un destino de tono cae en
 * semitonos; con 2, un interruptor solo puede estar arriba o abajo.
 */
export function quantizeValue(value: number, steps: number): number {
  if (steps <= 0) return clamp01(value);
  return clamp01(Math.round(clamp01(value) * steps) / steps);
}

// ── Sustituir un tramo ───────────────────────────────────────────────────────

/**
 * Sustituye lo que haya entre `from` y `to` por `fresh`, dejando el resto.
 *
 * Los dos bordes son lo delicado. Al dibujar encima de un tramo, el punto que
 * queda justo fuera sigue mandando sobre la rampa que entra en lo dibujado, así
 * que el trazo tiene que EMPEZAR donde empieza y no heredar el valor del
 * vecino: por eso se recorta a `[from, to]` y se apoyan sus extremos ahí. Y la
 * tensión del punto anterior se pone a 0 — si venía combada, la curva entraba
 * en el trazo por un camino que el usuario no dibujó.
 *
 * Nunca devuelve una lista vacía: un clip sin puntos no se puede evaluar.
 */
export function replaceRange(
  points: readonly AutomationPoint[],
  from: number,
  to: number,
  fresh: readonly AutomationPoint[],
): AutomationPoint[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const before = points.filter((p) => p.time < lo - 1e-9).map((p) => ({ ...p }));
  const after = points.filter((p) => p.time > hi + 1e-9).map((p) => ({ ...p }));

  const last = before[before.length - 1];
  if (last) last.tension = 0;

  const middle = fresh.map((p) => ({ ...p, time: clamp(p.time, lo, hi) }));
  const out = [...before, ...middle, ...after].sort((a, b) => a.time - b.time);
  return out.length > 0 ? out : [point(lo, fresh[0]?.value ?? 0)];
}

// ── Lápiz ────────────────────────────────────────────────────────────────────

export interface StrokeOptions {
  /** Tolerancia de la simplificación, en unidades de valor (0..1). */
  eps?: number;
  /** Divisiones del snap vertical (0 = libre). */
  valueSteps?: number;
}

/**
 * Convierte un trazo a mano alzada en puntos.
 *
 * El trazo llega como una muestra por evento de puntero: cientos para un
 * barrido de dos compases. Se ordena por tiempo (un trazo hacia atrás es un
 * trazo, no un error), se queda UNA muestra por instante —la última, que es lo
 * que el usuario acaba de decidir— y se simplifica con Douglas-Peucker
 * vertical, el mismo que usa la grabación de perillas.
 *
 * Sin el dedup, dos muestras en el mismo beat dejan un tramo de longitud cero y
 * el motor devuelve la segunda: un escalón invisible en mitad de la rampa.
 */
export function strokeToPoints(
  samples: readonly CurveSample[],
  { eps = 0.01, valueSteps = 0 }: StrokeOptions = {},
): AutomationPoint[] {
  if (samples.length === 0) return [];

  const sorted = samples
    .map((s) => ({ time: s.time, norm: clamp01(s.norm) }))
    .sort((a, b) => a.time - b.time);

  const dedup: CurveSample[] = [];
  for (const s of sorted) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.time - s.time) < 1e-9) dedup[dedup.length - 1] = s;
    else dedup.push(s);
  }

  /*
   * El snap va ANTES de simplificar, y ese orden es la diferencia entre que
   * funcione y que no.
   *
   * Simplificando primero, una rampa recta se queda en sus dos extremos y
   * redondear esos dos deja "de 0 a 1": el snap no se nota por ningún lado. Con
   * el orden bueno, las muestras caen a sus alturas, la rampa se convierte en
   * la escalera que el usuario está pidiendo, y la simplificación se queda con
   * las esquinas de esa escalera.
   */
  const snapped =
    valueSteps > 0
      ? dedup.map((s) => ({ time: s.time, norm: quantizeValue(s.norm, valueSteps) }))
      : dedup;

  // Un trazo de una sola muestra (un clic) es un punto: vale igual.
  return simplifyCurve(snapped, eps).map((s) => point(s.time, s.norm));
}

// ── Recta ────────────────────────────────────────────────────────────────────

/** Rampa recta entre dos puntos: dos breakpoints y tensión lineal. */
export function lineBetween(
  fromTime: number,
  fromValue: number,
  toTime: number,
  toValue: number,
  valueSteps = 0,
): AutomationPoint[] {
  const a = { t: fromTime, v: fromValue };
  const b = { t: toTime, v: toValue };
  const [lo, hi] = a.t <= b.t ? [a, b] : [b, a];
  if (Math.abs(hi.t - lo.t) < 1e-9) return [point(lo.t, quantizeValue(hi.v, valueSteps))];
  return [
    point(lo.t, quantizeValue(lo.v, valueSteps)),
    point(hi.t, quantizeValue(hi.v, valueSteps)),
  ];
}

// ── Formas ───────────────────────────────────────────────────────────────────

export type CurveShape = 'sine' | 'triangle' | 'sawUp' | 'sawDown' | 'square' | 'random';

export const SHAPE_LABELS: Record<CurveShape, string> = {
  sine: 'Seno',
  triangle: 'Triángulo',
  sawUp: 'Sierra ↗',
  sawDown: 'Sierra ↘',
  square: 'Cuadrada',
  random: 'Aleatoria',
};

export interface ShapeOptions {
  shape: CurveShape;
  /** Tramo del clip que se rellena, en beats. */
  from: number;
  to: number;
  /** Cuántos ciclos caben en ese tramo. */
  cycles: number;
  /** Extremos del recorrido (pueden ir invertidos para dar la vuelta a la forma). */
  min: number;
  max: number;
  /** Desplazamiento de fase, 0..1 de ciclo. */
  phase?: number;
  /** Muestras por ciclo de las formas continuas (seno). */
  resolution?: number;
  /** Semilla de la forma aleatoria: la misma semilla da la misma curva. */
  seed?: number;
}

/** PRNG determinista (mulberry32): con la misma semilla, la misma aleatoria. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Genera los puntos de una forma sobre `[from, to]`.
 *
 * Cada forma usa los puntos que necesita y ni uno más: el seno muestrea (no hay
 * tensión que haga una S — la del motor es una potencia), el triángulo son tres
 * por ciclo, y la sierra y la cuadrada llevan sus flancos como pares de puntos
 * separados por `EDGE`. Poner resolución alta a todo dejaría clips de cientos
 * de breakpoints imposibles de retocar a mano después.
 */
export function shapePoints(options: ShapeOptions): AutomationPoint[] {
  const { shape, min, max, phase = 0, resolution = 12, seed = 1 } = options;
  const from = Math.min(options.from, options.to);
  const to = Math.max(options.from, options.to);
  const span = to - from;
  const cycles = Math.max(0.25, options.cycles);
  if (span <= 0) return [];

  const period = span / cycles;
  const lo = clamp01(Math.min(min, max));
  const hi = clamp01(Math.max(min, max));
  /** Valor de la forma para una fase 0..1 dentro del ciclo. */
  const at = (u: number) => lo + (hi - lo) * u;
  const out: AutomationPoint[] = [];

  /** Empuja un punto acotado al tramo; ignora lo que se salga por la derecha. */
  const push = (t: number, v: number) => {
    if (t < from - 1e-9 || t > to + 1e-9) return;
    out.push(point(clamp(t, from, to), v));
  };

  if (shape === 'sine') {
    const steps = Math.max(4, Math.round(resolution));
    const total = Math.ceil(cycles * steps);
    for (let i = 0; i <= total; i++) {
      const u = (i / steps + phase) % 1;
      // Arranca en el CENTRO subiendo, como cualquier LFO con fase 0: con el
      // coseno arrancaba abajo y una fase 0 ya sonaba desplazada media onda.
      push(from + (i / steps) * period, at(0.5 + 0.5 * Math.sin(2 * Math.PI * u)));
    }
  } else if (shape === 'triangle') {
    const total = Math.ceil(cycles * 2);
    for (let i = 0; i <= total; i++) {
      const u = (i / 2 + phase) % 1;
      push(from + (i / 2) * period, at(u < 0.5 ? u * 2 : 2 - u * 2));
    }
  } else if (shape === 'sawUp' || shape === 'sawDown') {
    const rising = shape === 'sawUp';
    /*
     * Un ciclo = rampa completa, y el flanco de vuelta lo pone el ciclo
     * SIGUIENTE con su primer punto. Ponerlo también aquí (en t0+period)
     * duplicaba el instante: dos puntos en el mismo beat dejan un tramo de
     * longitud cero, que el motor resuelve por orden del array en vez de por
     * posición. El bucle llega a ceil(cycles) justo para que el último flanco
     * exista aunque los ciclos no sean enteros.
     */
    for (let c = 0; c <= Math.ceil(cycles); c++) {
      const t0 = from + (c - phase) * period;
      push(t0, at(rising ? 0 : 1));
      push(t0 + period - EDGE, at(rising ? 1 : 0));
    }
  } else if (shape === 'square') {
    for (let c = 0; c <= Math.ceil(cycles); c++) {
      const t0 = from + (c - phase) * period;
      push(t0, at(1));
      push(t0 + period / 2 - EDGE, at(1));
      push(t0 + period / 2, at(0));
      push(t0 + period - EDGE, at(0));
    }
  } else {
    // Sample & hold: un valor por ciclo, con escalón entre uno y el siguiente.
    const next = rng(seed);
    for (let c = 0; c <= Math.ceil(cycles); c++) {
      const t0 = from + (c - phase) * period;
      const v = at(next());
      push(t0, v);
      push(t0 + period - EDGE, v);
    }
  }

  // Las formas con fase o con ciclos fraccionarios pueden dejar el tramo sin
  // cubrir por los extremos: se apoyan ahí con el valor que toque, para que
  // `replaceRange` no deje un hueco donde manda el vecino de fuera.
  const first = out[0];
  const last = out[out.length - 1];
  if (!first || first.time > from + 1e-9) {
    out.unshift(point(from, first?.value ?? at(0)));
  }
  if (!last || last.time < to - 1e-9) {
    out.push(point(to, last?.value ?? at(0)));
  }
  return out.sort((a, b) => a.time - b.time);
}
