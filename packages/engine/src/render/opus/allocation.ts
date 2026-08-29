/**
 * Asignador de bits de CELT: quién se lleva cuántos.
 *
 * Es la pieza más enrevesada del códec y la que más se malinterpreta, así que
 * conviene decir primero lo que **no** es: no es una heurística del codificador
 * que se pueda mejorar por libre. **El decodificador ejecuta este mismo
 * algoritmo, con las mismas entradas, y tiene que llegar al mismo reparto.** Casi
 * nada de lo que se decide aquí viaja en el paquete — se recalcula. Cambiar una
 * comparación "para que reparta mejor" no mejora nada: produce archivos que
 * nadie puede leer.
 *
 * Lo que sí viaja son tres cosas, y están marcadas en el código: la bandera de
 * bandas saltadas, el parámetro de intensidad estéreo y el de estéreo dual.
 *
 * ## Cómo reparte
 *
 * 1. Busca por bisección, entre las 11 filas de `BAND_ALLOCATION`, las dos que
 *    rodean al bitrate pedido.
 * 2. Interpola entre ellas con otra bisección de 6 pasos (`ALLOC_STEPS`), esta
 *    vez sobre cuánto de la fila alta se mezcla.
 * 3. Decide qué bandas agudas se saltan del todo — trabajando **hacia atrás**,
 *    porque los bits que se le quitan a una banda saltada se reparten entre las
 *    que quedan.
 * 4. Parte lo asignado a cada banda entre **energía fina** (bits crudos para
 *    afinar el nivel) y **forma** (los pulsos del PVQ).
 *
 * El paso 4 es donde está la idea buena: en una banda con pocos bits vale más
 * saber el nivel exacto que la forma exacta, y la fórmula del `offset` es
 * justamente esa frontera.
 *
 * ---
 * Port de `compute_allocation` e `interp_bits2pulses` de `celt/rate.c` de la
 * implementación de referencia de la RFC 6716. Copyright 1994-2011 IETF Trust,
 * Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry,
 * CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import type { RangeDecoder, RangeEncoder } from './range-coder';
import { FINE_OFFSET, MAX_FINE_BITS, computeLogN } from './rate';
import { BAND_ALLOCATION, BITRES, LOG2_FRAC_TABLE } from './tables';

/** Pasos de la bisección de interpolación. Fijo: los dos lados dan los mismos. */
export const ALLOC_STEPS = 6;
/** Filas de calidad de la tabla de asignación. */
export const NB_ALLOC_VECTORS = 11;

/** El codificador o el decodificador, según el lado. El algoritmo es el mismo. */
export type AllocCoder =
  | { readonly encode: true; readonly enc: RangeEncoder }
  | { readonly encode: false; readonly dec: RangeDecoder };

export interface AllocationInput {
  /** Bordes de banda del modo. */
  ebands: readonly number[];
  start: number;
  end: number;
  /** Bits extra pedidos por banda (dynalloc). */
  offsets: Int32Array;
  /** Techo por banda, del `caps` de la caché de pulsos. */
  cap: Int32Array;
  /** Inclinación del reparto: <5 hacia los agudos, >5 hacia los graves. */
  allocTrim: number;
  /** Presupuesto total en octavos de bit. */
  total: number;
  channels: number;
  lm: number;
  /** Banda a partir de la cual el estéreo pasa a intensidad. Entra y sale. */
  intensity: number;
  /** Estéreo dual (cada canal por su cuenta). Entra y sale. */
  dualStereo: number;
  /** Bandas codificadas en la trama anterior, para la histéresis del salto. */
  prev: number;
}

export interface AllocationResult {
  /** Bandas que de verdad se codifican; de ahí en adelante, saltadas. */
  codedBands: number;
  /** Octavos de bit para la FORMA de cada banda (los pulsos del PVQ). */
  pulses: Int32Array;
  /** Bits de energía fina por banda y canal. */
  ebits: Int32Array;
  /** Qué bandas entran en la primera ronda del reparto de sobras. */
  finePriority: Int32Array;
  /** Bits que sobraron del techo, para el rebalanceo de las bandas. */
  balance: number;
  intensity: number;
  dualStereo: number;
}

/** Escribe o lee un bit con probabilidad 1/2, según el lado. */
function bit(coder: AllocCoder, value: number): number {
  if (coder.encode) {
    coder.enc.bitLogp(value, 1);
    return value;
  }
  return coder.dec.bitLogp(1);
}

/**
 * Reparte el presupuesto entre las bandas.
 *
 * Devuelve, además del reparto, los parámetros de estéreo que se acaban de
 * escribir o leer: el llamante tiene que quedarse con los devueltos, porque el
 * codificador puede recortarlos.
 */
export function computeAllocation(input: AllocationInput, coder: AllocCoder): AllocationResult {
  const { ebands, start, end, offsets, cap, allocTrim, channels, lm, prev } = input;
  const bands = ebands.length - 1;
  const logN = computeLogN(ebands);

  let total = Math.max(input.total, 0);
  let skipStart = start;

  // Un bit reservado para señalar dónde acaban las bandas saltadas a mano.
  const skipRsv = total >= 1 << BITRES ? 1 << BITRES : 0;
  total -= skipRsv;

  // Y otros dos para los parámetros de estéreo, si hay estéreo.
  let intensityRsv = 0;
  let dualStereoRsv = 0;
  if (channels === 2) {
    intensityRsv = LOG2_FRAC_TABLE[end - start]!;
    if (intensityRsv > total) {
      intensityRsv = 0;
    } else {
      total -= intensityRsv;
      dualStereoRsv = total >= 1 << BITRES ? 1 << BITRES : 0;
      total -= dualStereoRsv;
    }
  }

  const thresh = new Int32Array(bands);
  const trimOffset = new Int32Array(bands);
  for (let j = start; j < end; j++) {
    const width = ebands[j + 1]! - ebands[j]!;
    // Por debajo de esto, seguro que no se le dan bits de forma a la banda.
    thresh[j] = Math.max(channels << BITRES, (((3 * width) << lm) << BITRES) >> 4);
    // La inclinación: reparte hacia graves o hacia agudos según `allocTrim`.
    trimOffset[j] =
      (channels * width * (allocTrim - 5 - lm) * (end - j - 1) * (1 << (lm + BITRES))) >> 6;
    // Las bandas de un solo coeficiente sacan más provecho de un valor grueso
    // por coeficiente que de resolución de forma.
    if ((width << lm) === 1) trimOffset[j] = trimOffset[j]! - (channels << BITRES);
  }

  // Bisección sobre las filas de calidad de la tabla.
  let lo = 1;
  let hi = NB_ALLOC_VECTORS - 1;
  do {
    const mid = (lo + hi) >> 1;
    let psum = 0;
    let done = false;
    for (let j = end; j-- > start; ) {
      const width = ebands[j + 1]! - ebands[j]!;
      let bitsj = ((channels * width * BAND_ALLOCATION[mid * bands + j]!) << lm) >> 2;
      if (bitsj > 0) bitsj = Math.max(0, bitsj + trimOffset[j]!);
      bitsj += offsets[j]!;
      if (bitsj >= thresh[j]! || done) {
        done = true;
        psum += Math.min(bitsj, cap[j]!);
      } else if (bitsj >= channels << BITRES) {
        psum += channels << BITRES;
      }
    }
    if (psum > total) hi = mid - 1;
    else lo = mid + 1;
  } while (lo <= hi);
  hi = lo--;

  // Las dos filas que rodean al objetivo, y la diferencia entre ellas.
  const bits1 = new Int32Array(bands);
  const bits2 = new Int32Array(bands);
  for (let j = start; j < end; j++) {
    const width = ebands[j + 1]! - ebands[j]!;
    let bits1j = ((channels * width * BAND_ALLOCATION[lo * bands + j]!) << lm) >> 2;
    let bits2j =
      hi >= NB_ALLOC_VECTORS
        ? cap[j]!
        : ((channels * width * BAND_ALLOCATION[hi * bands + j]!) << lm) >> 2;
    if (bits1j > 0) bits1j = Math.max(0, bits1j + trimOffset[j]!);
    if (bits2j > 0) bits2j = Math.max(0, bits2j + trimOffset[j]!);
    if (lo > 0) bits1j += offsets[j]!;
    bits2j += offsets[j]!;
    // Una banda con bits pedidos a mano no se puede saltar.
    if (offsets[j]! > 0) skipStart = j;
    bits2[j] = Math.max(0, bits2j - bits1j);
    bits1[j] = bits1j;
  }

  return interpBitsToPulses({
    ebands,
    logN,
    start,
    end,
    skipStart,
    bits1,
    bits2,
    thresh,
    cap,
    total,
    skipRsv,
    intensityRsv,
    dualStereoRsv,
    intensity: input.intensity,
    dualStereo: input.dualStereo,
    channels,
    lm,
    prev,
    coder,
  });
}

interface InterpInput {
  ebands: readonly number[];
  logN: Int32Array;
  start: number;
  end: number;
  skipStart: number;
  bits1: Int32Array;
  bits2: Int32Array;
  thresh: Int32Array;
  cap: Int32Array;
  total: number;
  skipRsv: number;
  intensityRsv: number;
  dualStereoRsv: number;
  intensity: number;
  dualStereo: number;
  channels: number;
  lm: number;
  prev: number;
  coder: AllocCoder;
}

function interpBitsToPulses(input: InterpInput): AllocationResult {
  const {
    ebands,
    logN,
    start,
    end,
    skipStart,
    bits1,
    bits2,
    thresh,
    cap,
    skipRsv,
    channels,
    lm,
    prev,
    coder,
  } = input;
  const bands = ebands.length - 1;
  const bits = new Int32Array(bands);
  const ebits = new Int32Array(bands);
  const finePriority = new Int32Array(bands);

  let total = input.total;
  let intensityRsv = input.intensityRsv;
  let dualStereoRsv = input.dualStereoRsv;
  let intensity = input.intensity;
  let dualStereo = input.dualStereo;

  const allocFloor = channels << BITRES;
  const stereo = channels > 1 ? 1 : 0;
  const logM = lm << BITRES;

  // Bisección de la mezcla entre las dos filas. Siempre ALLOC_STEPS pasos, sin
  // salir antes: los dos lados tienen que recorrer el mismo camino.
  let lo = 0;
  let hi = 1 << ALLOC_STEPS;
  for (let step = 0; step < ALLOC_STEPS; step++) {
    const mid = (lo + hi) >> 1;
    let psum = 0;
    let done = false;
    for (let j = end; j-- > start; ) {
      const tmp = bits1[j]! + ((mid * bits2[j]!) >> ALLOC_STEPS);
      if (tmp >= thresh[j]! || done) {
        done = true;
        psum += Math.min(tmp, cap[j]!);
      } else if (tmp >= allocFloor) {
        psum += allocFloor;
      }
    }
    if (psum > total) hi = mid;
    else lo = mid;
  }

  let psum = 0;
  let done = false;
  for (let j = end; j-- > start; ) {
    let tmp = bits1[j]! + ((lo * bits2[j]!) >> ALLOC_STEPS);
    if (tmp < thresh[j]! && !done) {
      tmp = tmp >= allocFloor ? allocFloor : 0;
    } else {
      done = true;
    }
    tmp = Math.min(tmp, cap[j]!);
    bits[j] = tmp;
    psum += tmp;
  }

  // Qué bandas se saltan, de atrás hacia delante: los bits que se le quitan a
  // una banda saltada se reparten entre las que quedan, así que hay que saber
  // primero cuáles caen.
  let codedBands = end;
  for (;;) {
    const j = codedBands - 1;
    // Ni la primera banda ni una con bits pedidos a mano se saltan nunca:
    // en el primer caso se gastaría un bit para anunciar que se tira todo lo
    // demás, y en el segundo para deshacer lo que se acaba de pedir.
    if (j <= skipStart) {
      total += skipRsv;
      break;
    }

    let left = total - psum;
    const percoeff = Math.trunc(left / (ebands[codedBands]! - ebands[start]!));
    left -= (ebands[codedBands]! - ebands[start]!) * percoeff;
    const rem = Math.max(left - (ebands[j]! - ebands[start]!), 0);
    const bandWidth = ebands[codedBands]! - ebands[j]!;
    let bandBits = bits[j]! + percoeff * bandWidth + rem;

    // La decisión de salto sólo se codifica si la banda llega al umbral; si no,
    // se salta a la fuerza. Así siempre hay bits para escribir la bandera.
    if (bandBits >= Math.max(thresh[j]!, allocFloor + (1 << BITRES))) {
      if (coder.encode) {
        // ESTE `if` es la única parte del asignador que NO es obligatoria del
        // formato: lo que se decida saltar aquí va señalizado explícitamente.
        // La histéresis (7 contra 9 según la trama anterior) evita que una banda
        // entre y salga en tramas alternas, que se oiría como un parpadeo.
        if (bandBits > (((j < prev ? 7 : 9) * bandWidth) << lm << BITRES) >> 4) {
          coder.enc.bitLogp(1, 1);
          break;
        }
        coder.enc.bitLogp(0, 1);
      } else if (coder.dec.bitLogp(1)) {
        break;
      }
      psum += 1 << BITRES;
      bandBits -= 1 << BITRES;
    }

    // Se recuperan los bits que tenía asignados la banda que se salta.
    psum -= bits[j]! + intensityRsv;
    if (intensityRsv > 0) intensityRsv = LOG2_FRAC_TABLE[j - start]!;
    psum += intensityRsv;
    if (bandBits >= allocFloor) {
      psum += allocFloor;
      bits[j] = allocFloor;
    } else {
      bits[j] = 0;
    }
    codedBands--;
  }

  // Los dos parámetros de estéreo, que sí viajan en el paquete.
  if (intensityRsv > 0) {
    if (coder.encode) {
      intensity = Math.min(intensity, codedBands);
      coder.enc.uint(intensity - start, codedBands + 1 - start);
    } else {
      intensity = start + coder.dec.uint(codedBands + 1 - start);
    }
  } else {
    intensity = 0;
  }
  if (intensity <= start) {
    total += dualStereoRsv;
    dualStereoRsv = 0;
  }
  dualStereo = dualStereoRsv > 0 ? bit(coder, dualStereo) : 0;

  // Lo que quede se reparte por coeficiente, y el resto de uno en uno.
  let left = total - psum;
  const percoeff = Math.trunc(left / (ebands[codedBands]! - ebands[start]!));
  left -= (ebands[codedBands]! - ebands[start]!) * percoeff;
  for (let j = start; j < codedBands; j++) {
    bits[j] = bits[j]! + percoeff * (ebands[j + 1]! - ebands[j]!);
  }
  for (let j = start; j < codedBands; j++) {
    const tmp = Math.min(left, ebands[j + 1]! - ebands[j]!);
    bits[j] = bits[j]! + tmp;
    left -= tmp;
  }

  // Y ahora el reparto dentro de cada banda: energía fina contra forma.
  let balance = 0;
  let j = start;
  for (; j < codedBands; j++) {
    const n0 = ebands[j + 1]! - ebands[j]!;
    const n = n0 << lm;
    bits[j] = bits[j]! + balance;
    let excess: number;

    if (n > 1) {
      excess = Math.max(bits[j]! - cap[j]!, 0);
      bits[j] = bits[j]! - excess;

      // En estéreo acoplado hay un grado de libertad de más.
      const den = channels * n + (channels === 2 && n > 2 && !dualStereo && j < intensity ? 1 : 0);
      const nClogN = den * (logN[j]! + logM);

      // La frontera entre nivel y forma: con pocos bits sale más a cuenta saber
      // el nivel exacto que la forma exacta.
      let offset = (nClogN >> 1) - den * FINE_OFFSET;
      if (n === 2) offset += (den << BITRES) >> 2; // N=2 se sale de la curva
      if (bits[j]! + offset < (den * 2) << BITRES) offset += nClogN >> 2;
      else if (bits[j]! + offset < (den * 3) << BITRES) offset += nClogN >> 3;

      ebits[j] = Math.max(0, Math.trunc((bits[j]! + offset + (den << (BITRES - 1))) / (den << BITRES)));
      // Que no se pase de lo que hay.
      if (channels * ebits[j]! > bits[j]! >> BITRES) ebits[j] = bits[j]! >> stereo >> BITRES;
      ebits[j] = Math.min(ebits[j]!, MAX_FINE_BITS);

      // Si se redondeó a la baja o se topó, la banda es candidata al reparto de
      // sobras del final.
      finePriority[j] = ebits[j]! * (den << BITRES) >= bits[j]! + offset ? 1 : 0;
      bits[j] = bits[j]! - ((channels * ebits[j]!) << BITRES);
    } else {
      // Con una sola muestra todo va a energía fina menos el bit de signo.
      excess = Math.max(0, bits[j]! - (channels << BITRES));
      bits[j] = bits[j]! - excess;
      ebits[j] = 0;
      finePriority[j] = 1;
    }

    // La energía fina no se beneficia del rebalanceo que hacen las bandas, así
    // que su parte se rebalancea aquí.
    if (excess > 0) {
      const extraFine = Math.min(excess >> (stereo + BITRES), MAX_FINE_BITS - ebits[j]!);
      ebits[j] = ebits[j]! + extraFine;
      const extraBits = (extraFine * channels) << BITRES;
      finePriority[j] = extraBits >= excess - balance ? 1 : 0;
      excess -= extraBits;
    }
    balance = excess;
  }

  // Las bandas saltadas gastan todo lo suyo en energía fina.
  for (; j < end; j++) {
    ebits[j] = bits[j]! >> stereo >> BITRES;
    bits[j] = 0;
    finePriority[j] = ebits[j]! < 1 ? 1 : 0;
  }

  return { codedBands, pulses: bits, ebits, finePriority, balance, intensity, dualStereo };
}
