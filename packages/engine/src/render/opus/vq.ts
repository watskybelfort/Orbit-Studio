/**
 * Cuantización PVQ de una banda, con la rotación de dispersión de CELT.
 *
 * `pvq.ts` sabe contar, numerar y buscar pulsos. Esto es la capa que lo usa de
 * verdad dentro del códec, y añade lo que hace que suene bien en vez de sólo ser
 * correcto:
 *
 * ## La rotación, que es lo que evita el sonido metálico
 *
 * Con pocos pulsos para muchas muestras, el PVQ deja **casi todo a cero** y
 * concentra la energía en dos o tres picos. Eso, en el dominio de la frecuencia,
 * suena a tono: aparece el zumbido metálico que delata a los códecs baratos.
 *
 * La solución de CELT es girar el vector con una rotación de ángulo pequeño
 * ANTES de cuantizar y deshacerla después. Lo que era un pico aislado pasa a
 * repartirse entre sus vecinos, y el resultado tiene el mismo contenido pero
 * suena a ruido en vez de a tono — que es justo lo que debe sonar el detalle
 * fino de una banda.
 *
 * El ángulo depende de cuántos pulsos hay por muestra: **con bastantes pulsos
 * (`2K >= N`) no se rota nada**, porque ya no hay concentración que deshacer.
 *
 * ## La máscara de colapso
 *
 * Cuando una trama se parte en varias MDCT cortas, `alg_quant` devuelve qué
 * sub-bloques recibieron al menos un pulso. Los que no recibieron ninguno se
 * quedarían en silencio absoluto, y en un transitorio eso se oye como un hueco;
 * el decodificador les mete ruido con `anti_collapse`. Esa máscara es lo que se
 * lo dice.
 *
 * ---
 * Port de `celt/vq.c` de la implementación de referencia de la RFC 6716 (rama de
 * coma flotante). Copyright 1994-2011 IETF Trust, Xiph.Org, Skype Limited,
 * Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell,
 * Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { pvqDeindex, pvqIndex, pvqSize } from './pvq';
import { fitsIn32 } from './rate';
import type { RangeDecoder, RangeEncoder } from './range-coder';

/** Modos de dispersión, tal y como los numera el formato. */
export const SPREAD_NONE = 0;
export const SPREAD_LIGHT = 1;
export const SPREAD_NORMAL = 2;
export const SPREAD_AGGRESSIVE = 3;

/** Cuánto se cierra el ángulo según el modo. Menos factor, más rotación. */
const SPREAD_FACTOR = [15, 10, 5];

const EPSILON = 1e-15;

/** Un paso de la rotación, sobre pares separados por `stride`. */
function rotate1(x: Float64Array, at: number, len: number, stride: number, c: number, s: number): void {
  for (let i = 0; i < len - stride; i++) {
    const x1 = x[at + i]!;
    const x2 = x[at + i + stride]!;
    x[at + i + stride] = c * x2 + s * x1;
    x[at + i] = c * x1 - s * x2;
  }
  // La segunda pasada va hacia atrás: entre las dos, cada muestra acaba mezclada
  // con las de los dos lados, no sólo con las de delante.
  for (let i = len - 2 * stride - 1; i >= 0; i--) {
    const x1 = x[at + i]!;
    const x2 = x[at + i + stride]!;
    x[at + i + stride] = c * x2 + s * x1;
    x[at + i] = c * x1 - s * x2;
  }
}

/**
 * Rotación de dispersión. `dir` es +1 antes de cuantizar y −1 para deshacerla.
 *
 * Con `2K >= N` no hace nada: hay pulsos de sobra y no queda concentración que
 * repartir.
 */
export function expRotation(
  x: Float64Array,
  at: number,
  len: number,
  dir: number,
  blocks: number,
  k: number,
  spread: number,
): void {
  if (2 * k >= len || spread === SPREAD_NONE) return;
  const factor = SPREAD_FACTOR[spread - 1]!;

  const gain = len / (len + factor * k);
  const theta = 0.5 * gain * gain;
  const c = Math.cos((Math.PI / 2) * theta);
  const s = Math.cos((Math.PI / 2) * (1 - theta)); // = sin(pi/2 · theta)

  let stride2 = 0;
  if (len >= 8 * blocks) {
    stride2 = 1;
    // Raíz cuadrada de len/blocks, con redondeo, sin llamar a sqrt: se
    // incrementa mientras (stride2+0.5)² < len/blocks.
    while ((stride2 * stride2 + stride2) * blocks + (blocks >> 2) < len) stride2++;
  }

  const sub = Math.floor(len / blocks);
  for (let i = 0; i < blocks; i++) {
    const base = at + i * sub;
    if (dir < 0) {
      if (stride2) rotate1(x, base, sub, stride2, s, c);
      rotate1(x, base, sub, 1, c, s);
    } else {
      rotate1(x, base, sub, 1, c, -s);
      if (stride2) rotate1(x, base, sub, stride2, s, -c);
    }
  }
}

/** Qué sub-bloques recibieron al menos un pulso, en bits. */
export function extractCollapseMask(iy: Int32Array, n: number, blocks: number): number {
  if (blocks <= 1) return 1;
  const sub = Math.floor(n / blocks);
  let mask = 0;
  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < sub; j++) {
      if (iy[i * sub + j] !== 0) mask |= 1 << i;
    }
  }
  return mask;
}

/** Reconstruye la forma normalizada a partir de los pulsos. */
function normaliseResidual(
  iy: Int32Array,
  x: Float64Array,
  at: number,
  n: number,
  ryy: number,
  gain: number,
): void {
  const g = gain / Math.sqrt(ryy);
  for (let i = 0; i < n; i++) x[at + i] = g * iy[i]!;
}

/** Deja el vector con la norma pedida. */
export function renormaliseVector(x: Float64Array, at: number, n: number, gain: number): void {
  let energy = EPSILON;
  for (let i = 0; i < n; i++) energy += x[at + i]! * x[at + i]!;
  const g = gain / Math.sqrt(energy);
  for (let i = 0; i < n; i++) x[at + i] = x[at + i]! * g;
}

/**
 * Cuantiza una banda con `k` pulsos y la escribe.
 *
 * **Modifica `x` in situ**: al salir contiene la forma reconstruida, que es la
 * que el codificador necesita para saber qué va a oír el decodificador (y para
 * que el estéreo y las particiones siguientes partan de lo mismo que él).
 *
 * Devuelve la máscara de colapso.
 */
export function algQuant(
  x: Float64Array,
  at: number,
  n: number,
  k: number,
  spread: number,
  blocks: number,
  enc: RangeEncoder,
  gain: number,
): number {
  if (k <= 0) throw new Error('algQuant necesita al menos un pulso');
  if (n <= 1) throw new Error('algQuant necesita al menos dos dimensiones');

  expRotation(x, at, n, 1, blocks, k, spread);

  const iy = new Int32Array(n);
  const y = new Float64Array(n);
  const signx = new Int8Array(n);
  // El signo se aparta del problema: la búsqueda trabaja con magnitudes.
  for (let j = 0; j < n; j++) {
    if (x[at + j]! > 0) {
      signx[j] = 1;
    } else {
      signx[j] = -1;
      x[at + j] = -x[at + j]!;
    }
  }

  let xy = 0;
  let yy = 0;
  let pulsesLeft = k;

  // Arranque por proyección cuando hay muchos pulsos: colocarlos de uno en uno
  // costaría K·N comparaciones y daría lo mismo.
  if (k > n >> 1) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += x[at + j]!;
    // Un vector degenerado (silencio, o infinitos por un fallo aguas arriba)
    // haría que la proyección repartiera pulsos de más. Se sustituye por un
    // impulso, que es codificable y no miente más que el silencio.
    if (!(sum > EPSILON && sum < 64)) {
      x[at] = 1;
      for (let j = 1; j < n; j++) x[at + j] = 0;
      sum = 1;
    }
    const rcp = (k - 1) / sum;
    for (let j = 0; j < n; j++) {
      iy[j] = Math.floor(rcp * x[at + j]!);
      y[j] = iy[j]!;
      yy += y[j]! * y[j]!;
      xy += x[at + j]! * y[j]!;
      // `y` se guarda al doble para no multiplicar dentro del bucle caliente.
      y[j] = y[j]! * 2;
      pulsesLeft -= iy[j]!;
    }
  }

  // Red de seguridad: si la proyección dejó demasiados, todos al primer bin.
  if (pulsesLeft > n + 3) {
    const tmp = pulsesLeft;
    yy += tmp * tmp + tmp * y[0]!;
    iy[0] = iy[0]! + pulsesLeft;
    pulsesLeft = 0;
  }

  for (let i = 0; i < pulsesLeft; i++) {
    let bestId = 0;
    let bestNum = -1e15;
    let bestDen = 0;
    // El término del cuadrado se suma igual, así que se saca del bucle.
    yy += 1;
    for (let j = 0; j < n; j++) {
      const rxy = (xy + x[at + j]!) ** 2;
      const ryy = yy + y[j]!;
      // Se busca el máximo de Rxy/sqrt(Ryy) sin dividir ni sacar raíces:
      // comparar num/den contra best_num/best_den es multiplicar en cruz.
      if (bestDen * rxy > ryy * bestNum) {
        bestDen = ryy;
        bestNum = rxy;
        bestId = j;
      }
    }
    xy += x[at + bestId]!;
    yy += y[bestId]!;
    y[bestId] = y[bestId]! + 2;
    iy[bestId] = iy[bestId]! + 1;
  }

  // Se devuelve el signo.
  for (let j = 0; j < n; j++) {
    x[at + j] = signx[j]! * x[at + j]!;
    if (signx[j]! < 0 && iy[j] !== 0) iy[j] = -iy[j]!;
  }

  encodePulses(iy, n, k, enc);

  // Reconstrucción: el codificador tiene que ver lo mismo que verá el otro lado.
  let ryy = 0;
  for (let j = 0; j < n; j++) ryy += iy[j]! * iy[j]!;
  normaliseResidual(iy, x, at, n, ryy, gain);
  expRotation(x, at, n, -1, blocks, k, spread);

  return extractCollapseMask(iy, n, blocks);
}

/** Lee una banda cuantizada y reconstruye su forma. La inversa de `algQuant`. */
export function algUnquant(
  x: Float64Array,
  at: number,
  n: number,
  k: number,
  spread: number,
  blocks: number,
  dec: RangeDecoder,
  gain: number,
): number {
  if (k <= 0) throw new Error('algUnquant necesita al menos un pulso');
  if (n <= 1) throw new Error('algUnquant necesita al menos dos dimensiones');
  const iy = decodePulses(n, k, dec);
  let ryy = 0;
  for (let i = 0; i < n; i++) ryy += iy[i]! * iy[i]!;
  normaliseResidual(iy, x, at, n, ryy, gain);
  expRotation(x, at, n, -1, blocks, k, spread);
  return extractCollapseMask(iy, n, blocks);
}

/**
 * Comprueba que la palabra de código cabe en los 32 bits del formato.
 *
 * Que esto salte no es un error del cuantizador: es que quien llama tenía que
 * haber **partido la banda** antes. Con `n=44` y `k=20`, por ejemplo, la palabra
 * ocuparía 153 bits. Por eso `quantBand` divide recursivamente en vez de pedir
 * lo imposible, y por eso el mensaje lo dice.
 */
function assertCodable(n: number, k: number): void {
  if (!fitsIn32(n, k)) {
    throw new Error(
      `V(${n}, ${k}) no cabe en los 32 bits del formato: la banda hay que partirla antes`,
    );
  }
}

/** Escribe el vector de pulsos como un entero uniforme sobre `V(n,k)`. */
export function encodePulses(iy: Int32Array, n: number, k: number, enc: RangeEncoder): void {
  assertCodable(n, k);
  enc.uint(pvqIndex(Array.from(iy.subarray(0, n))), pvqSize(n, k));
}

/** Lee el vector de pulsos. */
export function decodePulses(n: number, k: number, dec: RangeDecoder): Int32Array {
  assertCodable(n, k);
  return Int32Array.from(pvqDeindex(n, k, dec.uint(pvqSize(n, k))));
}
