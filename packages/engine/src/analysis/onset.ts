/**
 * Envolvente de onsets del analizador: cuánto ataca el sonido en cada frame.
 *
 * No es un detector de "golpes" con umbral: es una señal continua que después
 * comen la autocorrelación y el seguimiento de pulsos. Por eso importa más la
 * FORMA (un pico por ataque, sin deriva) que la amplitud absoluta.
 *
 * Se separa en bandas porque un hi-hat en corcheas constantes tapa al bombo si
 * todo se suma en una sola curva: el detector terminaría midiendo el tatum en
 * vez del pulso. Cada banda se normaliza por su propia energía y después se
 * mezclan con pesos; la banda grave se guarda aparte para encontrar el "1" del
 * compás, que casi siempre es donde cae el bombo.
 */

import { Fft } from '../dsp/fft';
import { hannWindow } from './signal';

export interface OnsetOptions {
  /** Salto entre frames, en muestras. Por defecto 256. */
  hop?: number;
  /** Tamaño de FFT. Por defecto 1024. */
  fftSize?: number;
}

export interface OnsetEnvelope {
  /** Fuerza de onset por frame, normalizada a máximo 1. */
  values: Float32Array;
  /** Frames por segundo. */
  rate: number;
  hop: number;
  fftSize: number;
  /**
   * Envolventes por banda, normalizadas a máximo 1 cada una:
   * 0 = grave (bombo), 1 = media (caja/voz), 2 = media-alta, 3 = agudos.
   */
  bands: Float32Array[];
}

/** Cortes de las bandas (Hz). */
const BAND_EDGES = [0, 180, 900, 3000, Infinity] as const;
/** Pesos al mezclar: el grave manda en el pulso, el agudo solo confirma. */
const BAND_WEIGHTS = [1, 0.9, 0.45, 0.22] as const;
/** Radio del suavizado gaussiano de la envolvente (frames). */
const SMOOTH_RADIUS = 2;
const SMOOTH_SIGMA = 1.1;

const smoothKernel = (() => {
  const k = new Float64Array(SMOOTH_RADIUS * 2 + 1);
  let sum = 0;
  for (let i = -SMOOTH_RADIUS; i <= SMOOTH_RADIUS; i++) {
    const v = Math.exp((-0.5 * i * i) / (SMOOTH_SIGMA * SMOOTH_SIGMA));
    k[i + SMOOTH_RADIUS] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum;
  return k;
})();

/**
 * Envolvente de onsets por flujo espectral en cuatro bandas.
 *
 * El flujo es la suma de los aumentos de magnitud logarítmica respecto al frame
 * anterior. La compresión logarítmica es lo que hace que un tema masterizado a
 * -8 LUFS y otro a -16 den la misma curva: sin ella, el segundo no tendría
 * onsets. Después se resta la media móvil de ~0,35 s y se rectifica, que quita
 * la deriva de nivel y deja los ataques.
 */
export function onsetEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  opts: OnsetOptions = {},
): OnsetEnvelope {
  const hop = Math.max(1, Math.floor(opts.hop ?? 256));
  const fftSize = Math.max(64, Math.round(opts.fftSize ?? 1024));
  const empty = (): OnsetEnvelope => ({
    values: new Float32Array(0),
    rate: sampleRate / hop,
    hop,
    fftSize,
    bands: BAND_EDGES.slice(0, -1).map(() => new Float32Array(0)),
  });
  if (!(sampleRate > 0) || pcm.length < fftSize) return empty();

  const fft = new Fft(fftSize);
  const win = hannWindow(fftSize);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const bins = fftSize / 2;
  const hzPerBin = sampleRate / fftSize;
  const frames = Math.floor((pcm.length - fftSize) / hop) + 1;
  if (frames < 3) return empty();

  const nBands = BAND_WEIGHTS.length;
  const bandOf = new Uint8Array(bins);
  for (let k = 0; k < bins; k++) {
    const hz = k * hzPerBin;
    let band = nBands - 1;
    for (let b = 0; b < nBands; b++) {
      if (hz < BAND_EDGES[b + 1]!) {
        band = b;
        break;
      }
    }
    bandOf[k] = band;
  }

  const flux: Float32Array[] = [];
  for (let b = 0; b < nBands; b++) flux.push(new Float32Array(frames));
  const prev = new Float64Array(bins);
  const acc = new Float64Array(nBands);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) {
      re[i] = pcm[off + i]! * win[i]!;
      im[i] = 0;
    }
    fft.forward(re, im);
    acc.fill(0);
    for (let k = 0; k < bins; k++) {
      const mag = Math.log1p(50 * Math.hypot(re[k]!, im[k]!));
      const diff = mag - prev[k]!;
      if (diff > 0) acc[bandOf[k]!] = acc[bandOf[k]!]! + diff;
      prev[k] = mag;
    }
    for (let b = 0; b < nBands; b++) flux[b]![f] = acc[b]!;
  }

  // Media móvil de ~0.35 s por banda + rectificado + suavizado corto.
  const rate = sampleRate / hop;
  const half = Math.max(1, Math.round(0.35 * rate * 0.5));
  const bands: Float32Array[] = [];
  const values = new Float32Array(frames);
  let weightSum = 0;
  for (let b = 0; b < nBands; b++) {
    const raw = flux[b]!;
    const out = new Float32Array(frames);
    // Sumas acumuladas para la media móvil CENTRADA en O(n).
    const prefix = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f]! + raw[f]!;
    for (let f = 0; f < frames; f++) {
      const lo = Math.max(0, f - half);
      const hi = Math.min(frames - 1, f + half);
      const mean = (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
      const v = raw[f]! - mean;
      out[f] = v > 0 ? v : 0;
    }
    const smoothed = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
        const i = f + k;
        if (i < 0 || i >= frames) continue;
        sum += out[i]! * smoothKernel[k + SMOOTH_RADIUS]!;
      }
      smoothed[f] = sum;
    }
    let max = 0;
    for (let f = 0; f < frames; f++) if (smoothed[f]! > max) max = smoothed[f]!;
    if (max > 0) for (let f = 0; f < frames; f++) smoothed[f] = smoothed[f]! / max;
    bands.push(smoothed);
    const w = BAND_WEIGHTS[b]!;
    weightSum += w;
    for (let f = 0; f < frames; f++) values[f] = values[f]! + smoothed[f]! * w;
  }
  if (weightSum > 0) for (let f = 0; f < frames; f++) values[f] = values[f]! / weightSum;

  let max = 0;
  for (let f = 0; f < frames; f++) if (values[f]! > max) max = values[f]!;
  if (max > 0) for (let f = 0; f < frames; f++) values[f] = values[f]! / max;

  return { values, rate, hop, fftSize, bands };
}

/**
 * Cuenta ataques con periodo refractario. Sirve de portero: un one-shot o una
 * nota sostenida no tienen pulso, aunque su autocorrelación saque lags con
 * correlación alta.
 */
export function countAttacks(values: Float32Array, rate: number): number {
  if (values.length === 0) return 0;
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i]! > max) max = values[i]!;
  if (max <= 0) return 0;
  const threshold = max * 0.18;
  const refractory = Math.max(1, Math.round(0.11 * rate));
  let count = 0;
  let blockedUntil = -1;
  for (let i = 0; i < values.length; i++) {
    if (i > blockedUntil && values[i]! > threshold) {
      count++;
      blockedUntil = i + refractory;
    }
  }
  return count;
}
