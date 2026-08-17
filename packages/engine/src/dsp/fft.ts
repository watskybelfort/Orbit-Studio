/**
 * FFT radix-2 (Cooley-Tukey) iterativa e in-place.
 * El motor no tiene dependencias externas y la convolución particionada
 * transforma varios bloques por cada 128 muestras: las tablas de twiddles y la
 * permutación de bits se calculan UNA vez por tamaño para que `transform()` no
 * llame a `Math.sin` ni asigne nada.
 */

export class Fft {
  readonly n: number;
  /** Twiddles en doble precisión: cuestan lo mismo y no arrastran error. */
  private readonly cosTab: Float64Array;
  private readonly sinTab: Float64Array;
  private readonly rev: Uint32Array;

  constructor(n: number) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`Fft: ${n} no es potencia de 2`);
    this.n = n;
    const half = n >> 1;
    this.cosTab = new Float64Array(half);
    this.sinTab = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cosTab[i] = Math.cos((2 * Math.PI * i) / n);
      this.sinTab[i] = Math.sin((2 * Math.PI * i) / n);
    }
    let bits = 0;
    while (1 << bits < n) bits++;
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r >>> 0;
    }
  }

  /** DFT directa in-place (convenio e^{-i2πkn/N}). */
  forward(re: Float32Array, im: Float32Array): void {
    this.transform(re, im);
  }

  /**
   * DFT inversa in-place, ya escalada por 1/N.
   * Truco del intercambio: swap(DFT(swap(X))) = N·x, así reusamos la directa
   * sin duplicar el bucle de mariposas.
   */
  inverse(re: Float32Array, im: Float32Array): void {
    this.transform(im, re);
    const inv = 1 / this.n;
    for (let i = 0; i < this.n; i++) {
      re[i] = re[i]! * inv;
      im[i] = im[i]! * inv;
    }
  }

  private transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    const rev = this.rev;
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
    const cosTab = this.cosTab;
    const sinTab = this.sinTab;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let base = 0; base < n; base += size) {
        for (let j = base, k = 0; j < base + half; j++, k += step) {
          const c = cosTab[k]!;
          const s = -sinTab[k]!;
          const p = j + half;
          const pr = re[p]!;
          const pi = im[p]!;
          const tr = pr * c - pi * s;
          const ti = pr * s + pi * c;
          re[p] = re[j]! - tr;
          im[p] = im[j]! - ti;
          re[j] = re[j]! + tr;
          im[j] = im[j]! + ti;
        }
      }
    }
  }
}
