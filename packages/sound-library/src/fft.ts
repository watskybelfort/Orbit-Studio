/**
 * FFT radix-2 iterativa (in-place) para el análisis de la librería.
 *
 * Pura y sin dependencias: la usan el detector de BPM (flujo espectral) y el
 * de tonalidad (croma). Las tablas de twiddles y el bit-reverse se calculan
 * una vez por tamaño y se cachean, así indexar una carpeta entera no vuelve a
 * alocarlas por archivo.
 */

/** Tabla precalculada de una FFT de tamaño potencia de dos. */
export class Fft {
  readonly size: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly reverse: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT: el tamaño debe ser potencia de dos (recibido ${size})`);
    }
    this.size = size;
    const half = size / 2;
    this.cosTable = new Float64Array(half);
    this.sinTable = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / size;
      this.cosTable[i] = Math.cos(a);
      this.sinTable[i] = Math.sin(a);
    }
    // Permutación bit-reverse.
    const bits = Math.log2(size) | 0;
    this.reverse = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r >>> 0;
    }
  }

  /** Transforma re/im in-place (longitud = size). */
  transform(re: Float64Array, im: Float64Array): void {
    const n = this.size;
    const rev = this.reverse;
    for (let i = 0; i < n; i++) {
      const j = rev[i]!;
      if (j > i) {
        const tr = re[i]!;
        re[i] = re[j]!;
        re[j] = tr;
        const ti = im[i]!;
        im[i] = im[j]!;
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const halfLen = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, tw = 0; k < halfLen; k++, tw += step) {
          const c = this.cosTable[tw]!;
          const s = this.sinTable[tw]!;
          const a = i + k;
          const b = a + halfLen;
          const xr = re[b]! * c - im[b]! * s;
          const xi = re[b]! * s + im[b]! * c;
          re[b] = re[a]! - xr;
          im[b] = im[a]! - xi;
          re[a] = re[a]! + xr;
          im[a] = im[a]! + xi;
        }
      }
    }
  }
}

const cache = new Map<number, Fft>();

/** FFT del tamaño pedido, reutilizando la tabla si ya se creó. */
export function getFft(size: number): Fft {
  let f = cache.get(size);
  if (!f) {
    f = new Fft(size);
    cache.set(size, f);
  }
  return f;
}

/** Ventana de Hann de longitud n (cacheada por tamaño). */
const hannCache = new Map<number, Float64Array>();

export function hannWindow(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
  }
  return w;
}
