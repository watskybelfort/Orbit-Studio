/** Filtros: SVF TPT (Zavalishin) para sintes y biquads RBJ para EQ. */

export class SVF {
  private ic1eq = 0;
  private ic2eq = 0;
  private g = 0;
  private k = 1;

  /** res 0..1 → Q 0.5..10. */
  set(cutoff: number, res: number, sr: number): void {
    const fc = Math.min(cutoff, sr * 0.49);
    this.g = Math.tan(Math.PI * (fc / sr));
    const q = 0.5 + res * 9.5;
    this.k = 1 / q;
  }

  reset(): void {
    this.ic1eq = 0;
    this.ic2eq = 0;
  }

  /** type: 0 LP, 1 HP, 2 BP, 3 notch. */
  tick(x: number, type: number): number {
    const { g, k } = this;
    const v1 = (this.ic1eq + g * (x - this.ic2eq)) / (1 + g * (g + k));
    const v2 = this.ic2eq + g * v1;
    this.ic1eq = 2 * v1 - this.ic1eq;
    this.ic2eq = 2 * v2 - this.ic2eq;
    switch (type | 0) {
      case 1: return x - k * v1 - v2;
      case 2: return v1;
      // Notch = LP + HP = x - k·v1. El BP (v1) tiene ganancia Q en resonancia,
      // así que restar v1 CRUDO amplificaba la banda en vez de vaciarla (a res
      // alta salía un pico de +19 dB donde debía haber una muesca).
      case 3: return x - k * v1;
      default: return v2;
    }
  }
}

/** Biquad transposed direct form II. */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0;
  private z2 = 0;

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  tick(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  copyFrom(o: Biquad): void {
    this.b0 = o.b0; this.b1 = o.b1; this.b2 = o.b2;
    this.a1 = o.a1; this.a2 = o.a2;
  }

  // ── Coeficientes RBJ (Audio EQ Cookbook) ──────────────────────────────────

  lowpass(f: number, q: number, sr: number): this {
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 - cw) / 2) / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  highpass(f: number, q: number, sr: number): this {
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = ((1 + cw) / 2) / a0;
    this.b1 = (-(1 + cw)) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  peaking(f: number, db: number, q: number, sr: number): this {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cw) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha / A) / a0;
    return this;
  }

  lowShelf(f: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const S = 1;
    const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 + (A - 1) * cw + twoSqrtAAlpha;
    this.b0 = (A * (A + 1 - (A - 1) * cw + twoSqrtAAlpha)) / a0;
    this.b1 = (2 * A * (A - 1 - (A + 1) * cw)) / a0;
    this.b2 = (A * (A + 1 - (A - 1) * cw - twoSqrtAAlpha)) / a0;
    this.a1 = (-2 * (A - 1 + (A + 1) * cw)) / a0;
    this.a2 = (A + 1 + (A - 1) * cw - twoSqrtAAlpha) / a0;
    return this;
  }

  highShelf(f: number, db: number, sr: number): this {
    const A = Math.pow(10, db / 40);
    const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const S = 1;
    const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 - (A - 1) * cw + twoSqrtAAlpha;
    this.b0 = (A * (A + 1 + (A - 1) * cw + twoSqrtAAlpha)) / a0;
    this.b1 = (-2 * A * (A - 1 + (A + 1) * cw)) / a0;
    this.b2 = (A * (A + 1 + (A - 1) * cw - twoSqrtAAlpha)) / a0;
    this.a1 = (2 * (A - 1 - (A + 1) * cw)) / a0;
    this.a2 = (A + 1 - (A - 1) * cw - twoSqrtAAlpha) / a0;
    return this;
  }
}

/** Allpass de primer orden (phaser). */
export class Allpass1 {
  private z = 0;
  a = 0;

  set(f: number, sr: number): void {
    const t = Math.tan((Math.PI * Math.min(f, sr * 0.49)) / sr);
    this.a = (t - 1) / (t + 1);
  }

  tick(x: number): number {
    const y = this.a * x + this.z;
    this.z = x - this.a * y;
    return y;
  }
}

/** Seguidor de envolvente (detector peak con attack/release). */
export class EnvFollower {
  value = 0;

  tick(x: number, attackCoef: number, releaseCoef: number): number {
    const a = Math.abs(x);
    const coef = a > this.value ? attackCoef : releaseCoef;
    this.value = a + coef * (this.value - a);
    return this.value;
  }
}

/** Coeficiente de suavizado one-pole a partir de un tiempo en segundos. */
export function timeCoef(seconds: number, sr: number): number {
  return Math.exp(-1 / (Math.max(0.0001, seconds) * sr));
}
