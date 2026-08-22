/**
 * Operaciones sobre bandas: Hadamard, estéreo y la trigonometría bit-exacta.
 *
 * Son las piezas sueltas que usa `quantBand`. Se han separado porque cada una se
 * puede probar por su cuenta, y porque dos de ellas tienen una propiedad que hay
 * que respetar a rajatabla:
 *
 * ## Por qué hay un coseno entero
 *
 * `bitexactCos` y `bitexactLog2Tan` no usan `Math.cos` ni `Math.log`. Son
 * aproximaciones **en aritmética entera**, y eso no es una optimización heredada
 * del hardware antiguo: es que su resultado **decide el reparto de bits entre el
 * mid y el side**, y ese reparto lo recalcula el decodificador por su cuenta. Si
 * los dos lados usaran coma flotante y difirieran en el último bit en algún
 * ángulo, repartirían distinto y el flujo se rompería. Con enteros, dan lo mismo
 * en cualquier máquina.
 *
 * ## La transformada de Haar
 *
 * `haar1` es la que permite cambiar resolución entre tiempo y frecuencia sin
 * perder nada: mezcla pares de muestras en suma y diferencia, escaladas por
 * `1/√2`. Aplicarla dos veces devuelve el original, y es lo que hace que una
 * trama con un golpe seco pueda usar más resolución temporal.
 *
 * ---
 * Port de `celt/bands.c`, `celt/vq.c` y `celt/mathops.h` de la implementación de
 * referencia de la RFC 6716 (rama de coma flotante). Copyright 1994-2011 IETF
 * Trust, Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin,
 * Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding,
 * Erik de Castro Lopo. BSD-3-Clause.
 */

import { BITRES } from './tables';

const EPSILON = 1e-15;
const SQRT_HALF = 0.70710678;

/** Generador congruencial del formato: el ruido de relleno tiene que ser igual en los dos lados. */
export function celtLcgRand(seed: number): number {
  return (Math.imul(1664525, seed) + 1013904223) >>> 0;
}

/** `(16384 + a*b) >> 15` con truncado de 16 bits, como el macro de la referencia. */
export function fracMul16(a: number, b: number): number {
  return (16384 + ((a << 16) >> 16) * ((b << 16) >> 16)) >> 15;
}

/**
 * Coseno en aritmética entera, sobre un cuarto de vuelta en 16384 pasos.
 *
 * Bit-exacto a propósito: de su resultado sale el reparto de bits entre mid y
 * side, que el decodificador recalcula. Un `Math.cos` que difiriera en el último
 * bit en un solo ángulo rompería el flujo.
 */
export function bitexactCos(x: number): number {
  const tmp = (4096 + x * x) >> 13;
  let x2 = tmp;
  x2 = 32767 - x2 + fracMul16(x2, -7651 + fracMul16(x2, 8277 + fracMul16(-626, x2)));
  return 1 + x2;
}

/** `log2(tan(θ))` en aritmética entera, a partir del seno y el coseno enteros. */
export function bitexactLog2Tan(isin: number, icos: number): number {
  const lc = 32 - Math.clz32(icos);
  const ls = 32 - Math.clz32(isin);
  const c = icos << (15 - lc);
  const s = isin << (15 - ls);
  return (
    (ls - lc) * (1 << 11) +
    fracMul16(s, fracMul16(s, -2597) + 7932) -
    fracMul16(c, fracMul16(c, -2597) + 7932)
  );
}

/** Raíz entera exacta, para invertir la CDF triangular del ángulo. */
export function isqrt32(value: number): number {
  let root = Math.floor(Math.sqrt(value));
  // `Math.sqrt` puede quedarse a un paso por el redondeo del double.
  while ((root + 1) * (root + 1) <= value) root++;
  while (root * root > value) root--;
  return root;
}

/**
 * Transformada de Haar de un nivel: pares en suma y diferencia, escalados.
 *
 * Es su propia inversa salvo por el orden, que es lo que la hace útil para
 * cambiar de resolución tiempo/frecuencia sin perder información.
 */
export function haar1(x: Float64Array, at: number, n0: number, stride: number): void {
  const half = n0 >> 1;
  for (let i = 0; i < stride; i++) {
    for (let j = 0; j < half; j++) {
      const a = SQRT_HALF * x[at + stride * 2 * j + i]!;
      const b = SQRT_HALF * x[at + stride * (2 * j + 1) + i]!;
      x[at + stride * 2 * j + i] = a + b;
      x[at + stride * (2 * j + 1) + i] = a - b;
    }
  }
}

/**
 * Orden de los sub-bloques cuando se reorganizan por Hadamard.
 *
 * No es el orden natural: pone primero el último y luego los va intercalando,
 * para que los bloques adyacentes en el resultado no sean adyacentes en el
 * tiempo. Así, si una partición se queda sin bits, el hueco no cae todo seguido.
 */
export const ORDERY_TABLE = [
  1, 0,
  3, 0, 2, 1,
  7, 0, 4, 3, 6, 1, 5, 2,
  15, 0, 8, 7, 12, 3, 11, 4, 14, 1, 9, 6, 13, 2, 10, 5,
] as const;

/** Pasa de orden por frecuencia a orden por tiempo. */
export function deinterleaveHadamard(
  x: Float64Array,
  at: number,
  n0: number,
  stride: number,
  hadamard: boolean,
): void {
  const n = n0 * stride;
  const tmp = new Float64Array(n);
  if (hadamard) {
    const base = stride - 2;
    for (let i = 0; i < stride; i++) {
      const order = ORDERY_TABLE[base + i]!;
      for (let j = 0; j < n0; j++) tmp[order * n0 + j] = x[at + j * stride + i]!;
    }
  } else {
    for (let i = 0; i < stride; i++) {
      for (let j = 0; j < n0; j++) tmp[i * n0 + j] = x[at + j * stride + i]!;
    }
  }
  for (let j = 0; j < n; j++) x[at + j] = tmp[j]!;
}

/** Deshace `deinterleaveHadamard`. */
export function interleaveHadamard(
  x: Float64Array,
  at: number,
  n0: number,
  stride: number,
  hadamard: boolean,
): void {
  const n = n0 * stride;
  const tmp = new Float64Array(n);
  if (hadamard) {
    const base = stride - 2;
    for (let i = 0; i < stride; i++) {
      const order = ORDERY_TABLE[base + i]!;
      for (let j = 0; j < n0; j++) tmp[j * stride + i] = x[at + order * n0 + j]!;
    }
  } else {
    for (let i = 0; i < stride; i++) {
      for (let j = 0; j < n0; j++) tmp[j * stride + i] = x[at + i * n0 + j]!;
    }
  }
  for (let j = 0; j < n; j++) x[at + j] = tmp[j]!;
}

/**
 * Estéreo por intensidad: los dos canales pasan a compartir una sola forma.
 *
 * Por encima de cierta frecuencia el oído deja de localizar por diferencia de
 * fase y sólo atiende al nivel de cada lado, así que mandar dos formas es tirar
 * bits. Se mezcla en una y el nivel de cada canal lo pone su energía.
 */
export function intensityStereo(
  x: Float64Array,
  y: Float64Array,
  atX: number,
  atY: number,
  bandE: Float64Array,
  bands: number,
  band: number,
  n: number,
): void {
  const left = bandE[band]!;
  const right = bandE[band + bands]!;
  const norm = EPSILON + Math.sqrt(EPSILON + left * left + right * right);
  const a1 = left / norm;
  const a2 = right / norm;
  for (let j = 0; j < n; j++) {
    x[atX + j] = a1 * x[atX + j]! + a2 * y[atY + j]!;
    // El side no se codifica: no hace falta calcularlo.
  }
}

/** Pasa de izquierda/derecha a mid/side. */
export function stereoSplit(
  x: Float64Array,
  y: Float64Array,
  atX: number,
  atY: number,
  n: number,
): void {
  for (let j = 0; j < n; j++) {
    const l = SQRT_HALF * x[atX + j]!;
    const r = SQRT_HALF * y[atY + j]!;
    x[atX + j] = l + r;
    y[atY + j] = r - l;
  }
}

/**
 * Vuelve de mid/side a izquierda/derecha, reescalando cada canal a norma 1.
 *
 * El caso degenerado importa: si uno de los dos canales sale con energía casi
 * nula, dividir por su raíz daría un número enorme. Entonces se copia el otro
 * canal tal cual — mono, que es lo que la señal estaba diciendo de todos modos.
 */
export function stereoMerge(
  x: Float64Array,
  y: Float64Array,
  atX: number,
  atY: number,
  mid: number,
  n: number,
): void {
  let xp = 0;
  let side = 0;
  for (let j = 0; j < n; j++) {
    xp += x[atX + j]! * y[atY + j]!;
    side += y[atY + j]! * y[atY + j]!;
  }
  xp *= mid;
  const el = mid * mid + side - 2 * xp;
  const er = mid * mid + side + 2 * xp;

  if (er < 6e-4 || el < 6e-4) {
    for (let j = 0; j < n; j++) y[atY + j] = x[atX + j]!;
    return;
  }

  const lgain = 1 / Math.sqrt(el);
  const rgain = 1 / Math.sqrt(er);
  for (let j = 0; j < n; j++) {
    const l = mid * x[atX + j]!;
    const r = y[atY + j]!;
    x[atX + j] = lgain * (l - r);
    y[atY + j] = rgain * (l + r);
  }
}

/**
 * El ángulo entre mid y side, en 16384 pasos por cuarto de vuelta.
 *
 * Con ese único número se pueden reescalar mid y side otra vez, porque los dos
 * tienen norma 1 y son ortogonales: es toda la información del balance estéreo
 * de la banda en un parámetro.
 */
export function stereoItheta(
  x: Float64Array,
  y: Float64Array,
  atX: number,
  atY: number,
  stereo: boolean,
  n: number,
): number {
  let emid = EPSILON;
  let eside = EPSILON;
  if (stereo) {
    for (let i = 0; i < n; i++) {
      const m = x[atX + i]! + y[atY + i]!;
      const s = x[atX + i]! - y[atY + i]!;
      emid += m * m;
      eside += s * s;
    }
  } else {
    for (let i = 0; i < n; i++) {
      emid += x[atX + i]! * x[atX + i]!;
      eside += y[atY + i]! * y[atY + i]!;
    }
  }
  // 0,63662 = 2/π: lleva el arco de [0, π/2] a [0, 16384].
  return Math.floor(0.5 + 16384 * 0.63662 * Math.atan2(Math.sqrt(eside), Math.sqrt(emid)));
}

/** Cuántos pasos de ángulo caben en el presupuesto. Port de `compute_qn`. */
export function computeQn(
  n: number,
  b: number,
  offset: number,
  pulseCap: number,
  stereo: boolean,
): number {
  const exp2Table8 = [16384, 17866, 19483, 21247, 23170, 25267, 27554, 30048];
  let n2 = 2 * n - 1;
  if (stereo && n === 2) n2--;
  // El tope de arriba garantiza que en una partición estéreo con el ángulo al
  // máximo queden bits para al menos un pulso en el side; si no, se colapsaría
  // y encima no se le hace folding.
  let qb = Math.min(b - pulseCap - (4 << BITRES), Math.floor((b + n2 * offset) / n2));
  qb = Math.min(8 << BITRES, qb);
  if (qb < (1 << BITRES) >> 1) return 1;
  const qn = exp2Table8[qb & 0x7]! >> (14 - (qb >> BITRES));
  return ((qn + 1) >> 1) << 1;
}

/** Reordena los bits de `fill` al recombinar bandas. */
export const BIT_INTERLEAVE_TABLE = [0, 1, 1, 1, 2, 3, 3, 3, 2, 3, 3, 3, 2, 3, 3, 3] as const;
/** Y al deshacer la recombinación. */
export const BIT_DEINTERLEAVE_TABLE = [
  0x00, 0x03, 0x0c, 0x0f, 0x30, 0x33, 0x3c, 0x3f, 0xc0, 0xc3, 0xcc, 0xcf, 0xf0, 0xf3, 0xfc, 0xff,
] as const;
