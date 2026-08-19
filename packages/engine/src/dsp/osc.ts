/** Osciladores anti-alias (PolyBLEP) y ruido determinista. */

export const TWO_PI = Math.PI * 2;

/** Corrección PolyBLEP en las discontinuidades (t, dt en fase 0..1). */
export function polyblep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Oscilador con fase propia; `wave`: 0 saw, 1 square, 2 triangle, 3 sine. */
export class Osc {
  phase = 0;

  constructor(phase = 0) {
    this.phase = phase;
  }

  /** Un sample; `dt` = freq/sampleRate. */
  tick(wave: number, dt: number): number {
    const t = this.phase;
    this.phase += dt;
    // Envolver con `Math.floor`, no con UNA resta. Con `dt >= 1` (nota por
    // encima del sample rate: tecla 127 con la perilla de octava en +2) se
    // sumaba más de lo que se restaba, la fase crecía sin freno y la saw y la
    // cuadrada crecían con ella: se han medido picos de +142 dB en el master,
    // que el limiter no tapa.
    this.phase -= Math.floor(this.phase);
    switch (wave | 0) {
      case 0:
        return 2 * t - 1 - polyblep(t, dt);
      case 1: {
        let v = t < 0.5 ? 1 : -1;
        v += polyblep(t, dt);
        v -= polyblep((t + 0.5) % 1, dt);
        return v;
      }
      case 2:
        // Triángulo naif: armónicos caen a -12 dB/oct, alias inaudible.
        return t < 0.5 ? 4 * t - 1 : 3 - 4 * t;
      default:
        return Math.sin(TWO_PI * t);
    }
  }
}

/**
 * Ruido blanco determinista (LCG xorshift): misma semilla → mismo render.
 * Nunca uses Math.random() en el kernel (rompe los golden tests).
 */
export class Noise {
  private s: number;

  constructor(seed = 0x2f6e2b1) {
    this.s = seed | 0 || 1;
  }

  tick(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x | 0;
    return (this.s / 0x7fffffff) * 0.999;
  }
}
