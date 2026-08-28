/**
 * Medidor de loudness EN VIVO (BS.1770 con gating, EBU R128 short-term,
 * true-peak aproximado), pensado para alimentarse a trozos según llega el
 * audio del tap del kernel — a diferencia de `engine/render/analysis.ts`
 * (`analyzeMix`), que mide de una vez sobre un archivo terminado.
 *
 * El bloque de K-weighting y el gating de dos pasos son la MISMA fórmula que
 * `analyzeMix`, letra por letra (mismos coeficientes de biquad, mismo bloque
 * de 400 ms con salto de 100 ms, mismo gate absoluto -70 / relativo -10 LU):
 * la prueba de que este medidor sirve es que, alimentado con el mismo
 * material a trozos, llega al mismo LUFS integrado que `analyzeMix` de una
 * sola pasada (ver `packages/ui/test/loudness-live.test.ts`). Los
 * coeficientes se duplican en vez de importarse de `dsp/filters.ts` siguiendo
 * el mismo patrón que ya usan `scope/ScopePanel.tsx` y `editors/mixer/Mixer.tsx`
 * para su propia FFT/EQ: son visualizadores de UI, no el motor, y no hay
 * paquete que exponga `Biquad` fuera de `@orbit/engine/dsp` (interno).
 *
 * Todo preasignado: `push()` no reserva memoria en su camino caliente (el
 * único array que puede crecer es el historial de bloques de loudness, y solo
 * cuando se queda corto — con doblado de capacidad, no por frame).
 */

const BLOCK_SEC = 0.4;
const HOP_SEC = 0.1;
const SHORT_TERM_SEC = 3;
const ABS_GATE = -70;
const K_OFFSET = -0.691;

interface BiquadCoefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** Réplica EXACTA de `Biquad.highShelf` (dsp/filters.ts): shelf de agudos RBJ. */
function highShelfCoefs(f: number, db: number, sr: number): BiquadCoefs {
  const A = Math.pow(10, db / 40);
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const S = 1;
  const alpha = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
  const a0 = A + 1 - (A - 1) * cw + twoSqrtAAlpha;
  return {
    b0: (A * (A + 1 + (A - 1) * cw + twoSqrtAAlpha)) / a0,
    b1: (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
    b2: (A * (A + 1 + (A - 1) * cw - twoSqrtAAlpha)) / a0,
    a1: (2 * (A - 1 - (A + 1) * cw)) / a0,
    a2: (A + 1 - (A - 1) * cw - twoSqrtAAlpha) / a0,
  };
}

/** Réplica EXACTA de `Biquad.highpass` (dsp/filters.ts): RBJ highpass. */
function highpassCoefs(f: number, q: number, sr: number): BiquadCoefs {
  const w = (2 * Math.PI * Math.min(f, sr * 0.49)) / sr;
  const cw = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = ((1 + cw) / 2) / a0;
  return { b0, b1: (-(1 + cw)) / a0, b2: b0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

/** Biquad de coeficientes fijos (direct form II transposed), sin rampa: acá
 * el K-weighting no se automatiza, así que no hace falta deslizar nada. */
class FixedBiquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  set(c: BiquadCoefs): void {
    this.b0 = c.b0;
    this.b1 = c.b1;
    this.b2 = c.b2;
    this.a1 = c.a1;
    this.a2 = c.a2;
  }

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
}

export interface LoudnessSnapshot {
  /** LUFS integrado (gating absoluto + relativo, BS.1770). `null` sin material. */
  integrated: number | null;
  /** LUFS short-term: ventana deslizante de 3 s SIN gating (EBU R128). `null` sin material. */
  shortTerm: number | null;
  /**
   * Pico ~true-peak en dBTP, estimado por sobremuestreo x4 con interpolación
   * lineal entre muestras consecutivas (incluye el borde entre llamadas a
   * `push`). Es una aproximación barata, no el filtro polifásico de BS.1770 —
   * `analysis.ts` tampoco mide true peak (su `peakDb` es pico de muestra
   * simple), así que no hay con qué contrastar este número offline.
   */
  truePeak: number;
}

/**
 * Loudness incremental: se alimenta con `push(left, right)` según llega
 * audio (a cualquier tamaño de trozo — el resultado no depende de cómo se
 * trocee, solo del orden y del total de muestras) y se lee con `snapshot()`.
 */
export class LiveLoudnessMeter {
  private sr = 0;

  private readonly shL = new FixedBiquad();
  private readonly hpL = new FixedBiquad();
  private readonly shR = new FixedBiquad();
  private readonly hpR = new FixedBiquad();

  private blockLen = 1;
  private hop = 1;
  private ring = new Float64Array(1);
  private ringIdx = 0;
  private filled = 0;
  private sinceHop = 0;
  private sumSq = 0;
  private totalSq = 0;
  private sampleCount = 0;

  /** Historial de loudness por bloque de 400 ms, para el gating de dos pasos. */
  private blockLoudness = new Float64Array(1024);
  private blockCount = 0;

  private stRing = new Float64Array(1);
  private stIdx = 0;
  private stFilled = 0;
  private stSumSq = 0;

  private peakLinear = 0;
  private lastL = 0;
  private lastR = 0;
  private hasLast = false;

  constructor(sr = 48000) {
    this.configure(sr);
  }

  /** (Re)calcula filtros y buffers para esta frecuencia de muestreo. */
  configure(sr: number): void {
    if (sr === this.sr) return;
    this.sr = sr;
    this.shL.set(highShelfCoefs(1681, 4, sr));
    this.hpL.set(highpassCoefs(38, 0.5, sr));
    this.shR.set(highShelfCoefs(1681, 4, sr));
    this.hpR.set(highpassCoefs(38, 0.5, sr));
    this.blockLen = Math.max(1, Math.floor(BLOCK_SEC * sr));
    this.hop = Math.max(1, Math.floor(HOP_SEC * sr));
    this.ring = new Float64Array(this.blockLen);
    this.stRing = new Float64Array(Math.max(1, Math.round(SHORT_TERM_SEC * sr)));
    this.reset();
  }

  /** Vacía todo el estado acumulado (filtros, bloques, pico) sin cambiar sr. */
  reset(): void {
    this.shL.reset();
    this.hpL.reset();
    this.shR.reset();
    this.hpR.reset();
    this.ring.fill(0);
    this.ringIdx = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.sumSq = 0;
    this.totalSq = 0;
    this.sampleCount = 0;
    this.blockCount = 0;
    this.stRing.fill(0);
    this.stIdx = 0;
    this.stFilled = 0;
    this.stSumSq = 0;
    this.peakLinear = 0;
    this.hasLast = false;
  }

  /** Alimenta un trozo estéreo real (L y R independientes). */
  push(left: Float32Array, right: Float32Array): void {
    const n = Math.min(left.length, right.length);
    const blockLen = this.blockLen;
    const ring = this.ring;
    const stRing = this.stRing;
    const stLen = stRing.length;
    for (let i = 0; i < n; i++) {
      const l = left[i]!;
      const r = right[i]!;
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > this.peakLinear) this.peakLinear = al;
      if (ar > this.peakLinear) this.peakLinear = ar;
      // True-peak aproximado: 3 puntos interpolados entre la muestra anterior
      // y esta (sobremuestreo x4 lineal), a caballo entre llamadas a push().
      if (this.hasLast) {
        for (let s = 1; s < 4; s++) {
          const t = s / 4;
          const il = this.lastL + (l - this.lastL) * t;
          const ir = this.lastR + (r - this.lastR) * t;
          const ai = Math.max(Math.abs(il), Math.abs(ir));
          if (ai > this.peakLinear) this.peakLinear = ai;
        }
      }
      this.lastL = l;
      this.lastR = r;
      this.hasLast = true;

      const kl = this.hpL.tick(this.shL.tick(l));
      const kr = this.hpR.tick(this.shR.tick(r));
      const ms = kl * kl + kr * kr;
      this.totalSq += ms;
      this.sampleCount++;

      this.sumSq += ms - ring[this.ringIdx]!;
      ring[this.ringIdx] = ms;
      this.ringIdx = (this.ringIdx + 1) % blockLen;
      if (this.filled < blockLen) this.filled++;
      if (this.filled === blockLen && ++this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        const mean = this.sumSq / blockLen;
        const lufs = K_OFFSET + 10 * Math.log10(Math.max(1e-12, mean));
        if (lufs > ABS_GATE) this.pushBlock(lufs);
      }

      this.stSumSq += ms - stRing[this.stIdx]!;
      stRing[this.stIdx] = ms;
      this.stIdx = (this.stIdx + 1) % stLen;
      if (this.stFilled < stLen) this.stFilled++;
    }
  }

  /**
   * Alimenta un trozo MONO como si fuera dual-mono (mismo canal en L y R).
   * Aproximación deliberada: es lo único disponible del tap en vivo del
   * kernel (`scopeFrame` manda L+R/2, no el estéreo real — ver
   * `state/scope-track.ts`). Para contenido centrado (bajo/808 mono, que
   * además es regla de mezcla del proyecto por debajo de 110 Hz) el resultado
   * coincide con el LUFS real; una mezcla muy ancha en estéreo se mide algo
   * más alta de lo que de verdad sonaría en un medidor estéreo completo.
   */
  pushMono(mono: Float32Array): void {
    this.push(mono, mono);
  }

  snapshot(): LoudnessSnapshot {
    let integrated: number | null = null;
    if (this.blockCount > 0) {
      let sum1 = 0;
      for (let i = 0; i < this.blockCount; i++) sum1 += Math.pow(10, this.blockLoudness[i]! / 10);
      const mean1 = sum1 / this.blockCount;
      const gate = 10 * Math.log10(mean1) - 10;
      let sum2 = 0;
      let passed = 0;
      for (let i = 0; i < this.blockCount; i++) {
        const b = this.blockLoudness[i]!;
        if (b > gate) {
          sum2 += Math.pow(10, b / 10);
          passed++;
        }
      }
      if (passed > 0) integrated = 10 * Math.log10(sum2 / passed);
    } else if (this.sampleCount > 0) {
      integrated = K_OFFSET + 10 * Math.log10(Math.max(1e-12, this.totalSq / this.sampleCount));
    }

    let shortTerm: number | null = null;
    if (this.stFilled > 0) {
      const mean = this.stSumSq / this.stFilled;
      shortTerm = K_OFFSET + 10 * Math.log10(Math.max(1e-12, mean));
    }

    return {
      integrated,
      shortTerm,
      truePeak: 20 * Math.log10(Math.max(1e-12, this.peakLinear)),
    };
  }

  private pushBlock(lufs: number): void {
    if (this.blockCount >= this.blockLoudness.length) {
      const grown = new Float64Array(this.blockLoudness.length * 2);
      grown.set(this.blockLoudness);
      this.blockLoudness = grown;
    }
    this.blockLoudness[this.blockCount++] = lufs;
  }
}
