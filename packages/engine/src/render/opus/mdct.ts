/**
 * MDCT con la ventana de CELT.
 *
 * La MDCT es lo que hace que un códec por transformada no suene a bloques. La
 * clave es que **saca la mitad de coeficientes que muestras entra**: 2N dentro,
 * N fuera. Eso, por sí solo, sería pérdida de información — y lo es: al volver
 * aparece un reflejo (aliasing) en cada extremo del bloque. Lo que salva la
 * jugada es que el reflejo del bloque siguiente es **exactamente el opuesto**,
 * así que al solapar y sumar se cancelan. Se llama TDAC, y es la propiedad que
 * comprueba el test: sin ella no hay reconstrucción y todo lo de arriba sobra.
 *
 * Para que TDAC funcione la ventana tiene que cumplir Princen-Bradley
 * (`w[n]² + w[n+N]² = 1`). La de CELT la cumple, y además es de **solape corto**:
 * en vez de subir a lo largo de media trama, sube en `overlap` muestras y el
 * resto va plano. Eso reduce el pre-eco sin pagar más latencia.
 *
 * ## Sobre la velocidad
 *
 * La definición directa es O(N²): 960 puntos son 1,8 millones de multiplicaciones
 * por trama y canal — un tema de tres minutos serían horas. Aquí se calcula con
 * FFT, reescribiendo la MDCT como una DCT-IV y ésta como una FFT compleja de 2N.
 *
 * **Esto no es lo óptimo y se dice a propósito**: libopus usa una FFT de N/4,
 * ocho veces menos trabajo. La de 2N sale de una derivación de cuatro líneas que
 * se puede comprobar a ojo, y la versión rápida de verdad es un cambio local que
 * ya tiene su red de seguridad — `mdctNaive` está en el test comparando coeficiente
 * a coeficiente. Primero correcto, luego rápido, y con quién lo vigile.
 */

import { fft } from './fft';

/** Tamaños de trama de Opus a 48 kHz (2,5 / 5 / 10 / 20 ms). */
export const OPUS_FRAME_SIZES = [120, 240, 480, 960] as const;

/**
 * Ventana de CELT: `sin(π/2 · sin²(π/2 · (i+0.5)/L))`, sobre `L` muestras.
 *
 * La doble seno no es adorno. Hace que `w[i]² + w[L-1-i]² = 1` exacto, que es
 * Princen-Bradley, que es TDAC. Con una ventana cualquiera —una Hann, por
 * ejemplo— el aliasing no se cancela y la señal vuelve sucia.
 */
export function celtWindow(overlap: number): Float64Array {
  const w = new Float64Array(overlap);
  for (let i = 0; i < overlap; i++) {
    const s = Math.sin((Math.PI / 2) * ((i + 0.5) / overlap));
    w[i] = Math.sin((Math.PI / 2) * s * s);
  }
  return w;
}

/**
 * Ventana completa de 2N muestras con solape corto de `overlap`.
 *
 * Estructura: ceros, subida, plano, bajada, ceros. Las colas a cero son lo que
 * distingue el solape corto: fuera de la zona de transición la trama anterior
 * ya no aporta nada.
 */
export function celtWindowFull(n: number, overlap: number): Float64Array {
  if (overlap > n) throw new Error(`overlap ${overlap} no cabe en una trama de ${n}`);
  const w = new Float64Array(2 * n);
  const taper = celtWindow(overlap);
  const pad = (n - overlap) / 2;
  if (!Number.isInteger(pad)) throw new Error(`(N - overlap) tiene que ser par: ${n} - ${overlap}`);

  // Primera mitad: pad ceros, subida, resto a uno.
  for (let i = 0; i < overlap; i++) w[pad + i] = taper[i]!;
  for (let i = pad + overlap; i < n; i++) w[i] = 1;
  // Segunda mitad: el espejo.
  for (let i = 0; i < n; i++) w[2 * n - 1 - i] = w[i]!;
  return w;
}

/**
 * MDCT directa: 2N muestras (ya ventaneadas) → N coeficientes.
 *
 * `X[k] = Σ x[n]·cos(π/N·(n + ½ + N/2)·(k + ½))`
 *
 * Vía DCT-IV sobre una FFT de 2N. La derivación, que es lo único que hay que
 * creerse:
 *
 *     -iπ/N·(n+½)(k+½) = -i2πnk/(2N) - iπn/(2N) - iπk/(2N) - iπ/(4N)
 *
 * o sea: un giro por muestra ANTES de la FFT, un giro por coeficiente DESPUÉS,
 * y en medio una DFT normal.
 */
export function mdct(input: Float64Array | Float32Array, n: number): Float64Array {
  if (input.length !== 2 * n) throw new Error(`la MDCT de ${n} pide ${2 * n} muestras`);
  return dct4(fold(input, n), n);
}

/**
 * MDCT inversa: N coeficientes → 2N muestras (con su aliasing, que se cancela
 * al solapar con la trama de al lado).
 */
export function imdct(coeffs: Float64Array, n: number): Float64Array {
  if (coeffs.length !== n) throw new Error(`la IMDCT de ${n} pide ${n} coeficientes`);
  const size = 2 * n;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let k = 0; k < n; k++) {
    const angle = (-Math.PI * k) / size;
    re[k] = coeffs[k]! * Math.cos(angle);
    im[k] = coeffs[k]! * Math.sin(angle);
  }
  fft(re, im, -1);

  const out = new Float64Array(size);
  const scale = 2 / n;
  for (let t = 0; t < size; t++) {
    // El índice del núcleo va desplazado N/2, y da la vuelta cambiando de signo:
    // cos(π/N·(m + 2N + ½)(k+½)) = −cos(π/N·(m + ½)(k+½)).
    const shifted = t + n / 2;
    const m = shifted % size;
    const sign = shifted >= size ? -1 : 1;
    const angle = (-Math.PI * (2 * m + 1)) / (2 * size);
    out[t] = sign * scale * (re[m]! * Math.cos(angle) - im[m]! * Math.sin(angle));
  }
  return out;
}

/** Pliegue TDAC: 2N muestras → N valores para la DCT-IV. */
function fold(x: Float64Array | Float32Array, n: number): Float64Array {
  const half = n / 2;
  const t = new Float64Array(n);
  for (let i = 0; i < half; i++) {
    t[i] = -x[3 * half - 1 - i]! - x[3 * half + i]!;
    t[half + i] = x[i]! - x[n - 1 - i]!;
  }
  return t;
}

/** DCT-IV de tamaño n, con una FFT compleja de 2n. */
function dct4(t: Float64Array, n: number): Float64Array {
  const size = 2 * n;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < n; i++) {
    const angle = (-Math.PI * i) / size;
    re[i] = t[i]! * Math.cos(angle);
    im[i] = t[i]! * Math.sin(angle);
  }
  fft(re, im, -1);

  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const angle = (-Math.PI * (2 * k + 1)) / (2 * size);
    out[k] = re[k]! * Math.cos(angle) - im[k]! * Math.sin(angle);
  }
  return out;
}

/** MDCT por definición. Lenta a propósito: es la referencia del test. */
export function mdctNaive(input: Float64Array | Float32Array, n: number): Float64Array {
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    for (let t = 0; t < 2 * n; t++) {
      sum += input[t]! * Math.cos((Math.PI / n) * (t + 0.5 + n / 2) * (k + 0.5));
    }
    out[k] = sum;
  }
  return out;
}

/** IMDCT por definición. La otra referencia. */
export function imdctNaive(coeffs: Float64Array, n: number): Float64Array {
  const out = new Float64Array(2 * n);
  for (let t = 0; t < 2 * n; t++) {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      sum += coeffs[k]! * Math.cos((Math.PI / n) * (t + 0.5 + n / 2) * (k + 0.5));
    }
    out[t] = (2 / n) * sum;
  }
  return out;
}

/**
 * Analiza una señal en tramas MDCT solapadas al 50 %.
 *
 * Devuelve una trama por cada N muestras. La señal se rellena con N muestras de
 * silencio por delante y por detrás para que la primera y la última tengan con
 * quién solapar.
 */
export function mdctAnalyze(
  signal: Float64Array | Float32Array,
  n: number,
  overlap: number,
): Float64Array[] {
  const window = celtWindowFull(n, overlap);
  const padded = new Float64Array(signal.length + 2 * n);
  padded.set(signal, n);
  const frames: Float64Array[] = [];
  const block = new Float64Array(2 * n);
  for (let start = 0; start + 2 * n <= padded.length; start += n) {
    for (let i = 0; i < 2 * n; i++) block[i] = padded[start + i]! * window[i]!;
    frames.push(mdct(block, n));
  }
  return frames;
}

/**
 * Reconstruye la señal desde las tramas. Es aquí donde TDAC hace su trabajo:
 * cada muestra sale de sumar dos tramas, y el aliasing de una anula el de la otra.
 */
export function mdctSynthesize(
  frames: readonly Float64Array[],
  n: number,
  overlap: number,
  length: number,
): Float64Array {
  const window = celtWindowFull(n, overlap);
  const acc = new Float64Array(frames.length * n + n);
  frames.forEach((frame, index) => {
    const block = imdct(frame, n);
    const start = index * n;
    for (let i = 0; i < 2 * n; i++) acc[start + i] = (acc[start + i] ?? 0) + block[i]! * window[i]!;
  });
  // Se quita el relleno del principio.
  return acc.slice(n, n + length);
}
