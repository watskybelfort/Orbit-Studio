/**
 * Encoder CELT: la trama completa, de PCM a paquete.
 *
 * Aquí se junta todo lo anterior en el orden **exacto** que espera el
 * decodificador. Y ese orden es lo único que no admite creatividad: los
 * elementos van uno detrás de otro sin longitudes ni marcas, así que escribir
 * uno de más, uno de menos o uno cambiado de sitio no degrada nada — desplaza
 * todo lo que viene detrás y el archivo deja de existir.
 *
 * ```
 *   silencio → postfiltro → transitorio → energía gruesa → resolución t/f →
 *   dispersión → dynalloc → inclinación → asignación → energía fina →
 *   bandas → anti-colapso → sobras
 * ```
 *
 * ## Lo que este encoder decide y lo que no
 *
 * Hay dos clases de cosas en un códec, y conviene no confundirlas:
 *
 * - **Sintaxis**: qué elementos van y en qué orden. Eso es el formato, y está
 *   todo aquí, completo.
 * - **Decisiones**: qué valor darle a cada uno. Eso es del codificador, y aquí
 *   se toman las conservadoras — sin postfiltro, sin transitorios, dispersión
 *   normal, sin dynalloc, inclinación neutra.
 *
 * El resultado es un archivo **válido y decodificable** que suena algo peor que
 * el de libopus, no uno roto. Afinar las decisiones es trabajo posterior y no
 * toca el formato; escribirlas mal sí lo rompe.
 *
 * ---
 * Port de `celt_encode_with_ec` de `celt/celt.c` de la implementación de
 * referencia de la RFC 6716. Copyright 1994-2011 IETF Trust, Xiph.Org,
 * Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO,
 * Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { computeAllocation } from './allocation';
import { amp2Log2, computeBandEnergies, normaliseBands } from './bands';
import {
  quantCoarseEnergy,
  quantEnergyFinalise,
  quantFineEnergy,
} from './energy';
import { celtWindowFull, mdct } from './mdct';
import { quantAllBands } from './quant-bands';
import { RangeEncoder } from './range-coder';
import {
  OPUS_EBANDS,
  computeLogN,
  initCaps,
  opusPulseCache,
  type PulseCache,
} from './rate';
import { BITRES, NB_BANDS, SPREAD_ICDF, TF_SELECT_TABLE, TRIM_ICDF } from './tables';
import { SPREAD_NORMAL } from './vq';

/** Tamaño de la MDCT corta a 48 kHz: 2,5 ms. */
export const SHORT_MDCT_SIZE = 120;
/** Solape de la ventana, en muestras. */
export const OVERLAP = 120;
/** Coeficiente de pre-énfasis a 48 kHz: `A(z) = 1 − 0,85·z⁻¹`. */
export const PREEMPH = 0.85;
/**
 * Escala interna del códec.
 *
 * El PCM llega en ±1 y CELT trabaja en ±32768. No es cosmético: la energía de
 * banda se transmite en logaritmo y el decodificador aplica su propia escala al
 * salir, así que si ésta no coincide el audio sale con el volumen cambiado.
 */
export const SIG_SCALE = 32768;

export interface CeltEncoderState {
  channels: number;
  /** Energía de la trama anterior, para la predicción. Se arrastra. */
  oldBandE: Float64Array;
  /** Últimas `OVERLAP` muestras de cada canal, con la pre-énfasis ya aplicada. */
  history: Float64Array;
  /** Memoria del filtro de pre-énfasis, por canal. */
  preemphMem: Float64Array;
  /** Bandas codificadas en la trama anterior, para la histéresis del salto. */
  lastCodedBands: number;
  /** Semilla del ruido de relleno. */
  seed: number;
  cache: PulseCache;
  logN: Int32Array;
  window: Float64Array;
  /** Primera trama: no hay nada de qué predecir. */
  first: boolean;
}

export function createCeltEncoder(channels: number): CeltEncoderState {
  return {
    channels,
    oldBandE: new Float64Array(NB_BANDS * channels),
    history: new Float64Array(OVERLAP * channels),
    preemphMem: new Float64Array(channels),
    lastCodedBands: 0,
    seed: 0,
    cache: opusPulseCache(),
    logN: computeLogN(OPUS_EBANDS),
    window: celtWindowFull(960, OVERLAP),
    first: true,
  };
}

/**
 * Ventana completa para el tamaño de trama pedido.
 *
 * Se cachea la de 960 en el estado porque es la normal; las demás se calculan
 * al vuelo, que es barato comparado con codificar la trama.
 */
function windowFor(state: CeltEncoderState, frameSize: number): Float64Array {
  return frameSize === 960 ? state.window : celtWindowFull(frameSize, OVERLAP);
}

/**
 * Pre-énfasis: realza los agudos antes de codificar.
 *
 * El ruido de cuantización sale plano en frecuencia, pero la música tiene mucha
 * menos energía arriba que abajo — así que arriba el ruido se oiría. Realzando
 * antes y atenuando después (lo hace el decodificador), el ruido se atenúa con
 * la señal y queda enterrado donde importa.
 */
function preemphasis(
  pcm: Float64Array | Float32Array,
  channel: number,
  channels: number,
  frameSize: number,
  mem: Float64Array,
): Float64Array {
  const out = new Float64Array(frameSize);
  let m = mem[channel]!;
  for (let i = 0; i < frameSize; i++) {
    const x = pcm[i * channels + channel]! * SIG_SCALE;
    out[i] = x + m;
    m = -PREEMPH * x;
  }
  mem[channel] = m;
  return out;
}

/**
 * MDCT de una trama con la ventana de solape corto.
 *
 * El bloque de la MDCT mide `2N`, pero la ventana sólo es distinta de cero en
 * `N + solape` muestras — justo las que hay: el historial de la trama anterior
 * más las nuevas. El resto del bloque es relleno a cero, y ahí está lo que hace
 * que la latencia sea de `solape` y no de media trama.
 */
function frameMdct(
  history: Float64Array,
  fresh: Float64Array,
  frameSize: number,
  window: Float64Array,
): Float64Array {
  const block = new Float64Array(2 * frameSize);
  const pad = (frameSize - OVERLAP) / 2;
  for (let i = 0; i < OVERLAP; i++) block[pad + i] = history[i]! * window[pad + i]!;
  for (let i = 0; i < frameSize; i++) {
    block[pad + OVERLAP + i] = fresh[i]! * window[pad + OVERLAP + i]!;
  }
  // La MDCT de aquí es la definición sin normalizar; la de CELT lleva su propio
  // factor. La diferencia es exactamente `N/2`, y no es opcional: la energía de
  // banda se transmite en logaritmo, así que un factor de escala en los
  // coeficientes sale por el altavoz como un cambio de volumen. Medido contra
  // ffmpeg, que es quien tiene la última palabra sobre esto.
  const spectrum = mdct(block, frameSize);
  const scale = 2 / frameSize;
  for (let i = 0; i < spectrum.length; i++) spectrum[i] = spectrum[i]! * scale;
  return spectrum;
}

export interface CeltFrameOptions {
  /** Muestras por canal: 120, 240, 480 o 960. */
  frameSize: number;
  /** Bytes que puede ocupar la trama CELT (sin contar el byte TOC de Opus). */
  bytes: number;
}

/**
 * Codifica una trama. Devuelve los bytes de la trama CELT.
 *
 * `pcm` viene entrelazado por canales, en ±1.
 */
export function celtEncodeFrame(
  state: CeltEncoderState,
  pcm: Float64Array | Float32Array,
  options: CeltFrameOptions,
): Uint8Array {
  const { frameSize, bytes } = options;
  const channels = state.channels;
  const lm = Math.log2(frameSize / SHORT_MDCT_SIZE);
  if (!Number.isInteger(lm) || lm < 0 || lm > 3) {
    throw new Error(`tamaño de trama no válido: ${frameSize}`);
  }
  const m = 1 << lm;
  const totalBits = bytes * 8;
  const enc = new RangeEncoder(bytes);
  const window = windowFor(state, frameSize);

  // ── Pre-énfasis y MDCT ─────────────────────────────────────────────────────
  const coeffs = new Float64Array(frameSize * channels);
  let silence = true;
  for (let c = 0; c < channels; c++) {
    const fresh = preemphasis(pcm, c, channels, frameSize, state.preemphMem);
    for (let i = 0; i < frameSize; i++) if (pcm[i * channels + c] !== 0) silence = false;
    const spectrum = frameMdct(
      state.history.subarray(c * OVERLAP, (c + 1) * OVERLAP),
      fresh,
      frameSize,
      window,
    );
    coeffs.set(spectrum, c * frameSize);
    // El historial de la siguiente trama son las últimas `OVERLAP` muestras.
    state.history.set(fresh.subarray(frameSize - OVERLAP), c * OVERLAP);
  }

  // ── Bandera de silencio ────────────────────────────────────────────────────
  // Va la primera y sólo si el coder está recién empezado (tell()==1).
  if (enc.tell() === 1) enc.bitLogp(silence ? 1 : 0, 15);
  else silence = false;

  // ── Postfiltro: no se usa, pero la bandera va igual ───────────────────────
  if (enc.tell() + 16 <= totalBits) enc.bitLogp(0, 1);

  // ── Transitorio: siempre bloques largos ───────────────────────────────────
  const isTransient = 0;
  const shortBlocks = false;
  if (lm > 0 && enc.tell() + 3 <= totalBits) enc.bitLogp(isTransient, 3);

  // ── Energía de banda ──────────────────────────────────────────────────────
  const bandE = computeBandEnergies(
    coeffs,
    OPUS_EBANDS,
    NB_BANDS,
    NB_BANDS,
    channels,
    frameSize,
    m,
  );
  const bandLogE = amp2Log2(bandE, NB_BANDS, NB_BANDS, NB_BANDS, channels);
  const shape = normaliseBands(
    coeffs,
    bandE,
    OPUS_EBANDS,
    NB_BANDS,
    NB_BANDS,
    channels,
    frameSize,
    m,
  );

  // ── Intra o inter: se prueban las dos y gana la que salga mejor ───────────
  //
  // Ésta no es una optimización opcional. Predecir la energía de la trama
  // anterior sale muy barato cuando acierta, pero cuando falla el residuo no
  // cabe en el presupuesto y hay que RECORTARLO — y un recorte deja la banda en
  // un nivel que no es el suyo, que es de las cosas que peor se oyen.
  //
  // Se mide con `badness`: cuánto hubo que recortar. Se codifican las dos
  // versiones sobre copias del codificador, gana la de menos recorte (y a igual
  // recorte, la que ocupe menos), y sólo entonces se escribe de verdad.
  const maxDecay = Math.min(16, 0.125 * bytes);
  const error = new Float64Array(NB_BANDS * channels);
  const coarseArgs = {
    bandLogE,
    bands: NB_BANDS,
    start: 0,
    end: NB_BANDS,
    channels,
    lm,
    budget: totalBits,
    maxDecay,
  };

  let intra = state.first;
  if (!intra) {
    const tryIt = (useIntra: boolean): { badness: number; bits: number } => {
      const probe = enc.clone();
      const badness = quantCoarseEnergy(probe, {
        ...coarseArgs,
        oldEBands: Float64Array.from(state.oldBandE),
        error: new Float64Array(NB_BANDS * channels),
        intra: useIntra,
      });
      return { badness, bits: probe.tellFrac() };
    };
    const asIntra = tryIt(true);
    const asInter = tryIt(false);
    intra =
      asIntra.badness < asInter.badness ||
      (asIntra.badness === asInter.badness && asIntra.bits < asInter.bits);
  }

  quantCoarseEnergy(enc, {
    ...coarseArgs,
    oldEBands: state.oldBandE,
    error,
    intra,
  });
  state.first = false;

  // ── Resolución tiempo/frecuencia: sin cambios ─────────────────────────────
  const tfRes = new Int32Array(NB_BANDS);
  encodeTf(enc, tfRes, lm, isTransient, totalBits);

  // ── Dispersión ────────────────────────────────────────────────────────────
  const spread = SPREAD_NORMAL;
  if (enc.tell() + 4 <= totalBits) enc.icdf(spread, SPREAD_ICDF, 5);

  // ── Dynalloc: refuerzo a las bandas que destacan sobre sus vecinas ────────
  const caps = initCaps(state.cache, OPUS_EBANDS, lm, channels);
  const wanted = dynallocAnalysis(bandLogE, bytes, lm, channels);
  const { offsets, totalBoost } = encodeDynalloc(enc, wanted, caps, lm, channels, totalBits);

  // ── Inclinación del reparto ───────────────────────────────────────────────
  const allocTrim = 5;
  // El `− totalBoost` NO es un detalle: el decodificador calcula el mismo
  // refuerzo total y aplica esta misma condición para saber si tiene que leer la
  // inclinación. Si aquí sobra o falta, uno escribe un símbolo que el otro no
  // espera y todo lo que viene detrás se lee corrido.
  if (enc.tellFrac() + (6 << BITRES) <= (totalBits << BITRES) - totalBoost) {
    enc.icdf(allocTrim, TRIM_ICDF, 7);
  }

  // ── Asignación de bits ────────────────────────────────────────────────────
  let bits = ((bytes * 8) << BITRES) - enc.tellFrac() - 1;
  // Sin transitorios no hay anti-colapso que reservar.
  const antiCollapseRsv = 0;
  bits -= antiCollapseRsv;
  const alloc = computeAllocation(
    {
      ebands: OPUS_EBANDS,
      start: 0,
      end: NB_BANDS,
      offsets,
      cap: caps,
      allocTrim,
      total: bits,
      channels,
      lm,
      intensity: NB_BANDS,
      dualStereo: 0,
      prev: state.lastCodedBands,
    },
    { encode: true, enc },
  );
  state.lastCodedBands = alloc.codedBands;

  // ── Energía fina ──────────────────────────────────────────────────────────
  quantFineEnergy(enc, state.oldBandE, error, alloc.ebits, NB_BANDS, 0, NB_BANDS, channels);

  // ── Las bandas ────────────────────────────────────────────────────────────
  const collapseMasks = new Uint8Array(NB_BANDS * channels);
  state.seed = quantAllBands(
    {
      encode: true,
      enc,
      dec: null,
      ebands: OPUS_EBANDS,
      bands: NB_BANDS,
      cache: state.cache,
      logN: state.logN,
    },
    {
      x: shape,
      y: channels === 2 ? shape.subarray(frameSize) : null,
      collapseMasks,
      bandE,
      pulses: alloc.pulses,
      shortBlocks,
      spread,
      dualStereo: alloc.dualStereo,
      intensity: alloc.intensity,
      tfRes,
      // OJO: aquí va el presupuesto del PAQUETE ENTERO, no lo que quedaba
      // después de la asignación. Son cosas distintas y confundirlas cuesta
      // caro: `quantAllBands` calcula `remaining_bits` restando lo ya gastado,
      // así que si se le da un total más pequeño cree que le queda menos de lo
      // que hay y recorta pulsos en algunas bandas. El decodificador usa el
      // total de verdad, así que a partir de ese punto leen cosas distintas.
      totalBits: bytes * 8 * (1 << BITRES) - antiCollapseRsv,
      balance: alloc.balance,
      lm,
      codedBands: alloc.codedBands,
      start: 0,
      end: NB_BANDS,
      seed: state.seed,
    },
  );

  // ── Sobras ────────────────────────────────────────────────────────────────
  quantEnergyFinalise(
    enc,
    state.oldBandE,
    error,
    alloc.ebits,
    alloc.finePriority,
    NB_BANDS,
    0,
    NB_BANDS,
    channels,
    totalBits - enc.tell(),
  );

  if (enc.busted) throw new Error(`la trama no cabe en ${bytes} bytes`);
  return enc.done();
}

/**
 * Escribe la resolución tiempo/frecuencia de cada banda.
 *
 * Va como una cadena de bits diferenciales —cada banda dice si cambia respecto a
 * la anterior— porque lo normal es que no cambie, y así una trama sin cambios
 * cuesta casi nada.
 */
function encodeTf(
  enc: RangeEncoder,
  tfRes: Int32Array,
  lm: number,
  isTransient: number,
  totalBits: number,
): void {
  let budget = totalBits;
  let tell = enc.tell();
  let logp = isTransient ? 2 : 4;
  const tfSelectRsv = lm > 0 && tell + logp + 1 <= budget ? 1 : 0;
  budget -= tfSelectRsv;
  let curr = 0;
  let tfChanged = 0;

  for (let i = 0; i < NB_BANDS; i++) {
    if (tell + logp <= budget) {
      enc.bitLogp(tfRes[i]! ^ curr, logp);
      tell = enc.tell();
      curr = tfRes[i]!;
      tfChanged |= curr;
    } else {
      tfRes[i] = curr;
    }
    logp = isTransient ? 4 : 5;
  }

  // El `tf_select` sólo se manda si de verdad cambiaría algo.
  let tfSelect = 0;
  const row = TF_SELECT_TABLE[lm]!;
  if (tfSelectRsv && row[4 * isTransient + tfChanged] !== row[4 * isTransient + 2 + tfChanged]) {
    enc.bitLogp(tfSelect, 1);
  } else {
    tfSelect = 0;
  }
  for (let i = 0; i < NB_BANDS; i++) {
    tfRes[i] = row[4 * isTransient + 2 * tfSelect + tfRes[i]!]!;
  }
}

/**
 * Escribe la asignación dinámica: por cada banda, tantas banderas a 1 como
 * refuerzos se piden, y una a 0 para cerrar.
 *
 * **Los bits van aunque no se pida nada**: el decodificador los lee siempre, así
 * que la bandera de cierre no es opcional. Y el coste de pedir baja a un bit a
 * partir del segundo refuerzo, porque quien pide uno suele querer dos.
 */
/**
 * Qué bandas piden bits de más.
 *
 * Se busca **contraste espectral**: una banda que sobresale mucho por encima de
 * sus dos vecinas. La medida es una segunda derivada,
 * `2·E[i] − E[i−1] − E[i+1]`, que es grande justo donde hay un tono aislado.
 *
 * Y ahí está por qué esto importa tanto: un tono puro concentra toda su energía
 * en dos coeficientes, y con el reparto normal la banda no recibe pulsos para
 * colocarlos bien. El resultado es un tono que suena sucio a bitrates medios —
 * exactamente el caso que peor tolera el oído, porque no hay nada más que lo
 * enmascare.
 */
function dynallocAnalysis(
  bandLogE: Float64Array,
  bytes: number,
  lm: number,
  channels: number,
): Int32Array {
  const wanted = new Int32Array(NB_BANDS);
  // Con muy pocos bytes, reforzar una banda sería quitárselos a todas las demás.
  if (bytes <= 50 || lm < 1) return wanted;
  const t1 = lm <= 1 ? 3 : 2;
  const t2 = lm <= 1 ? 5 : 4;
  for (let i = 1; i < NB_BANDS - 1; i++) {
    let d2 = 2 * bandLogE[i]! - bandLogE[i - 1]! - bandLogE[i + 1]!;
    if (channels === 2) {
      const r =
        2 * bandLogE[i + NB_BANDS]! - bandLogE[i - 1 + NB_BANDS]! - bandLogE[i + 1 + NB_BANDS]!;
      d2 = 0.5 * (d2 + r);
    }
    if (d2 > t1) wanted[i] = wanted[i]! + 1;
    if (d2 > t2) wanted[i] = wanted[i]! + 1;
  }
  return wanted;
}

function encodeDynalloc(
  enc: RangeEncoder,
  wanted: Int32Array,
  caps: Int32Array,
  lm: number,
  channels: number,
  totalBits: number,
): { offsets: Int32Array; totalBoost: number } {
  const offsets = new Int32Array(NB_BANDS);
  let dynallocLogp = 6;
  const total = totalBits << BITRES;
  let totalBoost = 0;
  let tell = enc.tellFrac();

  for (let i = 0; i < NB_BANDS; i++) {
    const width = channels * (OPUS_EBANDS[i + 1]! - OPUS_EBANDS[i]!) * (1 << lm);
    const quanta = Math.min(width << BITRES, Math.max(6 << BITRES, width));
    let loopLogp = dynallocLogp;
    let boost = 0;
    let j = 0;
    for (; tell + (loopLogp << BITRES) < total - totalBoost && boost < caps[i]!; j++) {
      const flag = j < wanted[i]! ? 1 : 0;
      enc.bitLogp(flag, loopLogp);
      tell = enc.tellFrac();
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
