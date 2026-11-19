/**
 * Detección de tonalidad.
 *
 * El croma no se calcula sumando bins de una FFT: se calculan los PICOS
 * espectrales, se refinan por interpolación parabólica y se mapean a clases de
 * altura con una ventana coseno². La diferencia importa en los graves: un 808
 * en Do1 tiene su fundamental a 32,7 Hz y, con un croma de bins, la fuga de la
 * ventana reparte esa energía entre Re y Si; con picos, la fundamental cae en
 * Do y la quinta (tercer armónico) no se lleva el crédito.
 *
 * Tres detalles más, cada uno por un error observado:
 *
 * - **Afinación**: si el tema está a -18 cents (pasa en vinilos y en samples
 *   grabados a otra referencia), el croma pierde energía entre dos semitonos.
 *   Se estima la desviación global y se corrige antes de mapear.
 * - **Supresión de armónicos**: un Do4 con mucho quinto armónico parece tener
 *   un Mi. Si existe un pico fuerte en f/2 o f/3, el pico actual es un armónico
 *   y se atenúa. Así el croma representa notas tocadas, no su serie armónica.
 * - **Perfiles**: se combinan Bgate (el que mejor mide en música popular), el
 *   de Krumhansl-Kessler (percepción) y el de Temperley (corpus). Uno solo se
 *   equivoca en los casos que otro acierta; el promedio es más estable que
 *   cualquiera de los tres.
 */

import { Fft } from '../dsp/fft';
import { clamp01, hannWindow } from './signal';
import {
  KEY_MODE_LABELS,
  NOTE_NAMES,
  type KeyCandidate,
  type KeyEstimate,
  type KeyMode,
} from './types';

export interface ChromaOptions {
  /** Ventana máxima de FFT. Por defecto 16384 (~0,74 s a 22 kHz). */
  maxFftSize?: number;
  /** Ventana mínima. Por defecto 4096. */
  minFftSize?: number;
  /** Fundamental más grave que se considera. Por defecto 30 Hz (B0). */
  minHz?: number;
  /** Armónico más agudo que se considera. Por defecto 3500 Hz. */
  maxHz?: number;
}

const DEFAULT_MIN_HZ = 30;
const DEFAULT_MAX_HZ = 3500;
const DEFAULT_MAX_FFT = 16384;
const DEFAULT_MIN_FFT = 4096;
/** Un pico por debajo de esta fracción del máximo del frame no es señal. */
const PEAK_FLOOR = 0.01;

interface SpectralPeak {
  hz: number;
  amp: number;
}

interface TonalProfile {
  /** Croma global, normalizado a máximo 1. */
  chroma: Float32Array;
  /** Croma de los graves (< 220 Hz), normalizado a máximo 1. */
  bass: Float32Array;
  /** Desviación de afinación en semitonos (-0.5..0.5). */
  tuningSemitones: number;
  /** 0..1 — claridad del croma (1 = una nota, 0 = ruido uniforme). */
  clarity: number;
}

/** Mayor potencia de dos ≤ n, acotada al rango del croma. */
function chromaFftSize(n: number, minSize: number, maxSize: number): number {
  let size = 1;
  while (size * 2 <= Math.min(n, maxSize)) size *= 2;
  return Math.max(minSize, size);
}

/** Picos espectrales de un frame, con frecuencia refinada y amplitud. */
function framePeaks(
  mag: Float64Array,
  bins: number,
  hzPerBin: number,
  minHz: number,
  maxHz: number,
  out: SpectralPeak[],
): void {
  out.length = 0;
  const kMin = Math.max(2, Math.floor(minHz / hzPerBin));
  const kMax = Math.min(bins - 2, Math.ceil(maxHz / hzPerBin));
  if (kMax <= kMin) return;

  let frameMax = 0;
  for (let k = kMin; k <= kMax; k++) if (mag[k]! > frameMax) frameMax = mag[k]!;
  if (frameMax <= 1e-9) return;
  const floor = frameMax * PEAK_FLOOR;

  for (let k = kMin; k <= kMax; k++) {
    const a = mag[k - 1]!;
    const b = mag[k]!;
    const c = mag[k + 1]!;
    if (b <= floor || b <= a || b < c) continue;

    // Interpolación parabólica en log-magnitud: frecuencia sub-bin y amplitud
    // corregida. Sin ella, un La de 440 Hz a 22 kHz cae a 2,7 Hz de un bin y
    // el croma lo reparte entre La y La#.
    const la = Math.log(a + 1e-12);
    const lb = Math.log(b + 1e-12);
    const lc = Math.log(c + 1e-12);
    const denom = la - 2 * lb + lc;
    const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (la - lc)) / denom)) : 0;
    const amp = Math.exp(lb - 0.25 * (la - lc) * shift);
    const hz = (k + shift) * hzPerBin;
    if (hz >= minHz && hz <= maxHz) out.push({ hz, amp });
  }
}

/** Magnitud en un bin cercano a `hz` (para la comprobación de subarmónicos). */
function magNear(mag: Float64Array, hz: number, hzPerBin: number, bins: number): number {
  const k = Math.round(hz / hzPerBin);
  if (k < 1 || k >= bins) return 0;
  let best = 0;
  for (let d = -1; d <= 1; d++) {
    const i = k + d;
    if (i >= 0 && i < bins && mag[i]! > best) best = mag[i]!;
  }
  return best;
}

/**
 * Perfil tonal de un PCM mono: croma global, croma de graves, afinación y
 * claridad. Es la materia prima de `detectKey` y del croma público.
 */
export function tonalProfile(pcm: Float32Array, sampleRate: number, opts: ChromaOptions = {}): TonalProfile | null {
  if (!(sampleRate > 0) || pcm.length < DEFAULT_MIN_FFT) return null;
  const minHz = opts.minHz ?? DEFAULT_MIN_HZ;
  const maxHz = opts.maxHz ?? DEFAULT_MAX_HZ;
  const size = chromaFftSize(pcm.length, opts.minFftSize ?? DEFAULT_MIN_FFT, opts.maxFftSize ?? DEFAULT_MAX_FFT);
  const hop = Math.max(1, Math.floor(size / 2));
  const fft = new Fft(size);
  const win = hannWindow(size);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const mag = new Float64Array(size / 2);
  const bins = size / 2;
  const hzPerBin = sampleRate / size;
  const frames = Math.max(0, Math.floor((pcm.length - size) / hop) + 1);
  if (frames < 1) return null;

  // Pasada 1: picos de todos los frames y afinación global. Guardar los picos
  // (no la FFT) permite corregir la afinación y mapear en una segunda pasada
  // sin repetir las transformadas.
  const framePeaksList: SpectralPeak[][] = [];
  let tuningRe = 0;
  let tuningIm = 0;
  let tuningWeight = 0;

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = pcm[off + i]! * win[i]!;
      im[i] = 0;
    }
    fft.forward(re, im);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    const peaks: SpectralPeak[] = [];
    framePeaks(mag, bins, hzPerBin, minHz, maxHz, peaks);
    if (peaks.length === 0) continue;

    for (const peak of peaks) {
      const semitones = 12 * Math.log2(peak.hz / 440);
      const phase = 2 * Math.PI * semitones;
      const w = peak.amp;
      tuningRe += w * Math.cos(phase);
      tuningIm += w * Math.sin(phase);
      tuningWeight += w;
    }
    // La supresión de armónicos necesita la magnitud del frame; se guarda el
    // peso ya calculado junto al pico.
    const weighted = peaks.map((peak) => {
      let weight = peak.amp;
      if (peak.hz >= minHz * 2) {
        const half = magNear(mag, peak.hz / 2, hzPerBin, bins);
        if (half > peak.amp * 0.28) weight *= 0.35;
        else if (peak.hz >= minHz * 3) {
          const third = magNear(mag, peak.hz / 3, hzPerBin, bins);
          if (third > peak.amp * 0.3) weight *= 0.5;
        }
      }
      // Los graves definen la tónica: un 808 o un bajo en la fundamental pesa
      // más que el mismo croma dos octavas arriba.
      if (peak.hz < 220) weight *= 1.7;
      return { hz: peak.hz, amp: weight };
    });
    framePeaksList.push(weighted);
  }

  if (framePeaksList.length === 0 || tuningWeight <= 0) return null;
  const tuningSemitones = Math.atan2(tuningIm, tuningRe) / (2 * Math.PI);

  // Pasada 2: cada pico a su clase de altura, ya con la afinación corregida.
  const chroma = new Float64Array(12);
  const bass = new Float64Array(12);
  for (const peaks of framePeaksList) {
    const frameChroma = new Float64Array(12);
    const frameBass = new Float64Array(12);
    for (const peak of peaks) {
      const midi = 69 + 12 * Math.log2(peak.hz / 440) - tuningSemitones;
      const nearest = Math.round(midi);
      const deviation = midi - nearest;
      // Ventana coseno²: solo el pico que cae cerca del centro del semitono
      // aporta entero; uno a medio camino se reparte entre los dos vecinos.
      const w = Math.cos(Math.PI * deviation) ** 2;
      const pc = ((nearest % 12) + 12) % 12;
      frameChroma[pc] = frameChroma[pc]! + peak.amp * w;
      if (peak.hz < 220) frameBass[pc] = frameBass[pc]! + peak.amp * w;
    }
    let max = 0;
    for (let i = 0; i < 12; i++) if (frameChroma[i]! > max) max = frameChroma[i]!;
    if (max <= 0) continue;
    for (let i = 0; i < 12; i++) chroma[i] = chroma[i]! + frameChroma[i]! / max;
    let bassMax = 0;
    for (let i = 0; i < 12; i++) if (frameBass[i]! > bassMax) bassMax = frameBass[i]!;
    if (bassMax > 0) for (let i = 0; i < 12; i++) bass[i] = bass[i]! + frameBass[i]! / bassMax;
  }

  const norm = normalizeMax(chroma);
  const bassNorm = normalizeMax(bass);
  if (!norm) return null;

  return {
    chroma: norm,
    bass: bassNorm ?? new Float32Array(12),
    tuningSemitones,
    clarity: chromaClarity(norm),
  };
}

function normalizeMax(values: Float64Array): Float32Array | null {
  let max = 0;
  for (let i = 0; i < 12; i++) if (values[i]! > max) max = values[i]!;
  if (max <= 1e-12) return null;
  const out = new Float32Array(12);
  for (let i = 0; i < 12; i++) out[i] = values[i]! / max;
  return out;
}

/**
 * Claridad del croma: 1 menos la entropía normalizada. Un acorde tiene pocas
 * clases de altura con energía y sale alto; un ruido reparte la energía entre
 * las doce y sale bajo. No decide la tonalidad por sí sola, pero informa la
 * confianza: con un croma plano cualquier correlación es una casualidad.
 */
function chromaClarity(chroma: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i]!;
  if (sum <= 0) return 0;
  let entropy = 0;
  for (let i = 0; i < 12; i++) {
    const p = chroma[i]! / sum;
    if (p > 1e-9) entropy -= p * Math.log2(p);
  }
  return clamp01(1 - entropy / Math.log2(12));
}

/** Perfiles: índice 0 = tónica. */
const BGATE_MAJOR = [1.0, 0.0, 0.42, 0.0, 0.53, 0.37, 0.0, 0.77, 0.0, 0.38, 0.21, 0.30] as const;
const BGATE_MINOR = [1.0, 0.0, 0.36, 0.39, 0.0, 0.38, 0.0, 0.74, 0.27, 0.0, 0.42, 0.23] as const;
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] as const;
const TEMPERLEY_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0] as const;
const TEMPERLEY_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0] as const;

const PROFILE_WEIGHT = [0.55, 0.25, 0.2] as const;
const MAJOR_PROFILES = [BGATE_MAJOR, KK_MAJOR, TEMPERLEY_MAJOR] as const;
const MINOR_PROFILES = [BGATE_MINOR, KK_MINOR, TEMPERLEY_MINOR] as const;

/** Correlación de Pearson entre el croma y un perfil rotado a `root`. */
function correlate(chroma: Float32Array, profile: readonly number[], root: number): number {
  let cMean = 0;
  let pMean = 0;
  for (let i = 0; i < 12; i++) {
    cMean += chroma[i]!;
    pMean += profile[i]!;
  }
  cMean /= 12;
  pMean /= 12;
  let num = 0;
  let cVar = 0;
  let pVar = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(root + i) % 12]! - cMean;
    const p = profile[i]! - pMean;
    num += c * p;
    cVar += c * c;
    pVar += p * p;
  }
  const den = Math.sqrt(cVar * pVar);
  return den > 1e-12 ? num / den : 0;
}

/** Puntuación de una tonalidad: perfiles + evidencia del bajo y del modo. */
function keyScore(chroma: Float32Array, bass: Float32Array, root: number, mode: KeyMode): number {
  const profiles = mode === 'major' ? MAJOR_PROFILES : MINOR_PROFILES;
  let score = 0;
  for (let i = 0; i < profiles.length; i++) {
    score += PROFILE_WEIGHT[i]! * correlate(chroma, profiles[i]!, root);
  }

  // El bajo suele tocar la tónica. No manda —hay temas con pedal de dominante—
  // pero desempata los relativos, que comparten casi todas las notas.
  let bassSum = 0;
  for (let i = 0; i < 12; i++) bassSum += bass[i]!;
  if (bassSum > 1e-9) {
    const share = bass[root]! / bassSum;
    if (share > 1 / 12) score += 0.11 * clamp01((share - 1 / 12) / (1 - 1 / 12));
  }

  // La tercera (mayor o menor) es el otro discriminador de modo. Se usa la
  // diferencia contra la tercera rival, normalizada.
  const third = mode === 'major' ? (root + 4) % 12 : (root + 3) % 12;
  const rival = mode === 'major' ? (root + 3) % 12 : (root + 4) % 12;
  score += 0.045 * (chroma[third]! - chroma[rival]!);
  return score;
}

/** Notación Camelot (8A = La menor, 8B = Do mayor). */
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1] as const;
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10] as const;

export function camelotOf(root: number, mode: KeyMode): string {
  const n = mode === 'major' ? CAMELOT_MAJOR[root] : CAMELOT_MINOR[root];
  return `${n}${mode === 'major' ? 'B' : 'A'}`;
}

export function keyName(root: number, mode: KeyMode): string {
  return `${NOTE_NAMES[((root % 12) + 12) % 12]} ${KEY_MODE_LABELS[mode]}`;
}

/**
 * Corre las 24 tonalidades y devuelve la ganadora con sus alternativas.
 * `null` si el croma no correlaciona con nada (ruido, silencio, percusión).
 */
export function keyFromProfile(profile: TonalProfile): KeyEstimate | null {
  const { chroma, bass } = profile;
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i]!;
  if (total <= 0) return null;

  const ranked: { root: number; mode: KeyMode; score: number; correlation: number }[] = [];
  for (let root = 0; root < 12; root++) {
    for (const mode of ['major', 'minor'] as const) {
      const profiles = mode === 'major' ? MAJOR_PROFILES : MINOR_PROFILES;
      let correlation = 0;
      for (let i = 0; i < profiles.length; i++) correlation += PROFILE_WEIGHT[i]! * correlate(chroma, profiles[i]!, root);
      const score = keyScore(chroma, bass, root, mode);
      ranked.push({ root, mode, score, correlation });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0]!;
  if (!(best.score > 0.05)) return null;

  const second = ranked[1]!;
  const margin = best.score - second.score;
  // La tercera es lo que separa mayor de menor. Si no hay tercera (un 808
  // solo, un power chord), el modo es una conjetura del perfil y la confianza
  // no puede ser la misma que la de un acorde completo.
  const third = best.mode === 'major' ? (best.root + 4) % 12 : (best.root + 3) % 12;
  const rivalThird = best.mode === 'major' ? (best.root + 3) % 12 : (best.root + 4) % 12;
  const modeEvidence = clamp01((chroma[third]! - chroma[rivalThird]! + 0.1) / 0.5);
  const baseConfidence =
    0.52 * Math.max(0, best.correlation) +
    0.33 * clamp01(margin * 4) +
    0.15 * profile.clarity;
  const confidence = clamp01(baseConfidence * (0.55 + 0.45 * modeEvidence));

  const alternatives: KeyCandidate[] = [];
  for (const entry of ranked.slice(1, 7)) {
    const relative = best.score > 0 ? entry.score / best.score : 0;
    alternatives.push({
      root: entry.root,
      mode: entry.mode,
      name: keyName(entry.root, entry.mode),
      camelot: camelotOf(entry.root, entry.mode),
      confidence: clamp01(0.45 * Math.max(0, entry.correlation) * clamp01(relative)),
      score: entry.score,
    });
  }

  return {
    root: best.root,
    mode: best.mode,
    name: keyName(best.root, best.mode),
    camelot: camelotOf(best.root, best.mode),
    confidence,
    tuningCents: profile.tuningSemitones * 100,
    alternatives,
  };
}

/**
 * Croma de 12 bins (índice 0 = Do), normalizado a máximo 1.
 *
 * Es la función que usa el browser para clasificar muestras; `detectKey` es la
 * que decide la tonalidad. Se separan para poder testear el croma solo.
 */
export function chromagram(pcm: Float32Array, sampleRate: number, opts: ChromaOptions = {}): Float32Array {
  const profile = tonalProfile(pcm, sampleRate, opts);
  return profile?.chroma ?? new Float32Array(12);
}

/** Estima la tonalidad de un PCM mono. */
export function detectKey(pcm: Float32Array, sampleRate: number, opts: ChromaOptions = {}): KeyEstimate | null {
  const profile = tonalProfile(pcm, sampleRate, opts);
  return profile ? keyFromProfile(profile) : null;
}
