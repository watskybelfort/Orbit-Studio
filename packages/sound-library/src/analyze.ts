/**
 * Análisis automático de samples: BPM y tonalidad.
 *
 * Esta capa es la FACHADA de compatibilidad del analizador del motor
 * (`@orbit/engine`). El DSP vive allí porque lo usan los dos: el browser para
 * indexar miles de archivos y la playlist para analizar un tema entero. Aquí
 * se mantienen los nombres y la forma de siempre (`detectBpm`, `detectKey`,
 * `chromagram`, `analyzeSample`) para no romper a quien ya los llamaba.
 *
 * Todo devuelve `null`/campos vacíos cuando la señal no da para una estimación
 * honesta (silencio, audio demasiado corto, un one-shot sin pulso, nada tonal):
 * mejor no rellenar el campo que rellenarlo mal.
 */

import {
  chromagram as engineChromagram,
  detectKey as engineDetectKey,
  estimateTempo,
  KEY_MODE_LABELS,
  NOTE_NAMES,
  onsetEnvelope as engineOnsetEnvelope,
  type KeyMode,
  type NoteName,
} from '@orbit/engine';

export { KEY_MODE_LABELS, NOTE_NAMES };
export type { KeyMode, NoteName };

export interface OnsetEnvelope {
  /** Fuerza de onset por frame. */
  values: Float32Array;
  /** Frames por segundo. */
  rate: number;
}

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
  /** Rango de búsqueda del tempo (por defecto 40–220). */
  minBpm?: number;
  maxBpm?: number;
  /** Segundos de audio que se analizan como máximo (por defecto 30). */
  maxSeconds?: number;
  /** Umbral de confianza para aceptar el BPM (por defecto 0.3). */
  minBpmConfidence?: number;
  /** Umbral de confianza para aceptar la tonalidad (por defecto 0.34). */
  minKeyConfidence?: number;
  /**
   * Bonificar los tempos que cuadran el archivo entero en compases enteros de
   * 4/4 (por defecto sí, cuando se analiza el archivo completo y dura ≤ 32 s).
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

/** Mezcla a mono dos canales (helper para quien venga de un AudioBuffer). */
export function toMono(left: Float32Array, right?: Float32Array): Float32Array {
  if (!right) return left;
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

/**
 * Envolvente de onsets con la forma de siempre (`values` + `rate`), calculada
 * por el analizador del motor. Se mantiene el hop de 256 muestras porque hay
 * consumidores y tests que cuentan frames con esa rejilla.
 */
export function onsetEnvelope(
  pcm: Float32Array,
  sampleRate: number,
): { values: Float32Array; rate: number } {
  const env = engineOnsetEnvelope(pcm, sampleRate, { hop: 256, fftSize: 1024 });
  return { values: env.values, rate: env.rate };
}

/** Croma de 12 bins (Do..Si), normalizado a máximo 1. */
export function chromagram(pcm: Float32Array, sampleRate: number): Float32Array {
  return engineChromagram(pcm, sampleRate);
}

/**
 * Estima el tempo de un sample. `maxSeconds` recorta el audio (el detector de
 * temas usa su propia ventana; esto es el comportamiento de siempre para un
 * archivo de la librería).
 */
export function detectBpm(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): BpmEstimate | null {
  const max = Math.max(1, opts.maxSeconds ?? 30);
  const len = Math.min(pcm.length, Math.floor(max * sampleRate));
  const audio = len < pcm.length ? pcm.subarray(0, len) : pcm;
  const tempo = estimateTempo(audio, sampleRate, {
    minBpm: opts.minBpm,
    maxBpm: opts.maxBpm,
    barPrior: opts.barPrior !== false && len === pcm.length,
    maxTempoSeconds: max,
  });
  if (!tempo) return null;
  return { bpm: tempo.bpm, confidence: tempo.confidence };
}

/** Estima la tonalidad (nota raíz + modo) de un sample. */
export function detectKey(
  pcm: Float32Array,
  sampleRate: number,
  opts: AnalyzeOptions = {},
): KeyEstimate | null {
  const max = Math.max(1, opts.maxSeconds ?? 30);
  const len = Math.min(pcm.length, Math.floor(max * sampleRate));
  const audio = len < pcm.length ? pcm.subarray(0, len) : pcm;
  const key = engineDetectKey(audio, sampleRate);
  if (!key) return null;
  return {
    keyRoot: NOTE_NAMES[key.root]!,
    mode: key.mode,
    confidence: key.confidence,
  };
}

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
  const maxSec = Math.max(1, opts.maxSeconds ?? 30);
  const tempo = estimateTempo(pcm, sampleRate, {
    minBpm: opts.minBpm,
    maxBpm: opts.maxBpm,
    barPrior: opts.barPrior !== false && pcm.length <= maxSec * sampleRate,
    maxTempoSeconds: maxSec,
  });
  const minBpmConf = opts.minBpmConfidence ?? 0.3;
  if (tempo && tempo.confidence >= minBpmConf) {
    out.bpm = Math.round(tempo.bpm);
    out.bpmConfidence = tempo.confidence;
  }
  const key = engineDetectKey(pcm.subarray(0, Math.min(pcm.length, Math.floor(maxSec * sampleRate))), sampleRate);
  const minKeyConf = opts.minKeyConfidence ?? 0.34;
  if (key && key.confidence >= minKeyConf) {
    out.keyRoot = NOTE_NAMES[key.root]!;
    out.mode = key.mode;
    out.keyConfidence = key.confidence;
  }
  return out;
}
