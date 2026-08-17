/**
 * Detección de transientes: dónde empieza cada golpe de un audio.
 *
 * Sirve para trocear un loop (el Fruity Slicer de toda la vida) y para
 * cuadrar tomas contra la rejilla. El método es el clásico de flujo espectral
 * simplificado a bandas: en vez de una FFT completa por ventana —que aquí
 * sería matar moscas a cañonazos— se sigue la energía en varias bandas con
 * filtros de un polo y se mide cuánto SUBE (solo lo positivo: un golpe es un
 * aumento brusco, no un descenso).
 *
 * Todo es puro y determinista: mismo audio, mismos cortes.
 */

export interface TransientOptions {
  /** Sensibilidad 0..1 (más alto = más cortes). */
  sensitivity?: number;
  /** Separación mínima entre cortes, en segundos. */
  minSpacingSec?: number;
  /** Número máximo de cortes devueltos (los más fuertes). */
  maxCount?: number;
}

/** Bandas del detector (Hz). Graves para el bombo, medios para caja/palmas. */
const BANDS = [
  [20, 120],
  [120, 500],
  [500, 2000],
  [2000, 8000],
] as const;

/** Tamaño del salto de análisis: ~5.8 ms a 44.1 kHz. */
const HOP = 256;

export interface TransientResult {
  /** Posiciones en segundos desde el inicio del audio. */
  times: number[];
  /** Fuerza relativa 0..1 de cada corte (mismo orden que `times`). */
  strengths: number[];
}

/**
 * Devuelve los transientes del audio. `left`/`right` pueden ser el mismo
 * array (mono); se analiza la suma.
 */
export function detectTransients(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts: TransientOptions = {},
): TransientResult {
  const sensitivity = clamp01(opts.sensitivity ?? 0.5);
  const minSpacing = Math.max(0.01, opts.minSpacingSec ?? 0.05);
  const n = Math.min(left.length, right.length);
  if (n < HOP * 2) return { times: [], strengths: [] };

  const frames = Math.floor(n / HOP);
  const flux = new Float32Array(frames);

  // Un par de filtros de un polo por banda (paso alto + paso bajo en cascada)
  // dan un paso banda suficiente para seguir energía; no hace falta más.
  for (const [lo, hi] of BANDS) {
    const aLo = onePoleCoef(lo, sampleRate);
    const aHi = onePoleCoef(hi, sampleRate);
    let lpLow = 0; // seguidor del corte grave (lo que quitamos)
    let lpHigh = 0; // seguidor del corte agudo (lo que dejamos pasar)
    let prevEnergy = 0;
    for (let f = 0; f < frames; f++) {
      let energy = 0;
      const from = f * HOP;
      for (let i = from; i < from + HOP; i++) {
        const x = (left[i]! + right[i]!) * 0.5;
        lpLow += aLo * (x - lpLow);
        const band = x - lpLow; // paso alto
        lpHigh += aHi * (band - lpHigh); // y paso bajo encima
        energy += lpHigh * lpHigh;
      }
      energy = Math.sqrt(energy / HOP);
      // Flujo positivo en dominio logarítmico: un golpe es un salto relativo,
      // y así un tema flojito no se queda sin cortes frente a uno fuerte.
      const rise = Math.log10((energy + 1e-6) / (prevEnergy + 1e-6));
      if (rise > 0) flux[f]! += rise;
      prevEnergy = energy;
    }
  }

  // Umbral adaptativo: media móvil del flujo + margen según sensibilidad.
  const win = Math.max(4, Math.round(0.25 / (HOP / sampleRate)));
  const times: number[] = [];
  const strengths: number[] = [];
  const minFrames = Math.max(1, Math.round((minSpacing * sampleRate) / HOP));
  let lastPick = -minFrames;
  let maxStrength = 0;

  for (let f = 1; f < frames - 1; f++) {
    const value = flux[f]!;
    // Solo picos locales: si el vecino sube más, el golpe es el vecino.
    if (value < flux[f - 1]! || value < flux[f + 1]!) continue;
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, f - win); k < Math.min(frames, f + win); k++) {
      sum += flux[k]!;
      count++;
    }
    const mean = sum / Math.max(1, count);
    const margin = 0.12 + (1 - sensitivity) * 0.5;
    if (value <= mean + margin) continue;
    if (f - lastPick < minFrames) continue;
    lastPick = f;
    const strength = value - mean;
    maxStrength = Math.max(maxStrength, strength);
    times.push((f * HOP) / sampleRate);
    strengths.push(strength);
  }

  // Normaliza fuerzas a 0..1 y, si se pidió tope, deja los más fuertes.
  for (let i = 0; i < strengths.length; i++) {
    strengths[i] = maxStrength > 0 ? strengths[i]! / maxStrength : 0;
  }
  const max = opts.maxCount ?? 0;
  if (max > 0 && times.length > max) {
    const order = times.map((_, i) => i).sort((a, b) => strengths[b]! - strengths[a]!);
    const keep = new Set(order.slice(0, max));
    const t: number[] = [];
    const s: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (!keep.has(i)) continue;
      t.push(times[i]!);
      s.push(strengths[i]!);
    }
    return { times: t, strengths: s };
  }
  return { times, strengths };
}

/**
 * Reparte `count` cortes iguales (troceado a la rejilla, sin analizar):
 * útil cuando el loop ya viene cuadrado y lo que se quiere son N trozos.
 */
export function evenSlices(durationSec: number, count: number): number[] {
  const n = Math.max(1, Math.round(count));
  const out: number[] = [];
  for (let i = 1; i < n; i++) out.push((durationSec * i) / n);
  return out;
}

function onePoleCoef(freqHz: number, sampleRate: number): number {
  const f = Math.min(freqHz, sampleRate * 0.45);
  return 1 - Math.exp((-2 * Math.PI * f) / sampleRate);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
