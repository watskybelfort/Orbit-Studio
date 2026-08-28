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
 * Con una excepción que también es del formato: si la trama se marca como
 * SILENCIO, ahí se acaba y no va nada más. El decodificador se comporta como si
 * hubiera consumido el paquete entero, así que cualquier cosa que se escribiera
 * detrás no la leería nadie —y, peor, dejaría al codificador con una energía de
 * referencia que el decodificador no tiene.
 *
 * ## Lo que este encoder decide y lo que no
 *
 * Hay dos clases de cosas en un códec, y conviene no confundirlas:
 *
 * - **Sintaxis**: qué elementos van y en qué orden. Eso es el formato, y está
 *   todo aquí, completo.
 * - **Decisiones**: qué valor darle a cada uno. Eso es del codificador. Están
 *   tomadas el dynalloc, la elección intra/inter de la energía, la inclinación
 *   del reparto (que sale de la pendiente del espectro), la dispersión (que
 *   sale de la planitud de cada banda) y el transitorio —con su reparto de
 *   resolución tiempo/frecuencia por banda, en `transient.ts`—; sigue
 *   conservador el postfiltro.
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
import {
  createSpreadState,
  spreadingDecision,
  type SpreadMode,
  type SpreadState,
} from './spread';
import { tfAnalysis, transientAnalysis, type TransientMode } from './transient';
import { BITRES, NB_BANDS, SPREAD_ICDF, TF_SELECT_TABLE, TRIM_ICDF } from './tables';
import { SPREAD_NONE, SPREAD_NORMAL } from './vq';

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
/**
 * Energía a la que quedan TODAS las bandas cuando la trama se marca como
 * silencio, en la escala logarítmica del códec.
 *
 * No es un valor decorativo: es el punto de encuentro. El decodificador
 * —libopus y ffmpeg, los dos— pone exactamente esto al leer la bandera, así que
 * el codificador tiene que poner lo mismo o los dos lados dejan de predecir
 * desde el mismo sitio.
 */
export const SILENT_ENERGY = -28;

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
  /** Ventana de la MDCT corta (2,5 ms), para las tramas con transitorio. */
  shortWindow: Float64Array;
  /** Primera trama: no hay nada de qué predecir. */
  first: boolean;
  /** Media de planitud e histéresis de la decisión de dispersión. */
  spreadState: SpreadState;
  /**
   * Tramas transitorias seguidas.
   *
   * Sólo sirve para el anti-colapso: con dos o más seguidas la señal ya no es
   * «un golpe en un silencio» sino textura densa, y rellenar de ruido las
   * bandas que se quedaron a cero deja de ayudar y empieza a ensuciar.
   */
  consecTransient: number;
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
    shortWindow: celtWindowFull(SHORT_MDCT_SIZE, OVERLAP),
    first: true,
    spreadState: createSpreadState(),
    consecTransient: 0,
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

/**
 * La trama en `m` MDCT cortas de 2,5 ms, intercaladas.
 *
 * Es lo que hace que un transitorio no emborrone: cada sub-bloque cubre 2,5 ms,
 * así que el error de cuantización del golpe se queda dentro del sub-bloque del
 * golpe y no se derrama sobre los 20 ms enteros.
 *
 * **El intercalado no es una preferencia**: el coeficiente `k` del sub-bloque
 * `b` va a la posición `k·m + b`, y así los `m` sub-bloques de una misma banda
 * caen todos dentro del rango de esa banda. Gracias a eso la energía de banda,
 * la normalización y el reparto de bits siguen siendo exactamente los mismos
 * que en bloque largo, y sólo `quantAllBands` tiene que enterarse de que hay
 * `m` sub-bloques. El decodificador des-intercala con la misma fórmula: si aquí
 * se pusieran seguidos, leería las frecuencias cambiadas de sitio.
 *
 * Cada sub-bloque solapa con el anterior, y el primero con la cola de la trama
 * anterior — que es el mismo historial de `OVERLAP` muestras que usa el bloque
 * largo, porque el solape de CELT mide justo un sub-bloque.
 */
function frameMdctShort(
  history: Float64Array,
  fresh: Float64Array,
  frameSize: number,
  m: number,
  window: Float64Array,
): Float64Array {
  const out = new Float64Array(frameSize);
  const previo = new Float64Array(SHORT_MDCT_SIZE);
  for (let b = 0; b < m; b++) {
    if (b === 0) previo.set(history.subarray(0, SHORT_MDCT_SIZE));
    else previo.set(fresh.subarray((b - 1) * SHORT_MDCT_SIZE, b * SHORT_MDCT_SIZE));
    const espectro = frameMdct(
      previo,
      fresh.subarray(b * SHORT_MDCT_SIZE, (b + 1) * SHORT_MDCT_SIZE),
      SHORT_MDCT_SIZE,
      window,
    );
    for (let k = 0; k < SHORT_MDCT_SIZE; k++) out[k * m + b] = espectro[k]!;
  }
  return out;
}

export interface CeltFrameOptions {
  /** Muestras por canal: 120, 240, 480 o 960. */
  frameSize: number;
  /** Bytes que puede ocupar la trama CELT (sin contar el byte TOC de Opus). */
  bytes: number;
  /** Qué hacer con la dispersión. Por defecto, decidida por trama. */
  spread?: SpreadMode;
  /** Qué hacer con los transitorios. Por defecto, detectados por trama. */
  transient?: TransientMode;
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
  const {
    frameSize,
    bytes,
    spread: spreadMode = 'adaptive',
    transient: transientMode = 'adaptive',
  } = options;
  const channels = state.channels;
  const lm = Math.log2(frameSize / SHORT_MDCT_SIZE);
  if (!Number.isInteger(lm) || lm < 0 || lm > 3) {
    throw new Error(`tamaño de trama no válido: ${frameSize}`);
  }
  const m = 1 << lm;
  const totalBits = bytes * 8;
  const enc = new RangeEncoder(bytes);
  const window = windowFor(state, frameSize);

  // ── Pre-énfasis ───────────────────────────────────────────────────────────
  //
  // Va ANTES de la MDCT y separado de ella a propósito: el detector de
  // transitorios trabaja sobre esta señal, y hasta que no haya decidido no se
  // sabe si la trama lleva una MDCT larga o `m` cortas.
  //
  // El buffer de análisis lleva por canal las `OVERLAP` muestras de la trama
  // anterior delante de las nuevas: un golpe que cae en las primeras muestras
  // sólo se ve como salto si hay con qué compararlo.
  const fresh = new Float64Array(frameSize * channels);
  const analisis = new Float64Array((frameSize + OVERLAP) * channels);
  let silence = true;
  for (let c = 0; c < channels; c++) {
    const canal = preemphasis(pcm, c, channels, frameSize, state.preemphMem);
    fresh.set(canal, c * frameSize);
    analisis.set(state.history.subarray(c * OVERLAP, (c + 1) * OVERLAP), c * (frameSize + OVERLAP));
    analisis.set(canal, c * (frameSize + OVERLAP) + OVERLAP);
    for (let i = 0; i < frameSize; i++) if (pcm[i * channels + c] !== 0) silence = false;
  }

  // ── Bandera de silencio ───────────────────────────────────────────────────
  // Va la primera y sólo si el coder está recién empezado (tell()==1).
  if (enc.tell() === 1) enc.bitLogp(silence ? 1 : 0, 15);
  else silence = false;

  // Y con esa bandera puesta, la trama SE ACABA AQUÍ.
  //
  // No es un ahorro de bits: es lo que mantiene a los dos lados de acuerdo. El
  // decodificador, al leer un 1, se comporta como si ya hubiera consumido el
  // paquete entero —así que ninguno de los elementos que vienen detrás cabe— y
  // deja TODAS las bandas en `SILENT_ENERGY`. Si el codificador siguiera
  // escribiendo energías de verdad, se quedaría con una referencia que el
  // decodificador no tiene, y la predicción de las tramas SIGUIENTES partiría de
  // dos sitios distintos: en la escala logarítmica ese desfase se arrastra y se
  // amplifica banda a banda a través del término `prev`, hasta varios dB en las
  // agudas. Se oye como un golpe que vuelve apagado justo después de un
  // silencio, que en un DAW es exactamente cada golpe del pack de batería.
  if (silence) {
    for (let c = 0; c < channels; c++) {
      state.history.set(
        fresh.subarray((c + 1) * frameSize - OVERLAP, (c + 1) * frameSize),
        c * OVERLAP,
      );
    }
    state.oldBandE.fill(SILENT_ENERGY);
    state.consecTransient = 0;
    return enc.done();
  }

  // ── Postfiltro: no se usa, pero la bandera va igual ───────────────────────
  if (enc.tell() + 16 <= totalBits) enc.bitLogp(0, 1);

  // ── Transitorio ───────────────────────────────────────────────────────────
  //
  // La MISMA trampa que la inclinación y la dispersión, y la peor de las tres:
  // la decisión va DENTRO del `if` que la escribe. Cuando el bit no cabe, el
  // decodificador da por hecho que la trama es de bloque largo. Si aquí se
  // decidiera fuera, en esas tramas nosotros haríamos `m` MDCT cortas
  // intercaladas y él una larga: no sería un error —ni saltaría nada—, sería
  // otra señal.
  let isTransient = 0;
  let tfEstimate = 0;
  let tfChan = 0;
  if (lm > 0 && enc.tell() + 3 <= totalBits) {
    if (transientMode !== 'off') {
      const golpe = transientAnalysis(analisis, frameSize + OVERLAP, channels);
      tfEstimate = golpe.tfEstimate;
      tfChan = golpe.tfChan;
      if (transientMode === 'adaptive') isTransient = golpe.isTransient ? 1 : 0;
      else if (transientMode === 'force') isTransient = 1;
    }
    enc.bitLogp(isTransient, 3);
  }
  const shortBlocks = isTransient === 1;
  state.consecTransient = isTransient ? state.consecTransient + 1 : 0;

  // ── MDCT ──────────────────────────────────────────────────────────────────
  const coeffs = new Float64Array(frameSize * channels);
  for (let c = 0; c < channels; c++) {
    const canal = fresh.subarray(c * frameSize, (c + 1) * frameSize);
    const history = state.history.subarray(c * OVERLAP, (c + 1) * OVERLAP);
    const spectrum = shortBlocks
      ? frameMdctShort(history, canal, frameSize, m, state.shortWindow)
      : frameMdct(history, canal, frameSize, window);
    coeffs.set(spectrum, c * frameSize);
  }
  // El historial de la siguiente trama son las últimas `OVERLAP` muestras.
  for (let c = 0; c < channels; c++) {
    state.history.set(
      fresh.subarray((c + 1) * frameSize - OVERLAP, (c + 1) * frameSize),
      c * OVERLAP,
    );
  }

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

  // ── Resolución tiempo/frecuencia ──────────────────────────────────────────
  //
  // Sin esto, el bit de transitorio no sirve de nada: con `tf_res` a cero la
  // tabla del formato manda RECOMBINAR los `m` sub-bloques hasta volver a
  // resolución de frecuencia, y la trama corta acaba sonando como una larga.
  // Aquí se decide banda a banda —el sub del bombo quiere frecuencia, el click
  // de arriba quiere tiempo— con la L1 como criterio y un Viterbi que evita que
  // una banda se salga del grupo por un margen mínimo.
  const tfRes = new Int32Array(NB_BANDS);
  let tfSelect = 0;
  if (transientMode !== 'off' && lm > 0) {
    const tf = tfAnalysis(
      shape,
      OPUS_EBANDS,
      NB_BANDS,
      isTransient,
      lm,
      frameSize,
      tfChan,
      tfEstimate,
    );
    tfRes.set(tf.tfRes);
    tfSelect = tf.tfSelect;
  }
  encodeTf(enc, tfRes, lm, isTransient, tfSelect, totalBits);

  // ── Dispersión ────────────────────────────────────────────────────────────
  //
  // La MISMA trampa que la inclinación, y por eso la decisión va DENTRO del
  // `if`: el símbolo sólo se transmite si cabe, y cuando no cabe el
  // decodificador da por hecho `SPREAD_NORMAL`. Decidir fuera y escribir dentro
  // dejaría a los dos lados rotando las bandas de forma distinta antes del PVQ
  // — y eso no da error, da ruido.
  let spread = SPREAD_NORMAL;
  if (enc.tell() + 4 <= totalBits) {
    if (spreadMode === 'none') {
      spread = SPREAD_NONE;
    } else if (spreadMode === 'adaptive' && !shortBlocks && bytes >= 10 * channels) {
      // Con menos de 10 bytes por canal el análisis no compensa: son tramas
      // donde apenas hay pulsos que repartir. Es la misma guarda que la
      // referencia.
      spread = spreadingDecision(
        shape,
        OPUS_EBANDS,
        NB_BANDS,
        channels,
        m,
        frameSize,
        state.spreadState,
      );
    }
    enc.icdf(spread, SPREAD_ICDF, 5);
  }

  // ── Dynalloc: refuerzo a las bandas que destacan sobre sus vecinas ────────
  const caps = initCaps(state.cache, OPUS_EBANDS, lm, channels);
  const wanted = dynallocAnalysis(bandLogE, bytes, lm, channels);
  const { offsets, totalBoost } = encodeDynalloc(enc, wanted, caps, lm, channels, totalBits);

  // ── Inclinación del reparto ───────────────────────────────────────────────
  //
  // El `− totalBoost` NO es un detalle: el decodificador calcula el mismo
  // refuerzo total y aplica esta misma condición para saber si tiene que leer la
  // inclinación. Si aquí sobra o falta, uno escribe un símbolo que el otro no
  // espera y todo lo que viene detrás se lee corrido.
  //
  // Y el 5 de partida tampoco: la inclinación se ANALIZA solo dentro de la
  // rama que la escribe. Analizarla fuera y escribirla dentro sería el fallo
  // más caro posible — en las tramas donde no cabe el símbolo, nosotros
  // repartiríamos con la inclinación calculada y el decodificador con el 5 por
  // defecto, así que los dos leerían un número de pulsos distinto por banda y
  // el paquete se descolocaría entero. No da error: da ruido.
  let allocTrim = 5;
  if (enc.tellFrac() + (6 << BITRES) <= (totalBits << BITRES) - totalBoost) {
    allocTrim = allocTrimAnalysis(bandLogE, NB_BANDS, channels);
    enc.icdf(allocTrim, TRIM_ICDF, 7);
  }

  // ── Asignación de bits ────────────────────────────────────────────────────
  let bits = ((bytes * 8) << BITRES) - enc.tellFrac() - 1;
  // El anti-colapso: un bit reservado que sólo existe en tramas cortas.
  //
  // Con `m` sub-bloques hay `m` veces más bandas que llenar y los mismos bits,
  // así que es normal que algún sub-bloque de alguna banda se quede con CERO
  // pulsos. Un cero absoluto en medio de un golpe no suena a poca resolución:
  // suena a hueco, y el hueco se oye más que el ruido. El bit le dice al
  // decodificador que rellene esos huecos con ruido al nivel de la trama
  // anterior.
  //
  // La condición es del formato, no una preferencia: el decodificador reserva
  // exactamente lo mismo con la misma cuenta, y si aquí sobrara o faltara un
  // bit, todo lo que viene detrás se leería corrido.
  const antiCollapseRsv =
    isTransient && lm >= 2 && bits >= (lm + 2) << BITRES ? 1 << BITRES : 0;
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

  // ── Anti-colapso ──────────────────────────────────────────────────────────
  //
  // Va DESPUÉS de las bandas y antes de las sobras, en el hueco que se reservó
  // arriba. Se enciende salvo en rachas: con dos tramas transitorias seguidas o
  // más, lo que hay ya no es «un golpe en un silencio» sino textura densa, y
  // rellenar de ruido deja de tapar huecos y empieza a ensuciar.
  if (antiCollapseRsv > 0) enc.bits(state.consecTransient < 2 ? 1 : 0, 1);


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
  tfSelectIn: number,
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

  // El `tf_select` sólo se manda si de verdad cambiaría algo — y cuando no se
  // manda vuelve a cero, porque eso es lo que va a suponer el decodificador.
  let tfSelect = tfSelectIn;
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
 * Inclinación del reparto de bits (`alloc_trim`), del 0 al 10, sacada de la
 * PENDIENTE del espectro.
 *
 * El asignador reparte bits entre bandas con una recta cuya inclinación es este
 * número: por debajo de 5 favorece a los graves, por encima a los agudos. Con
 * el 5 fijo, un acorde —que tiene toda su energía abajo y casi nada arriba—
 * recibía el mismo esfuerzo en las bandas vacías que en las que llevaban la
 * música. Los bits no se pierden en el aire: se los quita a donde se oyen.
 *
 * La medida es el momento de primer orden del espectro: cada banda pesa por lo
 * lejos que está del centro (`2 + 2i − end` va de negativo abajo a positivo
 * arriba), así que la suma sale negativa cuando la energía cae hacia los
 * agudos y positiva cuando sube. Eso se acota a ±2 sobre el 5 neutro, porque
 * más que eso deja de ser inclinar el reparto y pasa a ser vaciar un extremo.
 *
 * Port de `alloc_trim_analysis` de `celt/celt_encoder.c` (rama de coma
 * flotante, donde los `QCONST16`/`SHR32` son la identidad). Se porta el término
 * de la pendiente; los otros tres de la referencia piden cosas que este encoder
 * todavía no tiene —el ancho estéreo medido, la estimación de resolución
 * temporal y el trim de sonido envolvente— y sumar un término a medias movería
 * la inclinación con un número que no significa lo que dice.
 */
export function allocTrimAnalysis(
  bandLogE: Float64Array,
  end: number,
  channels: number,
): number {
  let diff = 0;
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < end - 1; i++) {
      diff += bandLogE[i + c * NB_BANDS]! * (2 + 2 * i - end);
    }
  }
  diff /= channels * (end - 1);
  const trim = 5 - Math.max(-2, Math.min(2, (diff + 1) / 6));
  // Un no-número aquí no sonaría peor: `enc.icdf` escribiría un símbolo que no
  // existe en el alfabeto y el archivo dejaría de ABRIRSE. No puede pasar con
  // un `bandLogE` bien formado —los infinitos los recoge el acotado de arriba—
  // pero el precio de asegurarlo es una comparación y el de no hacerlo es un
  // export ilegible.
  if (!Number.isFinite(trim)) return 5;
  // Truncado y no redondeado: en la referencia esto es una asignación de float
  // a int, y aquí se copia el comportamiento en vez de mejorarlo — la gracia de
  // portar es que las dos implementaciones tomen la MISMA decisión.
  return Math.max(0, Math.min(10, Math.trunc(trim)));
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
