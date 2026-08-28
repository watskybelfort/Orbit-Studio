/**
 * Espectro en vivo a partir del tap del kernel (el mismo `scopeFrame` que ya
 * usan el Orbit Scope y el EQ del mixer): FFT radix-2 con ventana de Hann y
 * suavizado exponencial entre frames.
 *
 * Sin el suavizado el espectro "tiembla" bloque a bloque (cada frame trae
 * 2048 muestras nuevas, ~43 ms) y hace ilegible justo lo que se quiere ver —
 * dónde vive la energía de una pista de forma sostenida, no el ruido de un
 * único bloque. Con una FFT de ventana corta ya cuesta separar el 808 del
 * bombo; sin promediar en el tiempo, más.
 *
 * Todo preasignado en el constructor: `update()` no reserva memoria, así que
 * puede llamarse a 60 fps desde requestAnimationFrame sin generar basura para
 * el GC (la regla dura del engine sobre el audio thread no aplica aquí — esto
 * corre en la UI — pero el mismo cuidado importa igual a 60 fps).
 */

export const SPECTRUM_FFT_N = 1024;
export const SPECTRUM_DB_FLOOR = -90;

export class SpectrumAnalyzer {
  readonly fftN: number;
  readonly bins: number;
  /** Magnitud suavizada en dB por bin (0..bins-1). Se lee tal cual tras `update`. */
  readonly db: Float32Array;

  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly hann: Float32Array;
  /** 0..1: cuánto pesa el pasado. Más alto = más inercia, menos parpadeo. */
  private readonly smoothing: number;
  private primed = false;

  constructor(fftN = SPECTRUM_FFT_N, smoothing = 0.72) {
    if (fftN < 2 || (fftN & (fftN - 1)) !== 0) {
      throw new Error(`SpectrumAnalyzer: ${fftN} no es potencia de 2`);
    }
    this.fftN = fftN;
    this.bins = fftN / 2;
    this.smoothing = Math.min(0.98, Math.max(0, smoothing));
    this.db = new Float32Array(this.bins).fill(SPECTRUM_DB_FLOOR);
    this.re = new Float32Array(fftN);
    this.im = new Float32Array(fftN);
    this.hann = new Float32Array(fftN);
    for (let i = 0; i < fftN; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftN - 1)));
    }
  }

  /**
   * Alimenta un frame nuevo (se toman las últimas `fftN` muestras; frames más
   * cortos que `fftN` se ignoran) y actualiza `db` con suavizado exponencial.
   */
  update(frame: Float32Array): void {
    const n = this.fftN;
    if (frame.length < n) return;
    const off = frame.length - n;
    const re = this.re;
    const im = this.im;
    const hann = this.hann;
    for (let i = 0; i < n; i++) {
      re[i] = frame[off + i]! * hann[i]!;
      im[i] = 0;
    }
    fftRadix2(re, im);
    const scale = n / 4;
    const a = this.smoothing;
    const db = this.db;
    for (let i = 0; i < this.bins; i++) {
      const mag = Math.hypot(re[i]!, im[i]!) / scale;
      const raw = Math.max(SPECTRUM_DB_FLOOR, 20 * Math.log10(mag + 1e-9));
      db[i] = this.primed ? a * db[i]! + (1 - a) * raw : raw;
    }
    this.primed = true;
  }

  /** Vuelve al piso de ruido sin suavizado pendiente (cambio de pista, etc). */
  reset(): void {
    this.db.fill(SPECTRUM_DB_FLOOR);
    this.primed = false;
  }
}

/** FFT radix-2 (Cooley-Tukey) iterativa in-place sobre re/im. */
function fftRadix2(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = i + k + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Mapea una frecuencia (Hz) a su bin más cercano de una FFT de `fftN` puntos. */
export function freqToBin(f: number, fftN: number, sr: number): number {
  const nyquist = sr / 2;
  const bins = fftN / 2;
  return Math.min(bins - 1, Math.max(1, Math.round((f / nyquist) * bins)));
}
