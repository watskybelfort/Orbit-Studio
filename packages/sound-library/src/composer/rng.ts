/**
 * Azar con semilla para el compositor.
 *
 * Todo lo que decide el compositor sale de aquí: con la misma semilla y las
 * mismas opciones, el mismo beat — nota por nota. Es lo que permite el botón
 * «otra vez igual» y que un test fije un resultado sin congelar un render.
 *
 * mulberry32: 32 bits de estado, rápido y con buen reparto para decisiones
 * musicales (no es criptográfico ni lo necesita).
 */

export interface Rng {
  /** Uniforme en [0, 1). */
  next(): number;
  /** Entero uniforme en [min, max] (ambos incluidos). */
  int(min: number, max: number): number;
  /** `true` con probabilidad `p`. */
  chance(p: number): boolean;
  /** Un elemento del array (no vacío). */
  pick<T>(items: readonly T[]): T;
  /** Un elemento por pesos (mismo largo que `items`; pesos ≥ 0). */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Uniforme en [min, max). */
  range(min: number, max: number): number;
  /** Generador hijo, independiente del orden de consumo del padre. */
  fork(label: string): Rng;
}

/** Hash FNV-1a de 32 bits: para derivar semillas hijas de un texto. */
export function hashString(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted: (items, weights) => {
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return items[0]!;
      let r = next() * total;
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i] ?? 0);
        if (r < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    range: (min, max) => min + next() * (max - min),
    // El hijo NO consume del padre: así añadir una decisión en una parte no
    // cambia lo que sale en las demás (la batería no se mueve porque la
    // melodía haya pedido un número más).
    fork: (label) => createRng(hashString(label, seed >>> 0)),
  };
  return rng;
}
