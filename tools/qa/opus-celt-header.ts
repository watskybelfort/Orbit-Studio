/**
 * La cabecera de una trama CELT, leída como la lee un decodificador.
 *
 * Este encoder no lleva decodificador dentro y no debe llevarlo: su trabajo es
 * escribir un paquete que abra cualquiera. Pero hay una clase de fallo que sólo
 * se ve desde el otro lado — **el símbolo que el codificador decide fuera de la
 * rama que lo escribe** —, y ésa no da error: descoloca el paquete o, peor, deja
 * a los dos lados repartiendo bits de forma distinta sin que salte nada.
 *
 * Por eso vive aquí, en las herramientas, y no en `packages/engine`: es una
 * copia del arranque de `celt_decode_with_ec` con el ÚNICO fin de comprobar que
 * lo que se lee del paquete es lo que el codificador usó. Recorre la cabecera en
 * el orden del formato hasta pasar por el asignador de bits, que es donde viajan
 * los dos parámetros de estéreo:
 *
 * ```
 *   silencio → postfiltro → transitorio → energía gruesa → resolución t/f →
 *   dispersión → dynalloc → inclinación → asignación
 * ```
 *
 * Se lee con el estado arrastrado entre tramas (`oldBandE`, `lastCodedBands`)
 * porque el decodificador también lo arrastra: la energía gruesa se predice de
 * la trama anterior y la histéresis del salto de bandas mira cuántas se
 * codificaron la vez pasada. Leer una trama suelta del medio da otra cosa.
 */

import { computeAllocation } from '../../packages/engine/src/render/opus/allocation';
import { SILENT_ENERGY } from '../../packages/engine/src/render/opus/celt-encoder';
import { unquantCoarseEnergy } from '../../packages/engine/src/render/opus/energy';
import { POSTFILTER_GAIN_STEP } from '../../packages/engine/src/render/opus/postfilter';
import { RangeDecoder } from '../../packages/engine/src/render/opus/range-coder';
import {
  OPUS_EBANDS,
  initCaps,
  opusPulseCache,
} from '../../packages/engine/src/render/opus/rate';
import {
  BITRES,
  NB_BANDS,
  SPREAD_ICDF,
  TAPSET_ICDF,
  TF_SELECT_TABLE,
  TRIM_ICDF,
} from '../../packages/engine/src/render/opus/tables';
import { SPREAD_NORMAL } from '../../packages/engine/src/render/opus/vq';

export interface CabeceraCelt {
  /** La trama iba marcada como silencio: detrás no hay nada más. */
  silencio: boolean;
  postfiltro: { on: number; period: number; gain: number; tapset: number };
  transitorio: number;
  intra: number;
  tfSelect: number;
  dispersion: number;
  inclinacion: number;
  refuerzoTotal: number;
  /** Banda a partir de la cual el estéreo va por intensidad. */
  intensity: number;
  /** Estéreo dual: cada canal por su cuenta. */
  dualStereo: number;
  codedBands: number;
}

/** Estado que el decodificador arrastra de una trama a la siguiente. */
export interface EstadoLector {
  oldBandE: Float64Array;
  lastCodedBands: number;
}

export function crearEstadoLector(channels: number): EstadoLector {
  return { oldBandE: new Float64Array(NB_BANDS * channels), lastCodedBands: 0 };
}

const CACHE = opusPulseCache();

/**
 * Resolución tiempo/frecuencia: la vuelta de `encodeTf`.
 *
 * Es una cadena diferencial y hay que recorrerla entera aunque no interese, por
 * la razón de siempre: sin ella, todo lo que viene detrás se lee corrido.
 */
function leerTf(
  dec: RangeDecoder,
  totalBits: number,
  lm: number,
  isTransient: number,
): number {
  let budget = totalBits;
  let tell = dec.tell();
  let logp = isTransient ? 2 : 4;
  const tfSelectRsv = lm > 0 && tell + logp + 1 <= budget ? 1 : 0;
  budget -= tfSelectRsv;
  let curr = 0;
  let tfChanged = 0;

  for (let i = 0; i < NB_BANDS; i++) {
    if (tell + logp <= budget) {
      curr ^= dec.bitLogp(logp);
      tell = dec.tell();
      tfChanged |= curr;
    }
    logp = isTransient ? 4 : 5;
  }

  const row = TF_SELECT_TABLE[lm]!;
  if (tfSelectRsv && row[4 * isTransient + tfChanged] !== row[4 * isTransient + 2 + tfChanged]) {
    return dec.bitLogp(1);
  }
  return 0;
}

/** Dynalloc: la vuelta de `encodeDynalloc`. */
function leerDynalloc(
  dec: RangeDecoder,
  caps: Int32Array,
  lm: number,
  channels: number,
  totalBits: number,
): { offsets: Int32Array; totalBoost: number } {
  const offsets = new Int32Array(NB_BANDS);
  let dynallocLogp = 6;
  const total = totalBits << BITRES;
  let totalBoost = 0;
  let tell = dec.tellFrac();

  for (let i = 0; i < NB_BANDS; i++) {
    const width = channels * (OPUS_EBANDS[i + 1]! - OPUS_EBANDS[i]!) * (1 << lm);
    const quanta = Math.min(width << BITRES, Math.max(6 << BITRES, width));
    let loopLogp = dynallocLogp;
    let boost = 0;
    let j = 0;
    for (; tell + (loopLogp << BITRES) < total - totalBoost && boost < caps[i]!; j++) {
      const flag = dec.bitLogp(loopLogp);
      tell = dec.tellFrac();
      if (!flag) break;
      boost += quanta;
      totalBoost += quanta;
      loopLogp = 1;
    }
    if (j) dynallocLogp = Math.max(2, dynallocLogp - 1);
    offsets[i] = boost;
  }
  return { offsets, totalBoost };
}

/**
 * Lee la cabecera de una trama CELT (sin el byte TOC de Opus).
 *
 * `estado` se modifica in situ: es el que hay que ir pasando trama a trama.
 */
export function leerCabeceraCelt(
  trama: Uint8Array,
  estado: EstadoLector,
  lm: number,
  channels: number,
): CabeceraCelt {
  const dec = new RangeDecoder(trama);
  const totalBits = trama.length * 8;
  const salida: CabeceraCelt = {
    silencio: false,
    postfiltro: { on: 0, period: 0, gain: 0, tapset: 0 },
    transitorio: 0,
    intra: 0,
    tfSelect: 0,
    dispersion: SPREAD_NORMAL,
    inclinacion: 5,
    refuerzoTotal: 0,
    intensity: 0,
    dualStereo: 0,
    codedBands: NB_BANDS,
  };

  // ── Silencio ──────────────────────────────────────────────────────────────
  const tell0 = dec.tell();
  if (tell0 === 1 && dec.bitLogp(15)) {
    salida.silencio = true;
    estado.oldBandE.fill(SILENT_ENERGY);
    return salida;
  }

  // ── Postfiltro ────────────────────────────────────────────────────────────
  if (tell0 + 16 <= totalBits && dec.bitLogp(1)) {
    const octave = dec.uint(6);
    salida.postfiltro.period = (16 << octave) + dec.bits(4 + octave) - 1;
    const qg = dec.bits(3);
    if (dec.tell() + 2 <= totalBits) salida.postfiltro.tapset = dec.icdf(TAPSET_ICDF, 2);
    salida.postfiltro.gain = POSTFILTER_GAIN_STEP * (qg + 1);
    salida.postfiltro.on = 1;
  }

  // ── Transitorio ───────────────────────────────────────────────────────────
  if (lm > 0 && dec.tell() + 3 <= totalBits) salida.transitorio = dec.bitLogp(3);

  // ── Energía gruesa ────────────────────────────────────────────────────────
  if (dec.tell() + 3 <= totalBits) salida.intra = dec.bitLogp(3);
  unquantCoarseEnergy(dec, {
    oldEBands: estado.oldBandE,
    bands: NB_BANDS,
    start: 0,
    end: NB_BANDS,
    channels,
    lm,
    intra: salida.intra === 1,
    budget: totalBits,
  });

  // ── Resolución tiempo/frecuencia ──────────────────────────────────────────
  salida.tfSelect = leerTf(dec, totalBits, lm, salida.transitorio);

  // ── Dispersión ────────────────────────────────────────────────────────────
  if (dec.tell() + 4 <= totalBits) salida.dispersion = dec.icdf(SPREAD_ICDF, 5);

  // ── Dynalloc ──────────────────────────────────────────────────────────────
  const caps = initCaps(CACHE, OPUS_EBANDS, lm, channels);
  const { offsets, totalBoost } = leerDynalloc(dec, caps, lm, channels, totalBits);
  salida.refuerzoTotal = totalBoost;

  // ── Inclinación ───────────────────────────────────────────────────────────
  if (dec.tellFrac() + (6 << BITRES) <= (totalBits << BITRES) - totalBoost) {
    salida.inclinacion = dec.icdf(TRIM_ICDF, 7);
  }

  // ── Asignación: aquí viajan los dos parámetros de estéreo ─────────────────
  let bits = (totalBits << BITRES) - dec.tellFrac() - 1;
  const antiCollapseRsv =
    salida.transitorio && lm >= 2 && bits >= (lm + 2) << BITRES ? 1 << BITRES : 0;
  bits -= antiCollapseRsv;
  const alloc = computeAllocation(
    {
      ebands: OPUS_EBANDS,
      start: 0,
      end: NB_BANDS,
      offsets,
      cap: caps,
      allocTrim: salida.inclinacion,
      total: bits,
      channels,
      lm,
      // El decodificador no elige: los lee. Lo que entra aquí da igual.
      intensity: 0,
      dualStereo: 0,
      prev: estado.lastCodedBands,
    },
    { encode: false, dec },
  );
  estado.lastCodedBands = alloc.codedBands;
  salida.intensity = alloc.intensity;
  salida.dualStereo = alloc.dualStereo;
  salida.codedBands = alloc.codedBands;
  return salida;
}
