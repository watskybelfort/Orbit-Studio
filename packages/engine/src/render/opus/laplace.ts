/**
 * Codificador Laplace: el modelo con el que CELT manda la energía de las bandas.
 *
 * La energía de una banda casi siempre se parece a la de la trama anterior, así
 * que lo que se transmite es el **residuo**: un entero con signo que suele ser 0,
 * a veces ±1, rara vez más. Una distribución así pide un modelo que reparta la
 * probabilidad en dos colas que decaen — eso es Laplace — en vez de una tabla
 * plana.
 *
 * Dos parámetros por banda, que salen de `E_PROB_MODEL`:
 *
 * - `fs`: probabilidad de que el residuo sea **exactamente cero**, o sea de que
 *   la banda suene igual que antes. Es el valor que hace baratas las tramas que
 *   predicen bien.
 * - `decay`: cómo de rápido caen las colas. Más alto, colas más largas.
 *
 * ## El detalle que no se puede aproximar
 *
 * Las colas no llegan a cero: a partir de cierto punto, todos los valores
 * comparten la misma probabilidad mínima (`LAPLACE_MINP`). Eso es lo que hace
 * que **cualquier** residuo se pueda codificar, por raro que sea, sin que el
 * modelo se quede sin sitio. Y por eso `laplaceEncode` puede **devolver un valor
 * distinto del que se le pasó**: si el residuo no cabe en lo que queda de rango,
 * lo recorta y devuelve el que realmente se escribió. Quien llame tiene que
 * quedarse con ese, no con el original — si no, encoder y decoder acaban con
 * energías distintas y a partir de ahí todo lo demás está desalineado.
 *
 * ---
 * Port de `celt/laplace.c` de la implementación de referencia de la RFC 6716.
 * Copyright 1994-2011 IETF Trust, Xiph.Org, Skype Limited, Octasic,
 * Jean-Marc Valin, Timothy B. Terriberry, CSIRO, Gregory Maxwell,
 * Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import type { RangeDecoder, RangeEncoder } from './range-coder';

/** Probabilidad mínima que se le reserva a cada valor de la cola. */
export const LAPLACE_LOG_MINP = 0;
export const LAPLACE_MINP = 1 << LAPLACE_LOG_MINP;
/** Cuántos valores tienen garantizada esa probabilidad mínima a cada lado. */
export const LAPLACE_NMIN = 16;

/** Escala del modelo: 15 bits. `encode(fl, fh, 32768)` es `ec_encode_bin(...,15)`. */
const LAPLACE_FT = 32768;

/** Probabilidad del primer valor no nulo, dada la del cero y el decaimiento. */
function freq1(fs0: number, decay: number): number {
  const ft = LAPLACE_FT - LAPLACE_MINP * (2 * LAPLACE_NMIN) - fs0;
  return (ft * (16384 - decay)) >> 15;
}

/**
 * Codifica un residuo de energía.
 *
 * **Devuelve el valor realmente codificado**, que puede no ser el de entrada
 * cuando la cola se agota. Ver la nota de arriba: usar el original en vez de
 * éste desalinea el estado de energía entre los dos lados.
 */
export function laplaceEncode(
  enc: RangeEncoder,
  value: number,
  fs0: number,
  decay: number,
): number {
  let fl = 0;
  let fs = fs0;
  // El `+ 0` normaliza el −0: no es 0 para Object.is ni para una comparación
  // estructural, y aquí viajaría hasta el estado de energía del decodificador.
  let written = value + 0;

  if (value !== 0) {
    // `s` es 0 para positivos y −1 para negativos; con él se hacen el valor
    // absoluto y la elección de mitad sin ramificar, igual que la referencia.
    const s = value < 0 ? -1 : 0;
    let val = (value + s) ^ s;
    fl = fs;
    fs = freq1(fs, decay);

    let i = 1;
    for (; fs > 0 && i < val; i++) {
      fs *= 2;
      fl += fs + 2 * LAPLACE_MINP;
      fs = (fs * decay) >> 15;
    }

    if (fs === 0) {
      // Se acabó la parte que decae: a partir de aquí todo vale lo mismo, y
      // sólo cabe lo que quepa en lo que resta de rango.
      let ndiMax = (LAPLACE_FT - fl + LAPLACE_MINP - 1) >> LAPLACE_LOG_MINP;
      ndiMax = (ndiMax - s) >> 1;
      const di = Math.min(val - i, ndiMax - 1);
      fl += (2 * di + 1 + s) * LAPLACE_MINP;
      fs = Math.min(LAPLACE_MINP, LAPLACE_FT - fl);
      written = (i + di + s) ^ s;
    } else {
      fs += LAPLACE_MINP;
      // Los positivos van en la mitad alta del intervalo y los negativos en la
      // baja: ahí está codificado el signo, sin gastar un bit aparte.
      fl += fs & ~s;
    }
    val = 0;
  }

  enc.encode(fl, fl + fs, LAPLACE_FT);
  return written;
}

/** Decodifica un residuo de energía. La inversa exacta de `laplaceEncode`. */
export function laplaceDecode(dec: RangeDecoder, fs0: number, decay: number): number {
  let value = 0;
  let fs = fs0;
  let fl = 0;
  const fm = dec.decode(LAPLACE_FT);

  if (fm >= fs) {
    value++;
    fl = fs;
    fs = freq1(fs, decay) + LAPLACE_MINP;
    while (fs > LAPLACE_MINP && fm >= fl + 2 * fs) {
      fs *= 2;
      fl += fs;
      fs = (((fs - 2 * LAPLACE_MINP) * decay) >> 15) + LAPLACE_MINP;
      value++;
    }
    if (fs <= LAPLACE_MINP) {
      const di = (fm - fl) >> (LAPLACE_LOG_MINP + 1);
      value += di;
      fl += 2 * di * LAPLACE_MINP;
    }
    if (fm < fl + fs) value = -value;
    else fl += fs;
  }

  dec.update(fl, Math.min(fl + fs, LAPLACE_FT), LAPLACE_FT);
  return value;
}
