/**
 * La decisión de dispersión: cuánto hay que revolver cada banda antes del PVQ.
 *
 * La rotación de dispersión (`expRotation`, en `vq.ts`) es ortogonal: no cambia
 * la norma de la banda ni, por tanto, cuánta energía de error hay. Lo que hace
 * es **repartir** ese error por toda la banda en vez de dejarlo concentrado
 * donde el PVQ puso —o dejó de poner— sus pulsos.
 *
 * Y eso importa según lo que haya dentro:
 *
 * - Una banda de **ruido** (energía repartida por igual entre sus bins) que se
 *   codifica con cuatro pulsos sueltos se reconstruye como cuatro silbidos con
 *   silencio alrededor. Suena a pájaros metálicos, no a ruido. Ahí la
 *   dispersión hace falta, y agresiva.
 * - Una banda **tonal** (casi toda la energía en un bin) ya se describe bien con
 *   pocos pulsos, y revolverla sólo esparce el error alrededor del tono, donde
 *   se oye. Ahí la dispersión estorba.
 *
 * Por eso el codificador mide la «planitud» de cada banda y decide. Antes esto
 * era una constante (`SPREAD_NORMAL` siempre), que es la respuesta correcta en
 * promedio y la equivocada en los dos extremos.
 *
 * ## Lo que mide
 *
 * Para cada banda, con la forma ya normalizada a norma 1, se cuenta cuántos
 * bins caen por debajo de tres fracciones de lo que valdrían si la banda fuera
 * plana (−6, −12 y −18 dB). Una banda plana no tiene ninguno por debajo; una
 * banda tonal los tiene casi todos. De ahí sale un número de 0 a 3 por banda,
 * se promedia entre bandas y canales, se suaviza con la trama anterior y se le
 * mete histéresis con la decisión anterior — las dos cosas para que el
 * parámetro no salte de trama en trama, que se oiría como un temblor.
 *
 * ---
 * Port de `spreading_decision` de `celt/bands.c` de la implementación de
 * referencia de la RFC 6716. Copyright 1994-2011 IETF Trust, Xiph.Org,
 * Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO,
 * Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { NB_BANDS } from './tables';
import { SPREAD_AGGRESSIVE, SPREAD_LIGHT, SPREAD_NONE, SPREAD_NORMAL } from './vq';

/**
 * Por encima de esta banda está lo que mira el `tapset`: las tres últimas, de
 * 9,6 kHz para arriba. (La referencia lo llama «las cuatro últimas, de 8 kHz
 * para arriba», pero su condición es `i > nbEBands - 4`, que deja fuera la de
 * 8-9,6 kHz. Se porta la condición, no el comentario.)
 */
const NB_BANDS_HF = NB_BANDS - 4;

/** Estado que la decisión arrastra de una trama a la siguiente. */
export interface SpreadState {
  /** Media recursiva de la planitud. Arranca en 256, como la referencia. */
  tonalAverage: number;
  /** La decisión anterior, para la histéresis. */
  last: number;
  /** Media recursiva de la planitud de las bandas de 9,6 kHz para arriba. */
  hfAverage: number;
  /**
   * Qué juego de taps pide el postfiltro (0, 1 o 2).
   *
   * Sale de aquí y no de otro sitio porque la pregunta es la misma que ya se
   * está contestando: cuánto ruido hay arriba. Con agudos ruidosos conviene un
   * peine repartido (tapset 2, que aquí es el de más ancho de banda) y con
   * agudos limpios uno afilado. Lo usa `celtEncodeFrame` en la trama SIGUIENTE,
   * porque el postfiltro se escribe antes que la dispersión.
   */
  tapset: number;
}

export function createSpreadState(): SpreadState {
  return { tonalAverage: 256, last: SPREAD_NORMAL, hfAverage: 0, tapset: 0 };
}

/**
 * Decide el modo de dispersión de la trama y actualiza el estado.
 *
 * `x` son las bandas ya normalizadas, con los canales concatenados: el canal
 * `c` empieza en `c * n0`, y la banda `i` en `m * ebands[i]`.
 */
export function spreadingDecision(
  x: Float64Array,
  ebands: readonly number[],
  end: number,
  channels: number,
  m: number,
  n0: number,
  state: SpreadState,
  /**
   * Si además hay que actualizar el `tapset` del postfiltro.
   *
   * Es lo que hace la referencia: sólo cuando la trama lleva postfiltro Y no es
   * de bloques cortos. Fuera de ahí la medida de agudos no vale para decidirlo
   * —o no hay postfiltro que ajustar— y arrastrar el valor anterior es mejor
   * que moverlo con un número que no significa lo que dice.
   */
  updateHf = false,
): number {
  // Si la última banda es minúscula no hay nada que repartir.
  if (m * (ebands[end]! - ebands[end - 1]!) <= 8) return SPREAD_NONE;

  let sum = 0;
  let nbBands = 0;
  let hfSum = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < end; i++) {
      const n = m * (ebands[i + 1]! - ebands[i]!);
      // Bandas de ocho bins o menos: el PVQ ni siquiera rota ahí.
      if (n <= 8) continue;
      const at = m * ebands[i]! + c * n0;
      let t0 = 0;
      let t1 = 0;
      let t2 = 0;
      for (let j = 0; j < n; j++) {
        const v = x[at + j]!;
        // `v²·n` vale 1 si la banda es plana: es la energía del bin en
        // unidades de «lo que le tocaría». Los tres cortes son −6, −12 y −18 dB.
        const x2n = v * v * n;
        if (x2n < 0.25) t0++;
        if (x2n < 0.0625) t1++;
        if (x2n < 0.015625) t2++;
      }
      // Sólo las bandas de arriba: el `tapset` del postfiltro se decide por
      // cuánto ruido hay ahí, que es lo que el peine puede ensuciar.
      if (i > NB_BANDS_HF) hfSum += Math.trunc((32 * (t1 + t0)) / n);
      const tmp =
        (2 * t2 >= n ? 1 : 0) + (2 * t1 >= n ? 1 : 0) + (2 * t0 >= n ? 1 : 0);
      sum += tmp * 256;
      nbBands++;
    }
  }

  if (updateHf) {
    if (hfSum) hfSum = Math.trunc(hfSum / (channels * (4 - NB_BANDS + end)));
    state.hfAverage = (state.hfAverage + hfSum) >> 1;
    hfSum = state.hfAverage;
    // Histéresis, igual que la de la dispersión y por lo mismo: que el peine no
    // cambie de forma cada trama.
    if (state.tapset === 2) hfSum += 4;
    else if (state.tapset === 0) hfSum -= 4;
    if (hfSum > 22) state.tapset = 2;
    else if (hfSum > 18) state.tapset = 1;
    else state.tapset = 0;
  }

  if (nbBands === 0) return SPREAD_NORMAL;

  // Media entre bandas, y media recursiva con la trama anterior.
  sum = Math.floor(sum / nbBands);
  sum = (sum + state.tonalAverage) >> 1;
  state.tonalAverage = sum;

  // Histéresis: la decisión anterior tira del resultado hacia sí misma, para
  // que el parámetro no oscile entre dos valores en tramas consecutivas.
  const conHisteresis = (3 * sum + (((3 - state.last) << 7) + 64) + 2) >> 2;
  let decision: number;
  if (conHisteresis < 80) decision = SPREAD_AGGRESSIVE;
  else if (conHisteresis < 256) decision = SPREAD_NORMAL;
  else if (conHisteresis < 384) decision = SPREAD_LIGHT;
  else decision = SPREAD_NONE;

  state.last = decision;
  return decision;
}

/**
 * Qué hace el codificador con la dispersión.
 *
 * - `'normal'`: la constante de siempre (`SPREAD_NORMAL`) en todas las tramas.
 * - `'adaptive'`: se decide por trama, con el análisis de arriba.
 * - `'none'`: sin rotación. **Sólo para el banco de calidad**, que necesita
 *   poder medir la dispersión apagada contra la encendida; no es una opción
 *   sensata para exportar.
 */
export type SpreadMode = 'normal' | 'adaptive' | 'none';
