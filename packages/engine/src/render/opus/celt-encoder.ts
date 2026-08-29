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
 *   sale de la planitud de cada banda), el transitorio —con su reparto de
 *   resolución tiempo/frecuencia por banda, en `transient.ts`—, el postfiltro
 *   —el predictor de tono, en `postfilter.ts`— y el estéreo —dónde empieza la
 *   intensidad y si conviene el estéreo dual, en `stereo.ts`—.
 *
 * Y hay una tercera que no es ni una cosa ni la otra porque no viaja en la
 * trama: **cuántos bytes mide la trama**. La decide `vbr.ts` desde fuera, en
 * `encoder.ts`, y llega aquí como `bytes`; el decodificador la saca de la
 * longitud del paquete, que se la da el contenedor.
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
import { celtWindow, celtWindowFull, mdct } from './mdct';
import {
  COMBFILTER_MAXPERIOD,
  COMBFILTER_MINPERIOD,
  POSTFILTER_GAIN_STEP,
  combFilter,
  pitchAnalysis,
  type PostfilterMode,
} from './postfilter';
import { quantAllBands } from './quant-bands';
import { RangeEncoder } from './range-coder';
import {
  OPUS_EBANDS,
  computeLogN,
  ilog,
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
import {
  intensityBand,
  intensityBandForFrame,
  stereoAnalysis,
  type StereoMode,
} from './stereo';
import { tfAnalysis, transientAnalysis, type TonalGate, type TransientMode } from './transient';
import {
  BITRES,
  E_MEANS,
  NB_BANDS,
  SPREAD_ICDF,
  TAPSET_ICDF,
  TF_SELECT_TABLE,
  TRIM_ICDF,
} from './tables';
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
  /**
   * Últimas `OVERLAP` muestras de cada canal, con la pre-énfasis y el PREFILTRO
   * ya aplicados. Es lo que la MDCT solapa con la trama siguiente.
   */
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
   * Historial del filtro de peine: `COMBFILTER_MAXPERIOD` muestras por canal de
   * señal SIN filtrar, con la pre-énfasis aplicada.
   *
   * Es otra memoria distinta de `history`, y confundirlas sería predecir desde
   * una señal que el decodificador no tiene: el peine saca su copia retardada
   * de la señal de ENTRADA, mientras que la MDCT trabaja sobre la ya filtrada.
   */
  prefilterMem: Float64Array;
  /**
   * Período, ganancia y `tapset` del postfiltro de la trama ANTERIOR.
   *
   * Aquí se guarda lo que se TRANSMITIÓ, nunca lo que se midió. Es toda la
   * sincronía del postfiltro: el decodificador cruza la zona de solape de estos
   * tres valores a los de la trama nueva, y si el codificador cruzara desde
   * otros, los dos historiales se separarían y no volverían a juntarse.
   */
  prefilterPeriod: number;
  prefilterGain: number;
  prefilterTapset: number;
  /** Ventana de subida del cruce del peine (`OVERLAP` muestras). */
  combWindow: Float64Array;
  /** Borrador del análisis de tono, reutilizado entre tramas. */
  pitchScratch: Float64Array;
  /** Borrador de `historial + trama` que ve el peine, reutilizado. */
  preBuf: Float64Array;
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
    prefilterMem: new Float64Array(COMBFILTER_MAXPERIOD * channels),
    prefilterPeriod: 0,
    prefilterGain: 0,
    prefilterTapset: 0,
    combWindow: celtWindow(OVERLAP),
    // La trama más larga es de 960: con eso el borrador del tono mide
    // `(1024 + 960) / 2` y sirve para cualquier tamaño de trama.
    pitchScratch: new Float64Array((COMBFILTER_MAXPERIOD + 960) >> 1),
    preBuf: new Float64Array((COMBFILTER_MAXPERIOD + 960) * channels),
    consecTransient: 0,
  };
}

/**
 * Aplica el prefiltro a la trama y deja el estado del peine como quedará en el
 * decodificador.
 *
 * Tres cosas, y las tres tienen que pasar juntas:
 *
 * 1. La trama en `fresh` se sustituye por la FILTRADA, que es lo que ve la MDCT.
 * 2. `prefilterMem` se queda con las últimas `COMBFILTER_MAXPERIOD` muestras de
 *    la señal SIN filtrar, que es de donde predice el peine.
 * 3. El período, la ganancia y el `tapset` que se guardan son los TRANSMITIDOS.
 *
 * Se llama también en las tramas de silencio, y no por simetría: el
 * decodificador, en una trama de silencio, no lee parámetros nuevos pero SIGUE
 * aplicando el peine con los de la anterior cruzándolo a cero. Si aquí se
 * saltara, el historial de los dos lados dejaría de ser el mismo justo en la
 * trama siguiente — que es exactamente la forma del bug del silencio, por el
 * otro extremo.
 */
function aplicarPrefiltro(
  state: CeltEncoderState,
  pre: Float64Array,
  preLen: number,
  fresh: Float64Array,
  frameSize: number,
  channels: number,
  period: number,
  gain: number,
  tapset: number,
): void {
  // El período de la trama anterior se acota igual que en el decodificador. Un
  // peine de período 0 no existe, y los dos lados tienen que acotarlo IGUAL.
  const anterior = Math.max(state.prefilterPeriod, COMBFILTER_MINPERIOD);
  const filtrada = new Float64Array(frameSize);
  for (let c = 0; c < channels; c++) {
    const base = c * preLen + COMBFILTER_MAXPERIOD;
    // Las ganancias van NEGADAS: el codificador resta lo que el decodificador
    // va a sumar. Es el par análisis/síntesis, no una preferencia de signo.
    combFilter(
      filtrada,
      0,
      pre,
      base,
      anterior,
      period,
      frameSize,
      -state.prefilterGain,
      -gain,
      state.prefilterTapset,
      tapset,
      state.combWindow,
      OVERLAP,
    );
    fresh.set(filtrada, c * frameSize);
    state.prefilterMem.set(
      pre.subarray(c * preLen + frameSize, c * preLen + frameSize + COMBFILTER_MAXPERIOD),
      c * COMBFILTER_MAXPERIOD,
    );
  }
  state.prefilterPeriod = period;
  state.prefilterGain = gain;
  state.prefilterTapset = tapset;
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
  /** Qué hacer con el postfiltro. Por defecto, decidido por trama. */
  postfilter?: PostfilterMode;
  /** Qué hacer con el estéreo. Por defecto, intensidad y dual por trama. */
  stereo?: StereoMode;
  /**
   * Qué hace `tfAnalysis` con el peso de cada banda en su Viterbi.
   *
   * Por defecto `'importancia-larga'`: en tramas de bloque largo (no
   * transitorias), cada banda pesa según cuánto sobresale del suelo de ruido
   * —ver `bandImportance`—, así que un parcial armónico aislado no cede su
   * resolución de frecuencia sólo por parecerse a sus vecinas. Es lo que
   * recupera el acorde en estéreo sin tocar la percusión: medido en el banco
   * (`opus-tf-recover-ab.ts`), la peor cifra de patrón pasa de −10,99 a
   * −10,61 dB y la media mejora de −0,26 a −0,22, con la percusión IDÉNTICA
   * a como estaba (por eso «larga»: en tramas transitorias, isTransient=1, el
   * peso es siempre 1 — el ataque real no se toca).
   *
   * `'plano'` es lo que hacía este encoder antes de esta pieza (todas las
   * bandas pesan igual) y `'importancia'` aplica el peso también en tramas
   * transitorias; las tres existen para que el banco pueda medir una contra
   * otra. `'importancia'` sin restringir SÍ le quita algo a la percusión en
   * estéreo (hasta −0,4 dB de patrón en algún caso) — por eso no es el valor
   * por defecto.
   */
  tfWeight?: TfWeightMode;
  /**
   * Si se activa el apagado por tonalidad del detector de transitorios — ver
   * `TonalGate` en `transient.ts`. Por defecto `false`: **medido y
   * descartado** — en el banco no mueve la peor cifra del acorde (de hecho la
   * empeora una décima, −10,99 a −11,07 dB), porque esa peor cifra no la causan
   * los falsos positivos del detector —eso ya lo recupera `'importancia-larga'`—
   * sino las tramas del fundido de salida en sombra del VBR, una causa
   * distinta y ya medida aparte (ver `vbr.ts`). Se deja el mecanismo
   * disponible para el banco porque no hace daño (percusión intacta) y por si
   * sirve para otra señal el día de mañana, pero no se activa por defecto sin
   * un caso que lo justifique.
   */
  tonalGate?: boolean;
}

/**
 * Qué hace `tfAnalysis` con el peso de cada banda en su Viterbi. Ver
 * `CeltFrameOptions.tfWeight`.
 */
export type TfWeightMode = 'plano' | 'importancia' | 'importancia-larga';

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
    postfilter: postfilterMode = 'adaptive',
    stereo: stereoMode = 'adaptive',
    tfWeight: tfWeightMode = 'importancia-larga',
    tonalGate = false,
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
  // Va ANTES de la MDCT y separado de ella a propósito: por delante todavía
  // tiene que pasar el prefiltro, y el detector de transitorios trabaja sobre
  // el resultado — hasta que no haya decidido no se sabe si la trama lleva una
  // MDCT larga o `m` cortas.
  const fresh = new Float64Array(frameSize * channels);
  // `pre`: por canal, las 1024 muestras de historial SIN filtrar seguidas de la
  // trama nueva. Es de donde el peine saca su copia retardada, y por eso llega
  // 1024 muestras atrás y no `OVERLAP`.
  const preLen = COMBFILTER_MAXPERIOD + frameSize;
  const pre =
    state.preBuf.length >= preLen * channels
      ? state.preBuf.subarray(0, preLen * channels)
      : new Float64Array(preLen * channels);
  let silence = true;
  for (let c = 0; c < channels; c++) {
    const canal = preemphasis(pcm, c, channels, frameSize, state.preemphMem);
    fresh.set(canal, c * frameSize);
    pre.set(
      state.prefilterMem.subarray(c * COMBFILTER_MAXPERIOD, (c + 1) * COMBFILTER_MAXPERIOD),
      c * preLen,
    );
    pre.set(canal, c * preLen + COMBFILTER_MAXPERIOD);
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
    // El peine se apaga, pero se APLICA: el decodificador cruza a cero desde
    // los parámetros de la trama anterior, y el historial tiene que quedar
    // igual en los dos lados. Ver `aplicarPrefiltro`.
    aplicarPrefiltro(state, pre, preLen, fresh, frameSize, channels, COMBFILTER_MINPERIOD, 0, 0);
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

  // ── Postfiltro: el predictor de tono ──────────────────────────────────────
  //
  // El peine reinyecta una copia retardada del período fundamental. Aquí se
  // RESTA de la entrada y el decodificador la SUMA a su salida: el residuo que
  // viaja es más pequeño, y —lo que más se oye— el ruido de cuantización sale
  // con los polos del peine, o sea metido debajo de los armónicos, que es
  // donde el oído no lo oye.
  //
  // La MISMA trampa que la inclinación, la dispersión y el transitorio, y aquí
  // por partida doble: el bloque entero sólo se transmite si caben 16 bits, y
  // DENTRO, el `tapset` sólo si caben 2 más. Cuando algo no cabe, el
  // decodificador da por hecho que no hay postfiltro y que el `tapset` es 0.
  // Por eso todo el análisis va DENTRO del `if`: decidir fuera y escribir
  // dentro dejaría al codificador restando un peine que el otro no va a sumar
  // — y eso no se arregla en la trama siguiente, porque los dos historiales se
  // separan y ya no vuelven a juntarse.
  //
  // (`enc.tell()` aquí vale 2 y la referencia usa el 1 de antes de la bandera
  // de silencio; con `totalBits` siempre múltiplo de 8, las dos condiciones
  // dicen lo mismo.)
  let pitchIndex = COMBFILTER_MINPERIOD;
  let gain1 = 0;
  let pfTapset = 0;
  if (enc.tell() + 16 <= totalBits) {
    if (postfilterMode !== 'off' && bytes > 12 * channels) {
      // Con menos de 12 bytes por canal no hay residuo que valga la pena
      // aplanar, y es además la guarda que garantiza que el bit de encendido
      // cabe. Es la misma de la referencia.
      const tono = pitchAnalysis(
        pre,
        preLen,
        frameSize,
        channels,
        state.prefilterPeriod,
        state.prefilterGain,
        state.pitchScratch,
      );
      pitchIndex = tono.period;
      gain1 = tono.gain;
      // El `tapset` sale del análisis de dispersión de la trama ANTERIOR: en
      // ésta todavía no se ha hecho, porque el postfiltro va antes en el
      // paquete.
      pfTapset = state.spreadState.tapset;
    }

    // El umbral de encendido. Sube cuando el período salta respecto al de la
    // trama anterior —un peine que cambia de nota cada 20 ms mete más artefacto
    // del que quita— y cuando quedan pocos bytes; baja cuando la trama anterior
    // ya lo llevaba fuerte, porque apagarlo de golpe también se oye.
    let umbral = 0.2;
    if (Math.abs(pitchIndex - state.prefilterPeriod) * 10 > pitchIndex) umbral += 0.2;
    if (bytes < 25) umbral += 0.1;
    if (bytes < 35) umbral += 0.1;
    if (state.prefilterGain > 0.4) umbral -= 0.1;
    if (state.prefilterGain > 0.55) umbral -= 0.1;
    if (umbral < 0.2) umbral = 0.2;

    if (gain1 < umbral) {
      enc.bitLogp(0, 1);
      gain1 = 0;
    } else {
      // Histéresis: si la ganancia se parece a la de la trama anterior, se
      // reusa tal cual, y así el peine no respira de trama en trama.
      if (Math.abs(gain1 - state.prefilterGain) < 0.1) gain1 = state.prefilterGain;
      let qg = Math.floor(0.5 + (gain1 * 32) / 3) - 1;
      qg = Math.max(0, Math.min(7, qg));
      enc.bitLogp(1, 1);
      // El período va en octava + resto y no en diez bits crudos: los períodos
      // cortos son mucho más frecuentes y así cuestan la mitad.
      const codificado = pitchIndex + 1;
      const octave = ilog(codificado) - 5;
      enc.uint(octave, 6);
      enc.bits(codificado - (16 << octave), 4 + octave);
      enc.bits(qg, 3);
      if (enc.tell() + 2 <= totalBits) enc.icdf(pfTapset, TAPSET_ICDF, 2);
      else pfTapset = 0;
      // Y a partir de aquí se usa la ganancia RECONSTRUIDA, no la medida: es la
      // única que el decodificador va a tener.
      gain1 = POSTFILTER_GAIN_STEP * (qg + 1);
    }
  }
  const pfOn = gain1 > 0;

  // Y ahora se aplica. Va aquí, después de escribir la decisión y antes de todo
  // lo demás, porque el detector de transitorios y la MDCT tienen que ver la
  // señal YA filtrada — igual que el decodificador reconstruye y luego filtra.
  aplicarPrefiltro(state, pre, preLen, fresh, frameSize, channels, pitchIndex, gain1, pfTapset);

  // El buffer de análisis lleva por canal las `OVERLAP` muestras de la trama
  // anterior delante de las nuevas: un golpe que cae en las primeras muestras
  // sólo se ve como salto si hay con qué compararlo.
  const analisis = new Float64Array((frameSize + OVERLAP) * channels);
  for (let c = 0; c < channels; c++) {
    analisis.set(state.history.subarray(c * OVERLAP, (c + 1) * OVERLAP), c * (frameSize + OVERLAP));
    analisis.set(
      fresh.subarray(c * frameSize, (c + 1) * frameSize),
      c * (frameSize + OVERLAP) + OVERLAP,
    );
  }

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
      const tonal: TonalGate = { gain1, activo: tonalGate };
      const golpe = transientAnalysis(analisis, frameSize + OVERLAP, channels, tonal);
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

  // El peso por banda para `tfAnalysis`, si toca calcularlo. Tiene que ser
  // ANTES de `quantCoarseEnergy`: usa `state.oldBandE` de la trama ANTERIOR
  // (para el caso de 2,5 ms — ver `bandImportance`), y `quantCoarseEnergy` lo
  // sobrescribe con la energía de ÉSTA para que la siguiente prediga de ahí.
  const tfImportance =
    tfWeightMode === 'importancia' || tfWeightMode === 'importancia-larga'
      ? bandImportance(bandLogE, state.oldBandE, state.logN, channels, lm, bytes)
      : undefined;

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
      tfWeightMode === 'importancia-larga' && isTransient ? undefined : tfImportance,
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
        // El `tapset` del peine sólo se actualiza cuando la trama lleva
        // postfiltro y no es de bloques cortos: fuera de ahí la medida de
        // agudos no dice nada sobre lo que hay que ajustar.
        pfOn && !shortBlocks,
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

  // ── Estéreo: intensidad y dual ────────────────────────────────────────────
  //
  // Las dos son reparto de bits entre canales, no síntesis nueva, y las dos
  // entran en el asignador como una PETICIÓN: lo que se transmite y lo que se
  // usa después es lo que él devuelve, porque puede recortar la intensidad a
  // `codedBands`. Ver `stereo.ts`.
  //
  // Aquí no hay trampa de formato —los dos símbolos se escriben dentro de su
  // `if` en `interpBitsToPulses`, y cuando no caben el asignador devuelve los
  // valores por defecto que el decodificador da por hechos— pero sí la hay de
  // ORDEN: la petición tiene que estar decidida antes de llamar al asignador,
  // porque la intensidad cambia el grado de libertad de más del estéreo
  // acoplado y con él el reparto entre nivel y forma de todas las bandas.
  let intensity = NB_BANDS;
  let dualStereo = 0;
  if (channels === 2) {
    if (stereoMode === 'adaptive' || stereoMode === 'intensity') {
      intensity = intensityBandForFrame(
        shape,
        bandE,
        OPUS_EBANDS,
        NB_BANDS,
        NB_BANDS,
        lm,
        frameSize,
        intensityBand(bytes, lm, 0, NB_BANDS),
      );
    }
    // El estéreo dual no se enciende NUNCA en las cuatro señales del banco —el
    // canal derecho de todas es el izquierdo retrasado, y para eso el mid/side
    // sigue saliendo más barato—, así que ahí mide exactamente cero. Entra igual
    // porque donde sí se enciende gana mucho: con dos fuentes distintas, una en
    // cada canal, son +3,80 dB de patrón (control `repartidos` de
    // `opus-stereo-ab.ts`). En tramas de 2,5 ms no se mira: no hay ángulos que
    // ahorrar porque las bandas graves no se parten.
    if (
      (stereoMode === 'adaptive' || stereoMode === 'dual') &&
      lm !== 0 &&
      stereoAnalysis(shape, OPUS_EBANDS, lm, frameSize)
    ) {
      dualStereo = 1;
    }
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
      intensity,
      dualStereo,
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
 * Profundidad de bits asumida para el suelo de ruido de `bandImportance`.
 *
 * La referencia la saca de `st->lsb_depth` (la profundidad de la fuente, para
 * no fingir más resolución de la que hay). Este encoder trabaja siempre en
 * `Float64Array`: no hay una profundidad de origen que perder, así que se fija
 * al máximo que admite la referencia (24), que es el mismo valor con el que
 * arranca `OpusEncoder` antes de que nadie le diga lo contrario.
 */
const LSB_DEPTH_ASUMIDA = 24;

function medianDe3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function medianDe5(a: number, b: number, c: number, d: number, e: number): number {
  const x = [a, b, c, d, e].sort((p, q) => p - q);
  return x[2]!;
}

/**
 * Cuánto sobresale cada banda por encima de lo que se espera de ella, para
 * PESAR —no para pedir bits, que ya lo hace `dynallocAnalysis`— la decisión de
 * `tfAnalysis`: una banda que grita por encima de su entorno importa más que
 * una que apenas se distingue del suelo de ruido, así que ceder su resolución
 * de frecuencia a cambio de parecerse a las vecinas cuesta más caro.
 *
 * Puerto de la parte de `dynalloc_analysis` (`celt_encoder.c`) que calcula
 * `importance[]`: el suelo de ruido por banda (`noise_floor`, con `E_MEANS` y
 * `logN` de la referencia) y el «follower» —una envolvente que sigue el
 * espectro por debajo, suavizada con un filtro de mediana para no disparar por
 * un valle aislado— de donde sale cuánto sobresale cada banda.
 *
 * Simplificaciones declaradas frente a la referencia, las tres inertes en este
 * puerto (no cambian el resultado, sólo el código que haría falta para no
 * simplificarlas):
 *
 * - Sin sonido envolvente (`energy_mask` de la referencia: sólo existe para
 *   codificar varios canales de un lecho ambisónico a la vez, y este encoder
 *   no lo hace), así que el término correspondiente es siempre cero.
 * - Sin híbrido SILK+CELT (`bandLogE2` de la referencia difiere de `bandLogE`
 *   sólo cuando `patch_transient_decision` dobla la resolución temporal a
 *   media trama, un mecanismo que este puerto no tiene: aquí `bandLogE2` y
 *   `bandLogE` son SIEMPRE el mismo array).
 * - `lsb_depth` fijo en 24 — ver `LSB_DEPTH_ASUMIDA`.
 *
 * ## Una diferencia declarada con la referencia: el peso base es 1, no 13
 *
 * La referencia deja `importance[i]` en 13 para una banda que no sobresale
 * nada (`round(13·2⁰)`) y hasta 208 para la que sobresale al máximo
 * (`round(13·2⁴)`). Eso está calibrado JUNTO con su propio `lambda` —del orden
 * de 80 a varios miles, en las mismas unidades— así que la proporción entre
 * ambos es la que importa, no el 13 en sí.
 *
 * Este puerto no tiene ese `lambda`: el de `tfAnalysis` es simplemente `lm`
 * (0 a 3), calibrado para un peso IMPLÍCITO de 1 —el de antes de que existiera
 * esta función—. Pegarle el 13-a-208 de la referencia encima de un `lambda` de
 * esa escala no reescala nada: aplana la diferencia entre bandas de verdad
 * destacadas y bandas que sólo están en su sitio, y con eso el Viterbi cambia
 * de fila más de lo que conviene incluso en señales sin ningún tono que
 * proteger (medido: ruido rosa y la mezcla pierden unas décimas de dB con el
 * 13-a-208 crudo). Dividir por 13 devuelve el peso NEUTRO a 1 —una banda
 * corriente pesa exactamente lo que pesaba antes de esta función, cero
 * sesgo— y deja el rango destacado en 1 a 16, la misma proporción que la
 * referencia.
 */
function bandImportance(
  bandLogE: Float64Array,
  oldBandE: Float64Array,
  logN: Int32Array,
  channels: number,
  lm: number,
  effectiveBytes: number,
): Float64Array {
  const end = NB_BANDS;
  // Por debajo de este presupuesto la referencia ni se molesta: con tan pocos
  // bytes no hay margen que pesar de un sitio a otro. El mismo umbral que usa
  // `dynalloc_analysis` (30 + 5·LM), y el resultado es el peso neutro, 1, para
  // que multiplicar por `importance` no cambie nada.
  const importance = new Float64Array(end).fill(1);
  if (effectiveBytes < 30 + 5 * lm) return importance;

  const noiseFloor = new Float64Array(end);
  for (let i = 0; i < end; i++) {
    noiseFloor[i] =
      0.0625 * logN[i]! + 0.5 + (9 - LSB_DEPTH_ASUMIDA) - E_MEANS[i]! + 0.0062 * (i + 5) * (i + 5);
  }

  const follower = new Float64Array(channels * end);
  for (let c = 0; c < channels; c++) {
    // `bandLogE3`: en la referencia puede diferir de `bandLogE` (ver el
    // comentario de la función); aquí son el mismo array, salvo el caso de
    // 2,5 ms de abajo, que necesita su propia copia.
    const bandLogE3 = bandLogE.slice(c * NB_BANDS, c * NB_BANDS + end);
    if (lm === 0) {
      // A 2,5 ms las primeras 8 bandas son de un solo bin: su energía es muy
      // poco fiable, así que se toma el máximo con la de la trama anterior
      // para que al menos dos muestras hayan pesado en el número.
      for (let i = 0; i < Math.min(8, end); i++) {
        bandLogE3[i] = Math.max(bandLogE[c * NB_BANDS + i]!, oldBandE[c * NB_BANDS + i]!);
      }
    }

    const f = follower.subarray(c * end, (c + 1) * end);
    f[0] = bandLogE3[0]!;
    let last = 0;
    for (let i = 1; i < end; i++) {
      // La última banda que sube de verdad respecto a la anterior es la
      // última que cuenta: más allá de ahí seguir sería sesgar hacia arriba en
      // señales de ancho de banda limitado.
      if (bandLogE3[i]! > bandLogE3[i - 1]! + 0.5) last = i;
      f[i] = Math.min(f[i - 1]! + 1.5, bandLogE3[i]!);
    }
    for (let i = last - 1; i >= 0; i--) {
      f[i] = Math.min(f[i]!, Math.min(f[i + 1]! + 2, bandLogE3[i]!));
    }

    // Filtro de mediana: sin él, un valle de una sola banda dispararía el
    // «follower» hacia abajo y de ahí `importance` hacia arriba sin que haya
    // ningún pico real cerca.
    const offset = 1;
    for (let i = 2; i < end - 2; i++) {
      const m5 = medianDe5(
        bandLogE3[i - 2]!,
        bandLogE3[i - 1]!,
        bandLogE3[i]!,
        bandLogE3[i + 1]!,
        bandLogE3[i + 2]!,
      );
      f[i] = Math.max(f[i]!, m5 - offset);
    }
    let tmp = medianDe3(bandLogE3[0]!, bandLogE3[1]!, bandLogE3[2]!) - offset;
    f[0] = Math.max(f[0]!, tmp);
    f[1] = Math.max(f[1]!, tmp);
    tmp = medianDe3(bandLogE3[end - 3]!, bandLogE3[end - 2]!, bandLogE3[end - 1]!) - offset;
    f[end - 2] = Math.max(f[end - 2]!, tmp);
    f[end - 1] = Math.max(f[end - 1]!, tmp);

    for (let i = 0; i < end; i++) f[i] = Math.max(f[i]!, noiseFloor[i]!);
  }

  if (channels === 2) {
    const f0 = follower.subarray(0, end);
    const f1 = follower.subarray(end, 2 * end);
    for (let i = 0; i < end; i++) {
      // «Cross-talk» entre canales: si uno de los dos sigue muy por encima,
      // asumir que algo se cuela en el otro 4 dB por debajo. El orden importa
      // — `f1` se actualiza con el `f0` de ANTES, y `f0` con el `f1` YA nuevo.
      f1[i] = Math.max(f1[i]!, f0[i]! - 4);
      f0[i] = Math.max(f0[i]!, f1[i]! - 4);
    }
    for (let i = 0; i < end; i++) {
      f0[i] = 0.5 * (Math.max(0, bandLogE[i]! - f0[i]!) + Math.max(0, bandLogE[end + i]! - f1[i]!));
    }
  } else {
    for (let i = 0; i < end; i++) follower[i] = Math.max(0, bandLogE[i]! - follower[i]!);
  }

  for (let i = 0; i < end; i++) {
    const exceso = Math.min(follower[i]!, 4);
    importance[i] = Math.pow(2, exceso);
  }
  return importance;
}

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
