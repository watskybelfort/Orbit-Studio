/**
 * Utilidades de señal del analizador: mezcla a mono, remuestreo con
 * antialiasing y elección de las ventanas que se analizan.
 *
 * El analizador trabaja SIEMPRE a 22.05 kHz. No es una limitación: es lo que
 * hace que un tema de cinco minutos se analice en un par de segundos sin
 * perder nada que importe. El tempo vive por debajo de 40 Hz (los onsets) y la
 * tonalidad por debajo de 4 kHz (los armónicos que definen una nota), así que
 * muestrear a 22 kHz deja margen de sobra y evita pagar 48k por segundo de FFT.
 */

import { Biquad } from '../dsp/filters';

/** Frecuencia de análisis. Coincide con la de los analizadores de referencia. */
export const ANALYSIS_RATE = 22050;

/** Mezcla estéreo a mono. Si no hay canal derecho, devuelve el izquierdo. */
export function mixToMono(left: Float32Array, right?: Float32Array): Float32Array {
  if (!right) return left;
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

/**
 * Baja la señal a `targetRate` con un pasa-bajos de cuarto orden antes de
 * interpolar. Sin el filtro, todo lo que pase de Nyquist se pliega hacia
 * dentro y ensucia el croma con armónicos que no existen.
 *
 * La interpolación es lineal: a 22 kHz y con el filtro previo, el error de
 * amplitud en las frecuencias que nos importan es despreciable frente al ruido
 * de la propia grabación.
 */
export function resampleMono(
  mono: Float32Array,
  sampleRate: number,
  targetRate = ANALYSIS_RATE,
): { pcm: Float32Array; sampleRate: number } {
  if (!(sampleRate > 0) || mono.length === 0) {
    return { pcm: mono, sampleRate: Math.max(1, sampleRate) };
  }
  if (sampleRate <= targetRate * 1.01) return { pcm: mono, sampleRate };

  // Dos biquads en cascada a 0.45·target: cuarto orden, -24 dB en Nyquist.
  const cutoff = targetRate * 0.45;
  const lp1 = new Biquad();
  const lp2 = new Biquad();
  lp1.lowpass(cutoff, 0.707, sampleRate);
  lp2.lowpass(cutoff, 0.707, sampleRate);

  const ratio = targetRate / sampleRate;
  const outLen = Math.max(1, Math.floor(mono.length * ratio));
  const out = new Float32Array(outLen);
  const step = 1 / ratio;

  let prev = 0;
  let outIndex = 0;
  // Posición (en muestras de entrada) del próximo valor de salida.
  let position = 0;
  for (let i = 0; i < mono.length; i++) {
    const filtered = lp2.tick(lp1.tick(mono[i]!));
    // La primera muestra no tiene "anterior"; se usa ella misma.
    if (i === 0) prev = filtered;
    while (outIndex < outLen && position <= i) {
      const base = Math.floor(position);
      const frac = position - base;
      // `base` es i-1 o i porque position avanza con el bucle.
      const a = base >= i ? filtered : prev;
      const b = filtered;
      out[outIndex] = a + (b - a) * (base >= i ? 0 : frac);
      outIndex++;
      position += step;
    }
    prev = filtered;
    if (outIndex >= outLen) break;
  }
  // Cola por si el redondeo dejó las últimas una o dos muestras sin escribir.
  while (outIndex < outLen) {
    out[outIndex] = prev;
    outIndex++;
  }
  return { pcm: out, sampleRate: targetRate };
}

/** Pico absoluto de la señal. */
export function peakOf(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]!);
    if (v > peak) peak = v;
  }
  return peak;
}

/** RMS en dBFS. `-Infinity` para silencio digital. */
export function rmsDb(pcm: Float32Array): number {
  if (pcm.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i]! * pcm[i]!;
  const rms = Math.sqrt(sum / pcm.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/**
 * Elige `count` ventanas repartidas por el tema, evitando los extremos.
 *
 * Un tema suele tener intro y outro con menos información; analizar solo el
 * principio es la forma más fácil de sacar un tempo que no es el del cuerpo
 * del tema. Estas ventanas cubren el 12 %, el centro y el 78 % de la duración
 * cuando el archivo es largo, y el archivo entero cuando no lo es.
 */
export function analysisWindows(
  durationSec: number,
  budgetSec: number,
  count = 3,
): { startSec: number; endSec: number }[] {
  if (!(durationSec > 0) || !(budgetSec > 0)) return [];
  if (durationSec <= budgetSec) return [{ startSec: 0, endSec: durationSec }];

  const n = Math.max(1, Math.min(count, Math.floor(durationSec / 8)));
  const windowSec = budgetSec / n;
  const centres = n === 1 ? [0.5] : [0.18, 0.5, 0.82].slice(0, n);
  const out: { startSec: number; endSec: number }[] = [];
  for (const centre of centres) {
    const start = Math.max(0, Math.min(durationSec - windowSec, durationSec * centre - windowSec / 2));
    out.push({ startSec: start, endSec: start + windowSec });
  }
  return out;
}

/** Copia una ventana temporal a un array nuevo. */
export function sliceWindow(pcm: Float32Array, sampleRate: number, startSec: number, endSec: number): Float32Array {
  const a = Math.max(0, Math.min(pcm.length, Math.floor(startSec * sampleRate)));
  const b = Math.max(a, Math.min(pcm.length, Math.ceil(endSec * sampleRate)));
  return pcm.slice(a, b);
}

/** Ventana de Hann cacheada por tamaño (el analizador usa dos o tres tamaños). */
const hannCache = new Map<number, Float32Array>();

export function hannWindow(size: number): Float32Array {
  const hit = hannCache.get(size);
  if (hit) return hit;
  const win = new Float32Array(size);
  const denom = Math.max(1, size - 1);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  hannCache.set(size, win);
  return win;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
