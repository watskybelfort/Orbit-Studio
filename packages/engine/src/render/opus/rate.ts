/**
 * Caché de pulsos y conversión bits ↔ pulsos.
 *
 * Todo el asignador de bits de CELT se apoya en una pregunta que hay que
 * responder miles de veces por trama: *«con este presupuesto de bits, ¿cuántos
 * pulsos caben en esta banda?»*. La respuesta exacta sale de `log2(V(n,k))`, pero
 * calcular eso en caliente es impensable, así que CELT **precalcula una tabla**
 * por cada tamaño de banda distinto y luego busca en ella por bisección.
 *
 * Lo importante de este módulo es que **la tabla no se transcribe: se genera**.
 * Sale de los bordes de banda y de `V(n,k)`, que ya está validado por dos
 * caminos independientes. Eso quita de en medio unos mil números que habría
 * habido que copiar a mano sin poder comprobarlos.
 *
 * ## Por qué el logaritmo es de coma fija y no `Math.log2`
 *
 * `log2Frac` no es una aproximación cómoda: es **parte del formato**. El
 * decodificador recalcula la misma tabla con la misma función, y si el
 * codificador usara `Math.log2` la tabla saldría distinta en algún valor y los
 * dos lados repartirían los bits de forma diferente. A partir de ahí el flujo se
 * desincroniza y no hay vuelta atrás. Por eso está portada al bit, redondeos
 * incluidos.
 *
 * ---
 * Port de `celt/rate.c`, `celt/rate.h` y `celt/cwrs.c` de la implementación de
 * referencia de la RFC 6716. Copyright 1994-2011 IETF Trust, Xiph.Org,
 * Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO,
 * Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { pvqSizeRow } from './pvq';
import { BITRES, EBAND_5MS, FITS32_MAX_K, FITS32_MAX_N, NB_BANDS } from './tables';

/** Pulsos "pseudo": la caché no guarda todos los K, sólo una rejilla creciente. */
export const MAX_PSEUDO = 40;
export const LOG_MAX_PSEUDO = 6;
export const MAX_PULSES = 128;
export const MAX_FINE_BITS = 8;
export const FINE_OFFSET = 21;
export const QTHETA_OFFSET = 4;
export const QTHETA_OFFSET_TWOPHASE = 16;

/** Posición del bit más alto, +1. `ilog(0) = 0`, `ilog(1) = 1`, `ilog(255) = 8`. */
export function ilog(value: number): number {
  return 32 - Math.clz32(value);
}

/**
 * Logaritmo binario en coma fija con `frac` bits de parte fraccionaria,
 * **redondeando siempre hacia arriba**.
 *
 * Port literal de `log2_frac`. Las dos cosas que parecen detalles y no lo son:
 * el redondeo al alza (garantiza que el coste estimado nunca se queda corto, que
 * es lo que evita pasarse del presupuesto) y la aritmética de 32 bits con
 * desbordamiento — de ahí los `>>> 0`, que aquí emulan el `opus_uint32` de C.
 */
export function log2Frac(value: number, frac: number): number {
  let val = value >>> 0;
  let l = ilog(val);
  // Las potencias exactas de dos no necesitan redondeo.
  if ((val & (val - 1)) === 0) return (l - 1) << frac;

  if (l > 16) {
    const shift = l - 16;
    val = (val >>> shift) + ((((val & ((1 << shift) - 1)) + (1 << shift) - 1) >>> shift) >>> 0);
  } else {
    val = (val << (16 - l)) >>> 0;
  }
  l = (l - 1) << frac;
  // El peso baja a la mitad en cada vuelta (frac, frac-1, … 0): eso es la parte
  // fraccionaria construyéndose bit a bit. Si el desplazamiento se dejara fijo,
  // cada bit valdría lo mismo que el primero y el logaritmo saldría inflado.
  //
  // Siempre hace falta una vuelta más de las que dice `frac`: el redondeo de
  // arriba puede haber cambiado la parte entera.
  let weight = frac;
  for (;;) {
    const b = val >>> 16;
    l += b << weight;
    val = (val + b) >>> b;
    val = ((val * val + 0x7fff) >>> 0) >>> 15;
    if (weight-- <= 0) break;
  }
  return l + (val > 0x8000 ? 1 : 0);
}

/** Rejilla de pulsos de la caché: 0..7 uno a uno, y a partir de ahí a saltos. */
export function getPulses(i: number): number {
  return i < 8 ? i : (8 + (i & 7)) << ((i >> 3) - 1);
}

/** ¿Cabe `V(n,k)` en 32 bits? Si no, la banda hay que partirla. */
export function fitsIn32(n: number, k: number): boolean {
  if (n >= 14) {
    if (k >= 14) return false;
    return n <= FITS32_MAX_N[k]!;
  }
  return k <= FITS32_MAX_K[n]!;
}

/**
 * Coste en octavos de bit de mandar `k` pulsos en `n` muestras, para todo `k`
 * hasta `maxK`. Port de `get_required_bits`.
 */
export function requiredBits(n: number, maxK: number, frac: number): Int32Array {
  const bits = new Int32Array(maxK + 1);
  if (n === 1) {
    // Una sola muestra: sólo hay que mandar el signo.
    for (let k = 1; k <= maxK; k++) bits[k] = 1 << frac;
    return bits;
  }
  // Fuera de este dominio `V(n,k)` no cabe en 32 bits, y `log2Frac` —que trabaja
  // en aritmética de 32 bits, como el formato— daría la vuelta y devolvería un
  // coste MENOR al pedir más pulsos. Eso no se puede dejar pasar en silencio:
  // el asignador creería que le caben pulsos que no le caben. Quien llame aquí
  // tiene que haber limitado `maxK` con `fitsIn32` antes, como hace la caché.
  if (!fitsIn32(n, maxK)) {
    throw new Error(`V(${n}, ${maxK}) no cabe en 32 bits: la banda hay que partirla antes`);
  }
  const sizes = pvqSizeRow(n, maxK);
  for (let k = 1; k <= maxK; k++) bits[k] = log2Frac(sizes[k]!, frac);
  return bits;
}

/** `logN[banda]`: el ancho de la banda, en la misma escala logarítmica. */
export function computeLogN(ebands: readonly number[]): Int32Array {
  const out = new Int32Array(ebands.length - 1);
  for (let i = 0; i < out.length; i++) out[i] = log2Frac(ebands[i + 1]! - ebands[i]!, BITRES);
  return out;
}

export interface PulseCache {
  /** `index[LM * nbBands + banda]` → posición en `bits`, o −1 si la banda es vacía. */
  index: Int16Array;
  /** Costes concatenados. `bits[pos]` es el K máximo; `bits[pos+j]`, el coste de `getPulses(j)`. */
  bits: Uint8Array;
  /** Techo de bits por banda: `caps[(LM*2 + (canales-1)) * nbBands + banda]`. */
  caps: Uint8Array;
  bands: number;
  maxLM: number;
}

/**
 * Genera la caché completa. Port de `compute_pulse_cache`.
 *
 * La idea que hace que la tabla sea pequeña: **muchas bandas tienen el mismo
 * tamaño** en distintos tamaños de trama, y para el coste sólo importa el
 * tamaño. Así que primero se buscan los tamaños únicos y sólo se calcula uno por
 * cada uno; el resto apunta al mismo sitio.
 */
export function computePulseCache(ebands: readonly number[], maxLM: number): PulseCache {
  const bands = ebands.length - 1;
  const index = new Int16Array(bands * (maxLM + 2)).fill(-1);
  const entryN: number[] = [];
  const entryK: number[] = [];
  const entryAt: number[] = [];
  let cursor = 0;

  for (let i = 0; i <= maxLM + 1; i++) {
    for (let j = 0; j < bands; j++) {
      const n = ((ebands[j + 1]! - ebands[j]!) << i) >> 1;
      index[i * bands + j] = -1;
      // ¿Hay ya otra banda con este mismo tamaño? Entonces comparten entrada.
      for (let k = 0; k <= i; k++) {
        for (let m = 0; m < bands && (k !== i || m < j); m++) {
          if (n === ((ebands[m + 1]! - ebands[m]!) << k) >> 1) {
            index[i * bands + j] = index[k * bands + m]!;
            break;
          }
        }
      }
      if (index[i * bands + j] === -1 && n !== 0) {
        let k = 0;
        while (fitsIn32(n, getPulses(k + 1)) && k < MAX_PSEUDO) k++;
        entryN.push(n);
        entryK.push(k);
        entryAt.push(cursor);
        index[i * bands + j] = cursor;
        cursor += k + 1;
      }
    }
  }

  const bits = new Uint8Array(cursor);
  for (let e = 0; e < entryN.length; e++) {
    const at = entryAt[e]!;
    const k = entryK[e]!;
    const costs = requiredBits(entryN[e]!, getPulses(k), BITRES);
    for (let j = 1; j <= k; j++) bits[at + j] = costs[getPulses(j)]! - 1;
    bits[at] = k;
  }

  return { index, bits, caps: computeCaps(ebands, index, bits, maxLM), bands, maxLM };
}

/**
 * Techo de bits por banda: a partir de aquí, dar más bits no mejora nada porque
 * la banda ya no sabe gastarlos. Port de la segunda mitad de
 * `compute_pulse_cache`.
 */
function computeCaps(
  ebands: readonly number[],
  index: Int16Array,
  bits: Uint8Array,
  maxLM: number,
): Uint8Array {
  const bands = ebands.length - 1;
  const logN = computeLogN(ebands);
  const caps = new Uint8Array((maxLM + 1) * 2 * bands);
  let at = 0;

  for (let i = 0; i <= maxLM; i++) {
    for (let channels = 1; channels <= 2; channels++) {
      for (let j = 0; j < bands; j++) {
        let n0 = ebands[j + 1]! - ebands[j]!;
        let maxBits: number;

        if (n0 << i === 1) {
          // Una banda de una muestra sólo lleva signo y bits finos.
          maxBits = (channels * (1 + MAX_FINE_BITS)) << BITRES;
        } else {
          let lm0 = 0;
          if (n0 > 2) {
            n0 >>= 1;
            lm0--;
          } else if (n0 <= 1) {
            lm0 = Math.min(i, 1);
            n0 <<= lm0;
          }
          // Coste del PVQ más pequeño de una banda partida del todo.
          const at0 = index[(lm0 + 1) * bands + j]!;
          maxBits = bits[at0 + bits[at0]!]! + 1;

          // Coste de cada partición sucesiva.
          let n = n0;
          for (let k = 0; k < i - lm0; k++) {
            maxBits <<= 1;
            const offset = ((logN[j]! + ((lm0 + k) << BITRES)) >> 1) - QTHETA_OFFSET;
            // El coste medido de theta es 0,897 veces qb; aquí, 459/512.
            const num = 459 * ((2 * n - 1) * offset + maxBits);
            const den = ((2 * n - 1) << 9) - 459;
            maxBits += Math.min(Math.floor((num + (den >> 1)) / den), 57);
            n <<= 1;
          }

          if (channels === 2) {
            maxBits <<= 1;
            const offset =
              ((logN[j]! + (i << BITRES)) >> 1) -
              (n === 2 ? QTHETA_OFFSET_TWOPHASE : QTHETA_OFFSET);
            const ndof = 2 * n - 1 - (n === 2 ? 1 : 0);
            const num = (n === 2 ? 512 : 487) * (maxBits + ndof * offset);
            const den = (ndof << 9) - (n === 2 ? 512 : 487);
            maxBits += Math.min(Math.floor((num + (den >> 1)) / den), n === 2 ? 64 : 61);
          }

          // Y los bits finos que se van a gastar.
          const ndof = channels * n + (channels === 2 && n > 2 ? 1 : 0);
          let offset = ((logN[j]! + (i << BITRES)) >> 1) - FINE_OFFSET;
          if (n === 2) offset += (1 << BITRES) >> 2; // N=2 se sale de la curva
          const num = maxBits + ndof * offset;
          const den = (ndof - 1) << BITRES;
          const qb = Math.min(Math.floor((num + (den >> 1)) / den), MAX_FINE_BITS);
          maxBits += (channels * qb) << BITRES;
        }

        const width = (ebands[j + 1]! - ebands[j]!) << i;
        const cap = Math.floor((4 * maxBits) / (channels * width)) - 64;
        if (cap < 0 || cap > 255) {
          throw new Error(`techo fuera de rango en banda ${j}, LM ${i}, ${channels} canales: ${cap}`);
        }
        caps[at++] = cap;
      }
    }
  }
  return caps;
}

/**
 * Cuántos pulsos caben en `bits` octavos de bit. Port de `bits2pulses`.
 *
 * Es una bisección de exactamente `LOG_MAX_PSEUDO` pasos —siempre las mismas, sin
 * salir antes— porque encoder y decoder tienen que recorrer el mismo camino y
 * llegar al mismo sitio.
 */
export function bitsToPulses(cache: PulseCache, band: number, lm: number, bits: number): number {
  const at = cache.index[(lm + 1) * cache.bands + band]!;
  let lo = 0;
  let hi = cache.bits[at]!;
  const target = bits - 1;
  for (let i = 0; i < LOG_MAX_PSEUDO; i++) {
    const mid = (lo + hi + 1) >> 1;
    if (cache.bits[at + mid]! >= target) hi = mid;
    else lo = mid;
  }
  const below = lo === 0 ? -1 : cache.bits[at + lo]!;
  return target - below <= cache.bits[at + hi]! - target ? lo : hi;
}

/** Coste en octavos de bit de `pulses` pseudo-pulsos. Port de `pulses2bits`. */
export function pulsesToBits(cache: PulseCache, band: number, lm: number, pulses: number): number {
  if (pulses === 0) return 0;
  const at = cache.index[(lm + 1) * cache.bands + band]!;
  return cache.bits[at + pulses]! + 1;
}

/** Techo de bits de una banda, del `caps` precalculado. */
export function bandCap(cache: PulseCache, band: number, lm: number, channels: number): number {
  return cache.caps[(lm * 2 + (channels - 1)) * cache.bands + band]!;
}

/** El modo estándar de Opus a 48 kHz: 21 bandas, tramas de 120 a 960 muestras. */
export const OPUS_EBANDS: readonly number[] = EBAND_5MS;
export const OPUS_MAX_LM = 3;

let standardCache: PulseCache | null = null;

/** Caché del modo estándar. Se calcula una vez: son unos milisegundos. */
export function opusPulseCache(): PulseCache {
  standardCache ??= computePulseCache(OPUS_EBANDS, OPUS_MAX_LM);
  return standardCache;
}

export { NB_BANDS };
