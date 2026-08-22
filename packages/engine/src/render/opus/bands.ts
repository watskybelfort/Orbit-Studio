/**
 * Bandas: energía, normalización y la escala logarítmica del códec.
 *
 * Aquí es donde se hace la separación que define a CELT. Los coeficientes de la
 * MDCT se parten en 21 bandas críticas, y de cada banda se sacan **dos cosas que
 * viajan por caminos distintos**:
 *
 * - la **energía** (cuánto suena), que va por la cuantización de energía;
 * - la **forma** (cómo se reparte dentro de la banda), normalizada a norma 1,
 *   que va por el PVQ.
 *
 * Eso es lo que hace que Opus no se derrumbe a bitrates bajos: la energía es
 * barata y siempre llega, así que aunque a la forma no le queden bits, la banda
 * suena — imprecisa, pero suena. Un códec que cuantizara los coeficientes
 * directamente dejaría la banda a cero y se oiría el hueco.
 *
 * ## Por qué la energía viaja en logaritmo y con una media restada
 *
 * Lo que se cuantiza no es la amplitud sino su `log2`, porque el oído funciona
 * así: la diferencia entre 1 y 2 se oye igual que entre 100 y 200. Y encima se le
 * resta `E_MEANS`, la energía típica de esa banda en música normal, para que el
 * residuo esté centrado en cero. Sin esa resta, las bandas graves mandarían
 * siempre números grandes y las agudas siempre pequeños, y el modelo de Laplace
 * —que espera algo centrado— no acertaría en ninguna.
 *
 * ---
 * Port de `celt/bands.c` y `celt/quant_bands.c` de la implementación de
 * referencia de la RFC 6716 (rama de coma flotante). Copyright 1994-2011 IETF
 * Trust, Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin,
 * Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding,
 * Erik de Castro Lopo. BSD-3-Clause.
 */

import { E_MEANS } from './tables';

/**
 * Suelo que se le suma a la energía antes de la raíz.
 *
 * No es paranoia: una banda de silencio absoluto daría energía 0, y al
 * normalizar habría que dividir por cero. Con esto, el silencio produce una
 * forma cualquiera pero finita, y la energía —que es lo que se oye— sí queda a
 * cero de verdad.
 */
const ENERGY_EPSILON = 1e-27;

/** Energía a la que se fijan las bandas por encima del corte. */
const SILENT_BAND_DB = -14;

/**
 * Amplitud (raíz de la energía) de cada banda.
 *
 * `coeffs` lleva los canales concatenados: canal `c` empieza en `c * frameSize`.
 */
export function computeBandEnergies(
  coeffs: Float64Array,
  ebands: readonly number[],
  bands: number,
  end: number,
  channels: number,
  frameSize: number,
  m: number,
): Float64Array {
  const out = new Float64Array(bands * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < end; i++) {
      let sum = ENERGY_EPSILON;
      for (let j = m * ebands[i]!; j < m * ebands[i + 1]!; j++) {
        const v = coeffs[j + c * frameSize]!;
        sum += v * v;
      }
      out[i + c * bands] = Math.sqrt(sum);
    }
  }
  return out;
}

/** Divide cada banda por su amplitud: lo que queda tiene norma 1. */
export function normaliseBands(
  coeffs: Float64Array,
  bandE: Float64Array,
  ebands: readonly number[],
  bands: number,
  end: number,
  channels: number,
  frameSize: number,
  m: number,
): Float64Array {
  const out = new Float64Array(coeffs.length);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < end; i++) {
      const gain = 1 / (ENERGY_EPSILON + bandE[i + c * bands]!);
      for (let j = m * ebands[i]!; j < m * ebands[i + 1]!; j++) {
        out[j + c * frameSize] = coeffs[j + c * frameSize]! * gain;
      }
    }
  }
  return out;
}

/**
 * Devuelve la energía a las bandas normalizadas: la síntesis.
 *
 * Todo lo que quede por encima de la última banda codificada se pone a cero — es
 * lo que hace que saltar bandas agudas produzca silencio ahí y no basura.
 */
export function denormaliseBands(
  normalised: Float64Array,
  bandE: Float64Array,
  ebands: readonly number[],
  bands: number,
  end: number,
  channels: number,
  frameSize: number,
  m: number,
): Float64Array {
  const out = new Float64Array(normalised.length);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < end; i++) {
      const gain = bandE[i + c * bands]!;
      for (let j = m * ebands[i]!; j < m * ebands[i + 1]!; j++) {
        out[j + c * frameSize] = normalised[j + c * frameSize]! * gain;
      }
    }
    for (let j = m * ebands[end]!; j < frameSize; j++) out[j + c * frameSize] = 0;
  }
  return out;
}

/**
 * Amplitud → escala logarítmica del códec (`log2` menos la media de la banda).
 *
 * `effEnd` es hasta dónde hay señal de verdad; de ahí a `end` se fija un valor
 * de silencio, para que el cuantizador no gaste bits describiendo ruido de
 * cálculo.
 */
export function amp2Log2(
  bandE: Float64Array,
  bands: number,
  effEnd: number,
  end: number,
  channels: number,
): Float64Array {
  const out = new Float64Array(bands * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < effEnd; i++) {
      out[i + c * bands] = Math.log2(bandE[i + c * bands]!) - E_MEANS[i]!;
    }
    for (let i = effEnd; i < end; i++) out[i + c * bands] = SILENT_BAND_DB;
  }
  return out;
}

/** La vuelta: escala logarítmica → amplitud. */
export function log2Amp(
  logE: Float64Array,
  bands: number,
  start: number,
  end: number,
  channels: number,
): Float64Array {
  const out = new Float64Array(bands * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = start; i < end; i++) {
      out[i + c * bands] = 2 ** (logE[i + c * bands]! + E_MEANS[i]!);
    }
  }
  return out;
}
