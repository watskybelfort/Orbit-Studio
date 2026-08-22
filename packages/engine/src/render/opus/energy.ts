/**
 * Cuantización de la energía por bandas.
 *
 * Es la mitad "grave" de CELT: la que decide **cuánto suena** cada banda. La
 * otra mitad —el PVQ— sólo dice qué forma tiene. Separarlas es lo que le da a
 * Opus su comportamiento a bitrates bajos: aunque no queden bits para la forma,
 * la energía viaja igual y la banda sigue sonando.
 *
 * Va en tres pasadas, y el orden importa porque cada una gasta lo que sobra de
 * la anterior:
 *
 * 1. **Gruesa** (`quantCoarseEnergy`): un entero por banda, en decibelios, con
 *    el codificador Laplace. Predice de la trama anterior salvo en tramas intra.
 * 2. **Fina** (`quantFineEnergy`): unos pocos bits crudos por banda para afinar
 *    el escalón de 1 dB. Cuántos, lo dice el asignador.
 * 3. **Sobras** (`quantEnergyFinalise`): si al final del paquete quedan bits
 *    sueltos, se reparte uno más a las bandas que peor quedaron.
 *
 * ## Lo que hay que respetar sí o sí
 *
 * El decodificador **arrastra el mismo estado** (`oldEBands`) trama a trama, y lo
 * reconstruye a partir de lo que se escribió, no de lo que se quiso escribir. Por
 * eso aquí se guarda siempre el valor que devuelve el codificador Laplace y no el
 * que se le pasó: si divergen una vez, divergen para siempre — la predicción de
 * la trama siguiente ya parte de otro sitio.
 *
 * Y por eso el codificador recorta agresivamente cuando se queda sin bits
 * (`bitsLeft < 24`, `< 16`): más vale una energía peor que un paquete desbordado.
 *
 * ---
 * Port de `celt/quant_bands.c` de la implementación de referencia de la RFC 6716
 * (rama de coma flotante). Copyright 1994-2011 IETF Trust, Xiph.Org,
 * Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO,
 * Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { laplaceDecode, laplaceEncode } from './laplace';
import type { RangeDecoder, RangeEncoder } from './range-coder';
import { BETA_COEF, BETA_INTRA, E_PROB_MODEL, PRED_COEF, SMALL_ENERGY_ICDF } from './tables';
import { MAX_FINE_BITS } from './rate';

/** Suelo de energía que se usa como referencia de predicción, en dB. */
const ENERGY_FLOOR = -9;
/** Suelo absoluto para el límite de caída. */
const DECAY_FLOOR = -28;

export interface CoarseEnergyOptions {
  /** Energía medida de cada banda, en dB. Longitud `bands * channels`. */
  bandLogE: Float64Array;
  /** Estado que se arrastra entre tramas. **Se modifica in situ.** */
  oldEBands: Float64Array;
  /** Error de cuantización que hereda la pasada fina. **Se modifica in situ.** */
  error: Float64Array;
  bands: number;
  start: number;
  end: number;
  channels: number;
  /** 0..3, para tramas de 120/240/480/960. */
  lm: number;
  /** Trama sin predicción: cara, pero no depende de la anterior. */
  intra: boolean;
  /** Presupuesto total del paquete, en bits. */
  budget: number;
  /** Cuánto puede caer la energía de una banda respecto a la trama previa, en dB. */
  maxDecay: number;
}

/**
 * Primera pasada: un entero de dB por banda.
 *
 * Devuelve la "maldad" — cuánto tuvo que recortar respecto a lo que quería
 * poner. Un valor alto significa que el presupuesto se quedó corto, y es lo que
 * el codificador usa para decidir si le sale más a cuenta mandar la trama como
 * intra.
 */
export function quantCoarseEnergy(enc: RangeEncoder, options: CoarseEnergyOptions): number {
  const { bandLogE, oldEBands, error, bands, start, end, channels, lm, intra, budget, maxDecay } =
    options;
  const model = E_PROB_MODEL[lm]![intra ? 1 : 0]!;
  const coef = intra ? 0 : PRED_COEF[lm]!;
  const beta = intra ? BETA_INTRA : BETA_COEF[lm]!;
  const prev = [0, 0];
  let badness = 0;

  if (enc.tell() + 3 <= budget) enc.bitLogp(intra ? 1 : 0, 3);

  for (let i = start; i < end; i++) {
    for (let c = 0; c < channels; c++) {
      const at = i + c * bands;
      const x = bandLogE[at]!;
      const oldE = Math.max(ENERGY_FLOOR, oldEBands[at]!);
      const f = x - coef * oldE - prev[c]!;
      // Redondear al entero MÁS CERCANO aquí es crítico: truncar sesgaría la
      // energía de todas las bandas hacia abajo, trama tras trama.
      let qi = Math.floor(0.5 + f);

      // Freno de caída: sin esto, una banda estrecha puede desplomarse de golpe
      // y se oye como un chasquido.
      const decayBound = Math.max(DECAY_FLOOR, oldEBands[at]!) - maxDecay;
      if (qi < 0 && x < decayBound) {
        qi += Math.floor(decayBound - x);
        if (qi > 0) qi = 0;
      }
      const wanted = qi;

      // Reserva: 3 bits por banda y canal que quedan por delante. Si el margen
      // se estrecha, se recorta el salto antes de escribirlo.
      const tell = enc.tell();
      const bitsLeft = budget - tell - 3 * channels * (end - i);
      if (i !== start && bitsLeft < 30) {
        if (bitsLeft < 24) qi = Math.min(1, qi);
        if (bitsLeft < 16) qi = Math.max(-1, qi);
      }

      if (budget - tell >= 15) {
        const pi = 2 * Math.min(i, 20);
        qi = laplaceEncode(enc, qi, model[pi]! << 7, model[pi + 1]! << 6);
      } else if (budget - tell >= 2) {
        // Ya casi no hay sitio: sólo cabe −1, 0 o +1 con una ICDF de tres.
        qi = Math.max(-1, Math.min(qi, 1));
        enc.icdf((2 * qi) ^ (qi < 0 ? -1 : 0), SMALL_ENERGY_ICDF, 2);
      } else if (budget - tell >= 1) {
        // Un bit: o se queda igual, o baja.
        qi = Math.min(0, qi);
        enc.bitLogp(-qi, 1);
      } else {
        // Sin bits. Se asume que baja, que es lo seguro: inventar que sube
        // metería energía que no existe.
        qi = -1;
      }

      error[at] = f - qi;
      badness += Math.abs(wanted - qi);

      const tmp = coef * oldE + prev[c]! + qi;
      oldEBands[at] = tmp;
      prev[c] = prev[c]! + qi - beta * qi;
    }
  }
  return badness;
}

/** La misma pasada, del lado del decodificador. Reconstruye `oldEBands`. */
export function unquantCoarseEnergy(
  dec: RangeDecoder,
  options: Omit<CoarseEnergyOptions, 'bandLogE' | 'error' | 'maxDecay'>,
): void {
  const { oldEBands, bands, start, end, channels, lm, intra, budget } = options;
  const model = E_PROB_MODEL[lm]![intra ? 1 : 0]!;
  const coef = intra ? 0 : PRED_COEF[lm]!;
  const beta = intra ? BETA_INTRA : BETA_COEF[lm]!;
  const prev = [0, 0];

  for (let i = start; i < end; i++) {
    for (let c = 0; c < channels; c++) {
      const at = i + c * bands;
      const tell = dec.tell();
      let qi: number;
      if (budget - tell >= 15) {
        const pi = 2 * Math.min(i, 20);
        qi = laplaceDecode(dec, model[pi]! << 7, model[pi + 1]! << 6);
      } else if (budget - tell >= 2) {
        const symbol = dec.icdf(SMALL_ENERGY_ICDF, 2);
        qi = (symbol >> 1) ^ -(symbol & 1);
      } else if (budget - tell >= 1) {
        qi = -dec.bitLogp(1);
      } else {
        qi = -1;
      }
      const oldE = Math.max(ENERGY_FLOOR, oldEBands[at]!);
      oldEBands[at] = coef * oldE + prev[c]! + qi;
      prev[c] = prev[c]! + qi - beta * qi;
    }
  }
}

/**
 * Segunda pasada: bits crudos para afinar dentro del escalón de 1 dB.
 *
 * Van **sin modelo de probabilidad**, a pelo, porque dentro de su escalón el
 * error está repartido por igual y un modelo no ahorraría nada.
 */
export function quantFineEnergy(
  enc: RangeEncoder,
  oldEBands: Float64Array,
  error: Float64Array,
  fineQuant: Int32Array,
  bands: number,
  start: number,
  end: number,
  channels: number,
): void {
  for (let i = start; i < end; i++) {
    const width = fineQuant[i]!;
    if (width <= 0) continue;
    const frac = 1 << width;
    for (let c = 0; c < channels; c++) {
      const at = i + c * bands;
      let q2 = Math.floor((error[at]! + 0.5) * frac);
      if (q2 > frac - 1) q2 = frac - 1;
      if (q2 < 0) q2 = 0;
      enc.bits(q2, width);
      const offset = (q2 + 0.5) * (1 << (14 - width)) * (1 / 16384) - 0.5;
      oldEBands[at] = oldEBands[at]! + offset;
      error[at] = error[at]! - offset;
    }
  }
}

/** La pasada fina, del lado del decodificador. */
export function unquantFineEnergy(
  dec: RangeDecoder,
  oldEBands: Float64Array,
  fineQuant: Int32Array,
  bands: number,
  start: number,
  end: number,
  channels: number,
): void {
  for (let i = start; i < end; i++) {
    const width = fineQuant[i]!;
    if (width <= 0) continue;
    for (let c = 0; c < channels; c++) {
      const at = i + c * bands;
      const q2 = dec.bits(width);
      const offset = (q2 + 0.5) * (1 << (14 - width)) * (1 / 16384) - 0.5;
      oldEBands[at] = oldEBands[at]! + offset;
    }
  }
}

/**
 * Tercera pasada: reparte los bits que hayan sobrado al final del paquete.
 *
 * Un bit por banda y canal, en dos rondas de prioridad. No es cosmético — son
 * bits que ya están pagados: si no se usan, se van en relleno.
 */
export function quantEnergyFinalise(
  enc: RangeEncoder,
  oldEBands: Float64Array,
  error: Float64Array,
  fineQuant: Int32Array,
  finePriority: Int32Array,
  bands: number,
  start: number,
  end: number,
  channels: number,
  bitsLeft: number,
): void {
  let left = bitsLeft;
  for (let priority = 0; priority < 2; priority++) {
    for (let i = start; i < end && left >= channels; i++) {
      if (fineQuant[i]! >= MAX_FINE_BITS || finePriority[i] !== priority) continue;
      for (let c = 0; c < channels; c++) {
        const at = i + c * bands;
        const q2 = error[at]! < 0 ? 0 : 1;
        enc.bits(q2, 1);
        oldEBands[at] = oldEBands[at]! + (q2 - 0.5) * (1 << (14 - fineQuant[i]! - 1)) * (1 / 16384);
        left--;
      }
    }
  }
}

/** El reparto de sobras, del lado del decodificador. */
export function unquantEnergyFinalise(
  dec: RangeDecoder,
  oldEBands: Float64Array,
  fineQuant: Int32Array,
  finePriority: Int32Array,
  bands: number,
  start: number,
  end: number,
  channels: number,
  bitsLeft: number,
): void {
  let left = bitsLeft;
  for (let priority = 0; priority < 2; priority++) {
    for (let i = start; i < end && left >= channels; i++) {
      if (fineQuant[i]! >= MAX_FINE_BITS || finePriority[i] !== priority) continue;
      for (let c = 0; c < channels; c++) {
        const at = i + c * bands;
        const q2 = dec.bits(1);
        oldEBands[at] = oldEBands[at]! + (q2 - 0.5) * (1 << (14 - fineQuant[i]! - 1)) * (1 / 16384);
        left--;
      }
    }
  }
}
