/**
 * Bandas: energía, normalización y escala logarítmica.
 *
 * La propiedad que hay que demostrar es que **la separación no pierde nada**:
 * energía y forma, por separado, contienen exactamente lo mismo que los
 * coeficientes originales. Si normalizar y desnormalizar no devolviera la señal,
 * todo lo que se construye encima estaría partiendo de datos ya estropeados.
 *
 * Y luego la propiedad que le da sentido al diseño, que también se comprueba:
 * la energía sobrevive aunque la forma se destroce.
 */

import { describe, expect, it } from 'vitest';
import {
  amp2Log2,
  computeBandEnergies,
  denormaliseBands,
  log2Amp,
  normaliseBands,
} from '../src/render/opus/bands';
import { E_MEANS, EBAND_5MS, NB_BANDS } from '../src/render/opus/tables';

/** Modo estándar: trama de 960 (LM=3), así que M = 8 sub-MDCT de 120. */
const M = 8;
const FRAME = 960;
/**
 * Hasta dónde llegan las bandas: 8 x 100 = 800 de los 960 coeficientes.
 *
 * Los 160 de arriba NO son un descuido — son 20-24 kHz, que Opus no codifica a
 * propósito. A 48 kHz, 800/960 del Nyquist son exactamente 20 kHz.
 */
const CODED = M * 100;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Coeficientes con forma de espectro real: energía que cae hacia los agudos. */
function spectrum(channels: number, seed: number): Float64Array {
  const random = rng(seed);
  const out = new Float64Array(FRAME * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < FRAME; i++) {
      out[i + c * FRAME] = random() * Math.exp(-i / 200);
    }
  }
  return out;
}

const maxError = (a: Float64Array, b: Float64Array): number => {
  let peak = 1e-30;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    peak = Math.max(peak, Math.abs(a[i]!), Math.abs(b[i]!));
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  }
  return worst / peak;
};

describe('bandas · separar energía y forma no pierde nada', () => {
  it('normalizar y desnormalizar devuelve los coeficientes codificados', () => {
    for (const channels of [1, 2]) {
      const coeffs = spectrum(channels, 3 + channels);
      const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, channels, FRAME, M);
      const shape = normaliseBands(coeffs, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, channels, FRAME, M);
      const back = denormaliseBands(shape, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, channels, FRAME, M);
      for (let c = 0; c < channels; c++) {
        for (let j = 0; j < CODED; j++) {
          const at = j + c * FRAME;
          expect(Math.abs(back[at]! - coeffs[at]!), `${channels}ch coef ${j}`).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('por encima de 20 kHz no se codifica nada, y es a propósito', () => {
    // Las 21 bandas llegan al coeficiente 800 de 960. Esos 160 de arriba son
    // 20-24 kHz: tirarlos no es una pérdida del códec, es el límite del oído.
    const coeffs = spectrum(1, 5);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const shape = normaliseBands(coeffs, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const back = denormaliseBands(shape, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    for (let j = CODED; j < FRAME; j++) expect(back[j], `coeficiente ${j}`).toBe(0);
    // Y la cuenta cuadra: 800 de 960 coeficientes son 20 kHz de 24 kHz.
    expect((CODED / FRAME) * 24000).toBe(20000);
  });

  it('cada banda normalizada tiene norma 1', () => {
    const coeffs = spectrum(1, 7);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const shape = normaliseBands(coeffs, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    for (let band = 0; band < NB_BANDS; band++) {
      let sum = 0;
      for (let j = M * EBAND_5MS[band]!; j < M * EBAND_5MS[band + 1]!; j++) sum += shape[j]! ** 2;
      expect(Math.sqrt(sum), `banda ${band}`).toBeCloseTo(1, 9);
    }
  });

  it('la energía de banda es la raíz de la suma de cuadrados', () => {
    const coeffs = spectrum(1, 11);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    for (let band = 0; band < NB_BANDS; band++) {
      let sum = 0;
      for (let j = M * EBAND_5MS[band]!; j < M * EBAND_5MS[band + 1]!; j++) sum += coeffs[j]! ** 2;
      expect(bandE[band]!, `banda ${band}`).toBeCloseTo(Math.sqrt(sum), 9);
    }
  });

  it('los canales no se pisan', () => {
    // Un canal a tope y el otro en silencio: si los índices estuvieran mal, la
    // energía del segundo no saldría cero.
    const coeffs = new Float64Array(FRAME * 2);
    for (let i = 0; i < FRAME; i++) coeffs[i] = 1;
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 2, FRAME, M);
    for (let band = 0; band < NB_BANDS; band++) {
      expect(bandE[band]!, `izq banda ${band}`).toBeGreaterThan(0.5);
      expect(bandE[band + NB_BANDS]!, `der banda ${band}`).toBeLessThan(1e-10);
    }
  });
});

describe('bandas · el silencio no rompe nada', () => {
  it('una banda en silencio absoluto no divide por cero', () => {
    // Es a lo que se dedica el epsilon: sin él, normalizar silencio da NaN y el
    // NaN se propaga por todo el resto del códec sin dejar rastro de dónde salió.
    const coeffs = new Float64Array(FRAME);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const shape = normaliseBands(coeffs, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    for (const value of shape) expect(Number.isFinite(value)).toBe(true);
    for (const value of bandE) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeLessThan(1e-10);
    }
  });

  it('desnormalizar silencio devuelve silencio', () => {
    const coeffs = new Float64Array(FRAME);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const shape = normaliseBands(coeffs, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const back = denormaliseBands(shape, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    for (const value of back) expect(Math.abs(value)).toBeLessThan(1e-20);
  });

  it('lo que queda por encima de la última banda se pone a cero', () => {
    // Es lo que hace que saltar bandas agudas suene a silencio y no a basura.
    const coeffs = spectrum(1, 13);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const shape = normaliseBands(coeffs, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const end = 15;
    const back = denormaliseBands(shape, bandE, EBAND_5MS, NB_BANDS, end, 1, FRAME, M);
    for (let j = M * EBAND_5MS[end]!; j < FRAME; j++) {
      expect(back[j], `coeficiente ${j}`).toBe(0);
    }
    // Y lo de debajo sigue intacto.
    for (let j = 0; j < M * EBAND_5MS[end]!; j++) {
      expect(Math.abs(back[j]! - coeffs[j]!)).toBeLessThan(1e-12);
    }
  });
});

describe('bandas · la energía sobrevive aunque la forma se pierda', () => {
  it('destrozar la forma no cambia la energía de la banda', () => {
    // Ésta es LA razón de ser de la separación, comprobada de frente: se
    // sustituye la forma por otra completamente distinta (con la misma norma) y
    // la energía reconstruida sigue siendo la misma. Es lo que hace que a
    // bitrate bajo la banda suene imprecisa en vez de desaparecer.
    const coeffs = spectrum(1, 17);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);

    const destrozada = new Float64Array(FRAME);
    for (let band = 0; band < NB_BANDS; band++) {
      const from = M * EBAND_5MS[band]!;
      const to = M * EBAND_5MS[band + 1]!;
      const width = to - from;
      // Forma plana: no se parece en nada a la original, pero tiene norma 1.
      for (let j = from; j < to; j++) destrozada[j] = 1 / Math.sqrt(width);
    }

    const back = denormaliseBands(destrozada, bandE, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    const nuevaE = computeBandEnergies(back, EBAND_5MS, NB_BANDS, NB_BANDS, 1, FRAME, M);
    for (let band = 0; band < NB_BANDS; band++) {
      expect(nuevaE[band]!, `banda ${band}`).toBeCloseTo(bandE[band]!, 9);
    }
  });
});

describe('bandas · escala logarítmica', () => {
  it('ida y vuelta devuelve la amplitud', () => {
    const coeffs = spectrum(2, 19);
    const bandE = computeBandEnergies(coeffs, EBAND_5MS, NB_BANDS, NB_BANDS, 2, FRAME, M);
    const logE = amp2Log2(bandE, NB_BANDS, NB_BANDS, NB_BANDS, 2);
    const back = log2Amp(logE, NB_BANDS, 0, NB_BANDS, 2);
    for (let i = 0; i < bandE.length; i++) {
      expect(back[i]!, `banda ${i}`).toBeCloseTo(bandE[i]!, 9);
    }
  });

  it('doblar la amplitud sube exactamente 1 en la escala', () => {
    // Es lo que hace que el escalón de cuantización sea perceptualmente
    // uniforme: en logaritmo base 2, doblar es siempre +1.
    const bandE = new Float64Array(NB_BANDS).fill(0.5);
    const doble = new Float64Array(NB_BANDS).fill(1);
    const a = amp2Log2(bandE, NB_BANDS, NB_BANDS, NB_BANDS, 1);
    const b = amp2Log2(doble, NB_BANDS, NB_BANDS, NB_BANDS, 1);
    for (let band = 0; band < NB_BANDS; band++) {
      expect(b[band]! - a[band]!, `banda ${band}`).toBeCloseTo(1, 12);
    }
  });

  it('resta la media de cada banda para centrar el residuo', () => {
    // Con la energía típica de música, el valor logarítmico queda cerca de cero,
    // que es donde el modelo de Laplace acierta. Sin la resta, las graves darían
    // números muy distintos de las agudas.
    const bandE = new Float64Array(NB_BANDS);
    for (let band = 0; band < NB_BANDS; band++) bandE[band] = 2 ** E_MEANS[band]!;
    const logE = amp2Log2(bandE, NB_BANDS, NB_BANDS, NB_BANDS, 1);
    for (let band = 0; band < NB_BANDS; band++) {
      expect(Math.abs(logE[band]!), `banda ${band}`).toBeLessThan(1e-12);
    }
  });

  it('las bandas por encima del corte efectivo se marcan como silencio', () => {
    const bandE = new Float64Array(NB_BANDS).fill(1);
    const logE = amp2Log2(bandE, NB_BANDS, 12, NB_BANDS, 1);
    for (let band = 12; band < NB_BANDS; band++) {
      expect(logE[band], `banda ${band}`).toBe(-14);
    }
  });
});
