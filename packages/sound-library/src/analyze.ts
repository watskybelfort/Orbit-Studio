/**
 * Análisis automático de samples: BPM y tonalidad.
 *
 * Funciones PURAS sobre PCM mono (`Float32Array` + `sampleRate`), sin DOM ni
 * Electron: sirven igual en el renderer (al indexar las carpetas del usuario)
 * que en un script Node o en los tests.
 *
 * - BPM: envolvente de onsets por flujo espectral en tres bandas →
 *   autocorrelación normalizada → puntuación por armónicos del pulso con prior
 *   log-normal centrado en 120 BPM (así se resuelve la ambigüedad de octava:
 *   60 vs 120 vs 240) y desempate por cuadre en compases enteros.
 * - Tonalidad: croma de 12 bins a partir de los picos del espectro (con
 *   interpolación parabólica de la frecuencia) → correlación de Pearson con los
 *   perfiles mayor/menor de Krumhansl-Kessler en las 24 rotaciones.
 *
 * Todo devuelve `null` cuando la señal no da para una estimación honesta
 * (silencio, audio demasiado corto, un one-shot sin pulso, nada tonal): mejor
 * no rellenar el campo que rellenarlo mal.
 */

import { getFft, hannWindow } from './fft';

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Nombres de nota con sostenidos, igual que el `keyRoot` del manifest. */
export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export type NoteName = (typeof NOTE_NAMES)[number];

export type KeyMode = 'major' | 'minor';

/** Etiquetas visibles (español) del modo. */
export const KEY_MODE_LABELS: Record<KeyMode, string> = {
  major: 'mayor',
  minor: 'menor',
};

export interface BpmEstimate {
  /** Tempo estimado en pulsos por minuto. */
  bpm: number;
  /** 0..1 — autocorrelación normalizada en el lag elegido. */
  confidence: number;
}

export interface KeyEstimate {
  /** Nota raíz, ej. "F#". */
  keyRoot: NoteName;
  mode: KeyMode;
  /** 0..1 — mezcla de la correlación y del margen sobre la raíz rival. */
  confidence: number;
}

export interface AnalyzeOptions {
  /** Rango de búsqueda del tempo (por defecto 60–200). */
  minBpm?: number;
  maxBpm?: number;
  /** Segundos de audio que se analizan como máximo (por defecto 30). */
  maxSeconds?: number;
  /** Umbral de confianza para aceptar el BPM (por defecto 0.18). */
  minBpmConfidence?: number;
  /** Umbral de confianza para aceptar la tonalidad (por defecto 0.3). */
  minKeyConfidence?: number;
  /**
   * Bonificar los tempos que cuadran el archivo en compases enteros de 4/4
   * (por defecto sí, cuando se analiza el archivo completo y dura ≤ 30 s).
   */
  barPrior?: boolean;
}

/** Resultado combinado, ya filtrado por confianza. */
export interface SampleAnalysis {
  bpm?: number;
  bpmConfidence?: number;
  keyRoot?: NoteName;
  mode?: KeyMode;
  keyConfidence?: number;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Recorta a los primeros `maxSeconds` (el análisis no necesita el archivo entero). */
function head(pcm: Float32Array, sampleRate: number, maxSeconds: number): Float32Array {
  const max = Math.floor(maxSeconds * sampleRate);
  return pcm.length > max ? pcm.subarray(0, max) : pcm;
}

/** Pico absoluto: sirve para descartar silencio antes de gastar FFTs. */
function peak(pcm: Float32Array): number {
  let p = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]!);
    if (v > p) p = v;
  }
  return p;
}

/** Mezcla a mono dos canales (helper para quien venga de un AudioBuffer). */
export function toMono(left: Float32Array, right?: Float32Array): Float32Array {
  if (!right) return left;
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

// ── Envolvente de onsets ─────────────────────────────────────────────────────

const ONSET_FFT = 1024;
const ONSET_HOP = 256;

/**
 * Bandas del flujo espectral y su peso. Se separan porque, si no, un hi-hat en
 * corcheas constantes tapa al bombo y la caja y el detector se queda con el
 * tatum en vez del pulso. Cada banda se normaliza por su propia media antes de
 * mezclarse, así manda la REGULARIDAD y no el nivel.
 */
const ONSET_BAND_HZ = [0, 220, 2200, Infinity];
const ONSET_BAND_WEIGHT = [1, 1, 0.45];

export interface OnsetEnvelope {
  /** Fuerza de onset por frame (>= 0). */
  values: Float32Array;
  /** Frames por segundo de la envolvente. */
  rate: number;
}

/**
 * Envolvente de onsets por flujo espectral en tres bandas con compresión
 * logarítmica: para cada frame, suma de los aumentos de energía por bin
 * respecto al frame anterior. Después se le resta la media móvil (~0.35 s) y
 * se rectifica, que es lo que deja los golpes limpios para la autocorrelación.
 */
export function onsetEnvelope(pcm: Float32Array, sampleRate: number): OnsetEnvelope {
  const fft = getFft(ONSET_FFT);
  const win = hannWindow(ONSET_FFT);
  const re = new Float64Array(ONSET_FFT);
  const im = new Float64Array(ONSET_FFT);
  const bins = ONSET_FFT / 2;
  const prev = new Float64Array(bins);
  const frames = Math.max(0, Math.floor((pcm.length - ONSET_FFT) / ONSET_HOP) + 1);
  const nBands = ONSET_BAND_WEIGHT.length;
  const hzPerBin = sampleRate / ONSET_FFT;
  /** Banda de cada bin (se calcula una vez). */
  const bandOf = new Uint8Array(bins);
  for (let k = 0; k < bins; k++) {
    const hz = k * hzPerBin;
    let b = nBands - 1;
    for (let i = 0; i < nBands; i++) {
      if (hz < ONSET_BAND_HZ[i + 1]!) {
        b = i;
        break;
      }
    }
    bandOf[k] = b;
  }

  const flux: Float32Array[] = [];
  for (let b = 0; b < nBands; b++) flux.push(new Float32Array(Math.max(0, frames)));
  const acc = new Float64Array(nBands);

  for (let f = 0; f < frames; f++) {
    const off = f * ONSET_HOP;
    for (let i = 0; i < ONSET_FFT; i++) {
      re[i] = pcm[off + i]! * win[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    acc.fill(0);
    for (let k = 0; k < bins; k++) {
      const mag = Math.log1p(20 * Math.hypot(re[k]!, im[k]!));
      const d = mag - prev[k]!;
      if (d > 0) acc[bandOf[k]!] = acc[bandOf[k]!]! + d;
      prev[k] = mag;
    }
    for (let b = 0; b < nBands; b++) flux[b]![f] = acc[b]!;
  }

  // Normalización por banda + mezcla ponderada.
  const mixed = new Float32Array(Math.max(0, frames));
  for (let b = 0; b < nBands; b++) {
    const band = flux[b]!;
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += band[f]!;
    mean /= Math.max(1, frames);
    if (mean <= 1e-9) continue;
    const w = ONSET_BAND_WEIGHT[b]! / mean;
    for (let f = 0; f < frames; f++) mixed[f] = mixed[f]! + band[f]! * w;
  }

  // Media móvil y rectificado: quita la deriva de nivel y deja solo los picos.
  const rate = sampleRate / ONSET_HOP;
  const halfWin = Math.max(1, Math.round(0.35 * rate * 0.5));
  const rect = new Float32Array(mixed.length);
  for (let f = 0; f < mixed.length; f++) {
    const a = Math.max(0, f - halfWin);
    const b = Math.min(mixed.length - 1, f + halfWin);
    let mean = 0;
    for (let i = a; i <= b; i++) mean += mixed[i]!;
    mean /= b - a + 1;
    const v = mixed[f]! - mean;
    rect[f] = v > 0 ? v : 0;
  }

  // Suavizado gaussiano corto (~9 ms): los picos del flujo son de 1–2 frames y
  // un periodo fraccionario (ej. 55,5 frames) descorrelacionaba de más. Con el
  // pico algo más ancho la autocorrelación es honesta a cualquier lag.
  const out = new Float32Array(rect.length);
  for (let f = 0; f < rect.length; f++) {
    let sum = 0;
    for (let k = -SMOOTH_RADIUS; k <= SMOOTH_RADIUS; k++) {
      const i = f + k;
      if (i < 0 || i >= rect.length) continue;
      sum += rect[i]! * SMOOTH_KERNEL[k + SMOOTH_RADIUS]!;
    }
    out[f] = sum;
  }
  return { values: out, rate };
}

/** Núcleo gaussiano normalizado del suavizado de la envolvente. */
const SMOOTH_RADIUS = 4;
const SMOOTH_KERNEL = (() => {
  const sigma = 1.5;
  const k = new Float64Array(SMOOTH_RADIUS * 2 + 1);
  let sum = 0;
  for (let i = -SMOOTH_RADIUS; i <= SMOOTH_RADIUS; i++) {
    const v = Math.exp((-0.5 * i * i) / (sigma * sigma));
    k[i + SMOOTH_RADIUS] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] = k[i]! / sum;
  return k;
})();

// ── BPM ──────────────────────────────────────────────────────────────────────

/**
 * Refuerzos del pulso: múltiplos del lag (2·, 3·, 4·) que confirman el
 * candidato. El 3 pesa poco porque solo aparece en compases ternarios.
 */
const PULSE_HARMONICS: readonly (readonly [number, number])[] = [
  [2, 0.5],
  [3, 0.2],
  [4, 0.25],
];
/** Centro y anchura (en octavas) del prior de tempo. */
const TEMPO_CENTER = 120;
const TEMPO_SIGMA_OCT = 0.7;

/** Compases completos que se consideran "duración de loop" (4/4). */
const LOOP_BARS = [1, 2, 4, 8, 16];
/** Cuánto sube la puntuación un tempo que cuadra el archivo en compases enteros. */
const LOOP_BONUS = 0.6;
/** Tolerancia del cuadre, en compases. */
const LOOP_TOL_BARS = 0.02;
/** Por encima de esta duración ya no tiene sentido suponer que es un loop. */
const LOOP_MAX_SEC = 30;
/** Cuánto puede bajar un candidato respecto a la cresta local y seguir compitiendo. */
const PEAK_PLATEAU = 0.95;
/** Ataques mínimos para hablar de tempo (un one-shot no tiene pulso). */
const MIN_ATTACKS = 4;

/**
 * Cuenta ataques en la envolvente con periodo refractario: un golpe deja
 * varios frames activos y lo que interesa es cuántos arranques hay. Sirve de
 * portero del BPM — un 808 suelto o una cola de reverb no tienen pulso y su
 * autocorrelación, aun así, saca lags con correlación alta.
 */
function countAttacks(env: Float32Array, rate: number): number {
  let max = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > max) max = env[i]!;
  if (max <= 0) return 0;
  const umbral = max * 0.2;
  const refract = Math.max(1, Math.round(0.12 * rate));
  let n = 0;
  let bloqueoHasta = -1;
  for (let i = 0; i < env.length; i++) {
    if (i > bloqueoHasta && env[i]! > umbral) {
      n++;
      bloqueoHasta = i + refract;
    }
  }
  return n;
}

/**
 * Bonificación por cuadrar el archivo en un número entero de compases de 4/4.
 * La librería de un productor son casi todo loops de 1/2/4/8 compases, y en
 * material sostenido (pads, riffs con reverb) la autocorrelación da un pico
 * ancho donde el tempo real y uno vecino puntúan casi igual: este cuadre es
 * el que desempata bien. Vale 1 (sin bonus) cuando no cuadra.
 */
function loopBarFit(bpm: number, durationSec: number): number {
  const bars = (durationSec * bpm) / 60 / 4;
  let best = 0;
  for (const b of LOOP_BARS) {
    const d = Math.abs(bars - b) / LOOP_TOL_BARS;
    const fit = Math.exp(-0.5 * d * d);
    if (fit > best) best = fit;
  }
  return 1 + LOOP_BONUS * best;
}

/**
 * Estima el tempo por autocorrelación normalizada de la envolvente de onsets.
 *
 * La autocorrelación se normaliza por la energía de los dos tramos que se
 * comparan (correlación cruzada normalizada), así el valor cae en 0..1 y sirve
 * directamente como confianza. La ambigüedad de octava se resuelve puntuando
 * cada candidato con sus armónicos y pesando con un prior log-normal centrado
 * en 120 BPM; y si el archivo entero cabe en compases enteros, ese cuadre
 * bonifica al candidato (ver `loopBarFit`).
 */
export function detectBpm(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): BpmEstimate | null {
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const audio = head(pcm, sampleRate, opts.maxSeconds ?? 30);
  // Con menos de dos ciclos del tempo más lento no hay nada que autocorrelar.
  if (audio.length < sampleRate * 1.5 || peak(audio) < 1e-4) return null;

  const { values: env, rate } = onsetEnvelope(audio, sampleRate);
  // Sin unos cuantos ataques no hay pulso que medir: one-shots, notas sueltas
  // y colas de reverb salen sin BPM en vez de con uno inventado.
  if (countAttacks(env, rate) < MIN_ATTACKS) return null;
  const n = env.length;
  // Un periodo del tempo más lento: llegar más lejos deja que los candidatos
  // graves acumulen múltiplos y todo el rango rápido se lee a la mitad.
  const maxLag = Math.min(n - 2, Math.ceil((60 / minBpm) * rate) + 2);
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * rate) - 1);
  if (maxLag <= minLag + 1) return null;

  // Sumas acumuladas de e² para normalizar cada lag en O(1).
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i]! + env[i]! * env[i]!;
  if (cum[n]! <= 0) return null;

  const acf = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const len = n - lag;
    let dot = 0;
    for (let i = 0; i < len; i++) dot += env[i]! * env[i + lag]!;
    const ea = cum[len]! - cum[0]!;
    const eb = cum[n]! - cum[lag]!;
    const den = Math.sqrt(ea * eb);
    acf[lag] = den > 1e-12 ? dot / den : 0;
  }

  /** Autocorrelación en un lag fraccionario (interpolación lineal). */
  const acfAt = (lag: number): number => {
    if (lag < minLag || lag > maxLag - 1) return 0;
    const i = Math.floor(lag);
    const t = lag - i;
    return acf[i]! * (1 - t) + acf[i + 1]! * t;
  };

  // El cuadre por compases solo se aplica si estamos viendo el archivo entero
  // (si se recortó por `maxSeconds` la duración ya no significa nada).
  const durationSec = audio.length / sampleRate;
  const useLoopFit =
    opts.barPrior !== false && audio.length === pcm.length && durationSec <= LOOP_MAX_SEC;

  // Rejilla fina: el error de cuantización del lag entero se nota en el tempo.
  const step = 0.05;
  const grid = Math.round((maxBpm - minBpm) / step) + 1;
  const score = new Float64Array(grid);
  for (let g = 0; g < grid; g++) {
    const bpm = minBpm + g * step;
    const lag = (60 / bpm) * rate;
    // El fundamental MULTIPLICA: sin pico en su propio lag no hay tempo que
    // valga (si no, un candidato al doble se colaba solo con sus múltiplos).
    const base = acfAt(lag);
    if (base <= 0) continue;
    let refuerzo = 1;
    for (const [m, w] of PULSE_HARMONICS) {
      const l = lag * m;
      if (l > maxLag - 1) break;
      refuerzo += w * acfAt(l);
    }
    const oct = Math.log2(bpm / TEMPO_CENTER) / TEMPO_SIGMA_OCT;
    score[g] = base * refuerzo * Math.exp(-0.5 * oct * oct);
  }

  // Solo compiten los tempos que son CRESTA de la curva en un entorno del
  // ±1,5 % (o quedan a menos de un 2 % de la cresta, que es la meseta ancha de
  // los loops sostenidos). Así el cuadre por compases desempata entre tempos
  // igual de plausibles y nunca arrastra uno bueno hacia un vecino que, por
  // casualidad, cuadra el archivo en compases.
  let bestBpm = 0;
  let bestScore = -Infinity;
  for (let g = 0; g < grid; g++) {
    const s = score[g]!;
    if (s <= 0) continue;
    const bpm = minBpm + g * step;
    const win = Math.max(1, Math.round((bpm * 0.015) / step));
    let vecinoMax = 0;
    for (let j = Math.max(0, g - win); j <= Math.min(grid - 1, g + win); j++) {
      if (score[j]! > vecinoMax) vecinoMax = score[j]!;
    }
    if (s < vecinoMax * PEAK_PLATEAU) continue;
    const val = useLoopFit ? s * loopBarFit(bpm, durationSec) : s;
    if (val > bestScore) {
      bestScore = val;
      bestBpm = bpm;
    }
  }
  if (bestBpm === 0) return null;

  const confidence = clamp01(acfAt((60 / bestBpm) * rate));
  return { bpm: Math.round(bestBpm * 100) / 100, confidence };
}

// ── Croma y tonalidad ────────────────────────────────────────────────────────

/** Ventana máxima del croma (~0,37 s a 44,1 kHz): resuelve el sub de un 808. */
const CHROMA_FFT_MAX = 16384;
/** Ventana mínima: por debajo no hay resolución ni para el registro medio. */
const CHROMA_FFT_MIN = 4096;
/**
 * Rango útil del croma: desde B0 (~31 Hz) porque un 808 en C1 tiene ahí su
 * fundamental — y es esa nota, no su tercer armónico, la que da la tonalidad.
 */
const CHROMA_MIN_HZ = 30;
const CHROMA_MAX_HZ = 2100;

/** Mayor potencia de dos ≤ n, acotada al rango de ventanas del croma. */
function chromaFftSize(n: number): number {
  let size = CHROMA_FFT_MIN;
  while (size * 2 <= Math.min(n, CHROMA_FFT_MAX)) size *= 2;
  return size;
}

/**
 * Croma de 12 bins (C..B), normalizado a máximo 1.
 *
 * Solo se acumulan los picos del espectro (máximos locales por encima de un
 * umbral relativo al frame), con la frecuencia refinada por interpolación
 * parabólica y un peso coseno² según lo lejos que caiga del centro del
 * semitono: así los lóbulos de la ventana no reparten energía a notas vecinas.
 *
 * La ventana se adapta a la duración (hasta 16384): con 4096 el sub de un 808
 * queda enterrado en la fuga espectral y el detector se quedaba con la quinta.
 */
export function chromagram(pcm: Float32Array, sampleRate: number): Float32Array {
  const chroma = new Float32Array(12);
  const size = chromaFftSize(pcm.length);
  const hop = size / 2;
  const fft = getFft(size);
  const win = hannWindow(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const bins = size / 2;
  const mag = new Float64Array(bins);
  const hzPerBin = sampleRate / size;
  const kMin = Math.max(1, Math.floor(CHROMA_MIN_HZ / hzPerBin));
  const kMax = Math.min(bins - 2, Math.ceil(CHROMA_MAX_HZ / hzPerBin));
  const frames = Math.floor((pcm.length - size) / hop) + 1;

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = pcm[off + i]! * win[i]!;
      im[i] = 0;
    }
    fft.transform(re, im);
    let frameMax = 0;
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(re[k]!, im[k]!);
      mag[k] = m;
      if (m > frameMax) frameMax = m;
    }
    if (frameMax <= 1e-9) continue;
    const floorMag = frameMax * 0.01;

    for (let k = kMin; k <= kMax; k++) {
      const m = mag[k]!;
      if (m < floorMag) continue;
      const l = mag[k - 1]!;
      const r = mag[k + 1]!;
      if (m < l || m < r) continue; // solo máximos locales
      // Interpolación parabólica del vértice → frecuencia sub-bin.
      const den = l - 2 * m + r;
      const delta = den !== 0 ? (0.5 * (l - r)) / den : 0;
      const hz = (k + Math.max(-0.5, Math.min(0.5, delta))) * hzPerBin;
      if (hz < CHROMA_MIN_HZ || hz > CHROMA_MAX_HZ) continue;
      const midi = 69 + 12 * Math.log2(hz / 440);
      const nearest = Math.round(midi);
      const dev = midi - nearest;
      const w = Math.cos(Math.PI * dev) ** 2;
      const pc = ((nearest % 12) + 12) % 12;
      chroma[pc] = chroma[pc]! + m * w;
    }
  }

  let max = 0;
  for (let i = 0; i < 12; i++) if (chroma[i]! > max) max = chroma[i]!;
  if (max > 0) for (let i = 0; i < 12; i++) chroma[i] = chroma[i]! / max;
  return chroma;
}

/** Perfiles de Krumhansl-Kessler (tónica en el índice 0). */
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

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

/**
 * Estima la tonalidad (nota raíz + modo) correlando el croma con los 24
 * perfiles de Krumhansl. La confianza mezcla la correlación ganadora con el
 * margen sobre la mejor rival de OTRA raíz (el relativo mayor/menor comparte
 * casi todas las notas, así que si la pelea está reñida hay que decirlo).
 */
export function detectKey(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): KeyEstimate | null {
  const audio = head(pcm, sampleRate, opts.maxSeconds ?? 30);
  if (audio.length < CHROMA_FFT_MIN || peak(audio) < 1e-4) return null;

  const chroma = chromagram(audio, sampleRate);
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i]!;
  if (total <= 0) return null;

  let bestR = -Infinity;
  let bestRoot = 0;
  let bestMode: KeyMode = 'major';
  const byRoot = new Float64Array(12).fill(-Infinity);
  for (let root = 0; root < 12; root++) {
    const rMaj = correlate(chroma, KS_MAJOR, root);
    const rMin = correlate(chroma, KS_MINOR, root);
    const best = Math.max(rMaj, rMin);
    byRoot[root] = best;
    if (best > bestR) {
      bestR = best;
      bestRoot = root;
      bestMode = rMaj >= rMin ? 'major' : 'minor';
    }
  }
  if (!Number.isFinite(bestR) || bestR <= 0) return null;

  let rival = -Infinity;
  for (let root = 0; root < 12; root++) {
    if (root !== bestRoot && byRoot[root]! > rival) rival = byRoot[root]!;
  }
  const margin = clamp01((bestR - Math.max(0, rival)) * 3);
  const confidence = clamp01(0.5 * clamp01(bestR) + 0.5 * margin);

  return { keyRoot: NOTE_NAMES[bestRoot]!, mode: bestMode, confidence };
}

// ── Fachada ──────────────────────────────────────────────────────────────────

/**
 * BPM + tonalidad de un sample, ya filtrados por confianza. Los campos que no
 * llegan al umbral simplemente no vienen: quien llame rellena solo lo que
 * tiene, nunca inventa.
 */
export function analyzeSample(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): SampleAnalysis {
  const out: SampleAnalysis = {};
  const minBpmConf = opts.minBpmConfidence ?? 0.18;
  const minKeyConf = opts.minKeyConfidence ?? 0.3;

  const bpm = detectBpm(pcm, sampleRate, opts);
  if (bpm && bpm.confidence >= minBpmConf) {
    out.bpm = Math.round(bpm.bpm);
    out.bpmConfidence = bpm.confidence;
  }
  const key = detectKey(pcm, sampleRate, opts);
  if (key && key.confidence >= minKeyConf) {
    out.keyRoot = key.keyRoot;
    out.mode = key.mode;
    out.keyConfidence = key.confidence;
  }
  return out;
}
