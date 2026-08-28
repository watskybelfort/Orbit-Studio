/**
 * El postfiltro de CELT: el predictor de tono.
 *
 * Es un filtro de peine sobre el PERÍODO FUNDAMENTAL. En el codificador va
 * delante de la MDCT y RESTA una copia retardada de la señal (el «prefiltro»);
 * en el decodificador va detrás de la MDCT inversa y la SUMA (el «postfiltro»).
 * Los dos son el par de siempre: el análisis quita la periodicidad, la síntesis
 * la devuelve.
 *
 * Y lo que gana no es sólo que el residuo sea más pequeño. El peine del
 * decodificador es un IIR con polos EN los armónicos, así que también le da
 * forma al ruido de cuantización: lo mete debajo de los parciales, que es donde
 * el oído no lo oye. Por eso ayuda justo en material tonal, y por eso el hueco
 * que deja no tenerlo se ve en el acorde y no en el ruido rosa.
 *
 * ## La pregunta que hay que contestar antes de escribir una línea: ¿hace falta
 * meter el decodificador dentro del codificador?
 *
 * **No.** Y conviene ver por qué, porque la intuición dice que sí:
 *
 * ```
 *   codificador (FIR sobre la ENTRADA):    y[n] = x[n] − g·x[n−T]
 *   decodificador (IIR sobre su SALIDA):   z[n] = ŷ[n] + g·z[n−T]
 * ```
 *
 * El codificador predice de `x`, que tiene delante; el decodificador predice de
 * `z`, que es lo que él mismo acaba de producir. **No son la misma señal** —se
 * diferencian en el error de cuantización— y aun así los dos lados no se
 * separan: si `ŷ = y`, por inducción `z = x`. El lazo es abierto por
 * construcción, y el error que entra por `ŷ` se queda acotado porque `g < 0,66`.
 *
 * Lo que SÍ tiene que estar sincronizado es otra cosa, y es lo único que puede
 * romperse: los **parámetros de la trama anterior** (período, ganancia,
 * `tapset`), que son los que gobiernan el cruce de la zona de solape. El
 * codificador tiene que guardar EXACTAMENTE lo que transmitió —no lo que
 * midió—, porque es lo único que el decodificador va a tener delante. Eso es lo
 * que hace `celtEncodeFrame` al cerrar la trama, y lo que comprueba el test que
 * relee el paquete con el `RangeDecoder`.
 *
 * (La referencia sí tiene un decodificador dentro del codificador, bajo
 * `#ifdef RESYNTH`, pero no es para esto: es para el modo híbrido con SILK y
 * para la ocultación de pérdidas. El prefiltro se aplica a `pre[]`, que es la
 * entrada con pre-énfasis; se lee en `celt/celt.c`, líneas 1204-1216.)
 *
 * ## Lo que cuesta
 *
 * Memoria: `COMBFILTER_MAXPERIOD` (1024) muestras por canal de historial SIN
 * filtrar —el peine tiene que poder alcanzar hasta un período de 1024— más los
 * borradores del análisis de tono. Está medido en `tools/qa/opus-postfilter-ab.ts`.
 *
 * CPU: la búsqueda de tono es lo caro, y por eso va de grueso a fino (diezmado
 * ×4 sobre los 1009 retardos, luego ×2 sólo alrededor de los dos mejores, y
 * luego el refinado de `removeDoubling`) en vez de una correlación completa.
 *
 * ---
 * Port de `comb_filter` de `celt/celt.c` y de `pitch_downsample`,
 * `pitch_search` y `remove_doubling` de `celt/pitch.c` de la implementación de
 * referencia de la RFC 6716 (rama de coma flotante, donde `QCONST16`, `SHR32` y
 * `MULT16_16_Q15` son la identidad). Copyright 1994-2011 IETF Trust, Xiph.Org,
 * Skype Limited, Octasic, Jean-Marc Valin, Timothy B. Terriberry, CSIRO,
 * Gregory Maxwell, Mark Borgerding, Erik de Castro Lopo. BSD-3-Clause.
 */

import { COMB_GAINS } from './tables';

/**
 * Período máximo que puede pedir el peine, en muestras a 48 kHz.
 *
 * 1024 muestras son 21 ms, o sea 47 Hz: por debajo de eso ya no hay tono que
 * seguir. Y es también el tamaño del historial que hay que guardar, porque el
 * filtro alcanza hasta ahí.
 */
export const COMBFILTER_MAXPERIOD = 1024;
/** Período mínimo: 15 muestras son 3,2 kHz. */
export const COMBFILTER_MINPERIOD = 15;
/**
 * Escalón de la ganancia transmitida: 3/32.
 *
 * La ganancia va en tres bits crudos y el decodificador reconstruye
 * `0,09375·(qg+1)`. No es una decisión de este codificador: es la cuantización
 * del formato, escrita como fracción para que se vea de dónde sale.
 */
export const POSTFILTER_GAIN_STEP = 3 / 32;

/**
 * Qué hace el codificador con el postfiltro.
 *
 * - `'adaptive'`: se busca el tono por trama y se enciende si la predicción es
 *   lo bastante buena. Es lo que se exporta.
 * - `'off'`: no se busca y no se enciende nunca. **Sólo para el banco**, que
 *   necesita poder medir lo uno contra lo otro.
 */
export type PostfilterMode = 'adaptive' | 'off';

// ── El filtro de peine ──────────────────────────────────────────────────────

/**
 * Filtro de peine de cinco taps, con cruce de parámetros en la zona de solape.
 *
 * `y[i] = x[i] + g·(a·x[i−T] + b·x[i−T±1] + c·x[i−T±2])`
 *
 * Los cinco taps no son un lujo: un solo tap sólo puede seguir períodos
 * enteros, y un período real casi nunca lo es. Repartir entre `T−2 … T+2`
 * interpola, y el `tapset` elige cuánto se reparte.
 *
 * En las primeras `overlap` muestras los parámetros CRUZAN de los de la trama
 * anterior (`T0`, `g0`, `tapset0`) a los de ésta (`T1`, `g1`, `tapset1`) con el
 * peso `w²` de la ventana de CELT. Sin ese cruce, cambiar de período entre dos
 * tramas metería un click — y el decodificador cruza igual, así que hacerlo de
 * otra forma sería separarse de él.
 */
export function combFilter(
  y: Float64Array,
  yOff: number,
  x: Float64Array,
  xOff: number,
  T0: number,
  T1: number,
  N: number,
  g0: number,
  g1: number,
  tapset0: number,
  tapset1: number,
  window: Float64Array | null,
  overlap: number,
): void {
  // Con las dos ganancias a cero el filtro es la identidad. Salir aquí no es
  // una aproximación —los diez términos valen exactamente cero— y es el caso
  // normal: la mayoría de las tramas no llevan postfiltro.
  if (g0 === 0 && g1 === 0) {
    if (y !== x || yOff !== xOff) {
      for (let i = 0; i < N; i++) y[yOff + i] = x[xOff + i]!;
    }
    return;
  }
  const t0 = COMB_GAINS[tapset0]!;
  const t1 = COMB_GAINS[tapset1]!;
  const g00 = g0 * t0[0]!;
  const g01 = g0 * t0[1]!;
  const g02 = g0 * t0[2]!;
  const g10 = g1 * t1[0]!;
  const g11 = g1 * t1[1]!;
  const g12 = g1 * t1[2]!;

  const cruce = window ? overlap : 0;
  for (let i = 0; i < cruce; i++) {
    const w = window![i]!;
    const f = w * w;
    const u = 1 - f;
    const a = xOff + i;
    y[yOff + i] =
      x[a]! +
      u * g00 * x[a - T0]! +
      u * g01 * (x[a - T0 - 1]! + x[a - T0 + 1]!) +
      u * g02 * (x[a - T0 - 2]! + x[a - T0 + 2]!) +
      f * g10 * x[a - T1]! +
      f * g11 * (x[a - T1 - 1]! + x[a - T1 + 1]!) +
      f * g12 * (x[a - T1 - 2]! + x[a - T1 + 2]!);
  }
  for (let i = cruce; i < N; i++) {
    const a = xOff + i;
    y[yOff + i] =
      x[a]! +
      g10 * x[a - T1]! +
      g11 * (x[a - T1 - 1]! + x[a - T1 + 1]!) +
      g12 * (x[a - T1 - 2]! + x[a - T1 + 2]!);
  }
}

// ── El análisis de tono ─────────────────────────────────────────────────────

/** Autocorrelación hasta el retardo `lag`, sobre `n` muestras. */
function autocorrelacion(x: Float64Array, n: number, lag: number, ac: Float64Array): void {
  for (let l = lag; l >= 0; l--) {
    let d = 0;
    for (let i = l; i < n; i++) d += x[i]! * x[i - l]!;
    ac[l] = d;
  }
  // El `+10` de la referencia: un suelo absoluto para que una trama de silencio
  // digital no deje al Levinson dividiendo por cero.
  ac[0] = ac[0]! + 10;
}

/**
 * Levinson-Durbin: de la autocorrelación a los coeficientes de predicción.
 *
 * Port de `_celt_lpc` de `celt/celt_lpc.c`, rama de coma flotante.
 */
function levinson(ac: Float64Array, p: number, lpc: Float64Array): void {
  let error = ac[0]!;
  lpc.fill(0, 0, p);
  if (ac[0] === 0) return;
  for (let i = 0; i < p; i++) {
    let rr = 0;
    for (let j = 0; j < i; j++) rr += lpc[j]! * ac[i - j]!;
    rr += ac[i + 1]!;
    const r = -rr / error;
    lpc[i] = r;
    for (let j = 0; j < (i + 1) >> 1; j++) {
      const t1 = lpc[j]!;
      const t2 = lpc[i - 1 - j]!;
      lpc[j] = t1 + r * t2;
      lpc[i - 1 - j] = t2 + r * t1;
    }
    error = error - r * r * error;
    // 30 dB de ganancia de predicción ya es de sobra: seguir sólo añade ruido.
    if (error < 0.001 * ac[0]!) break;
  }
}

/**
 * FIR en sitio con memoria de entradas: `y[i] = x[i] + Σ num[j]·x[i−1−j]`.
 *
 * Port de `celt_fir` de `celt/celt_lpc.c`. Puede trabajar en sitio porque la
 * memoria guarda la ENTRADA antes de escribir la salida.
 */
function fir(x: Float64Array, num: Float64Array, ord: number, n: number, mem: Float64Array): void {
  for (let i = 0; i < n; i++) {
    let sum = x[i]!;
    for (let j = 0; j < ord; j++) sum += num[j]! * mem[j]!;
    for (let j = ord - 1; j >= 1; j--) mem[j] = mem[j - 1]!;
    mem[0] = x[i]!;
    x[i] = sum;
  }
}

/**
 * Diezma a la mitad y blanquea: la señal sobre la que se busca el tono.
 *
 * Dos cosas, y las dos importan:
 *
 * - **A la mitad de frecuencia de muestreo.** El tono de la voz y de casi
 *   cualquier instrumento está muy por debajo de 12 kHz, y buscar a 48 kHz
 *   cuesta cuatro veces más para encontrar lo mismo. Los dos canales se SUMAN,
 *   porque el período es el mismo en los dos.
 * - **Blanqueado con un LPC de orden 4.** La autocorrelación de una señal con
 *   mucha energía grave tiene un máximo enorme en el retardo cero y una loma
 *   que tapa los picos de periodicidad. Quitando la envolvente espectral, lo
 *   que queda son los picos — que es lo que se busca.
 *
 * `pre` lleva los canales concatenados con paso `preLen`, y `out` mide `len/2`.
 */
export function pitchDownsample(
  pre: Float64Array,
  preLen: number,
  len: number,
  channels: number,
  out: Float64Array,
): void {
  const n = len >> 1;
  for (let i = 1; i < n; i++) {
    out[i] = 0.5 * (0.5 * (pre[2 * i - 1]! + pre[2 * i + 1]!) + pre[2 * i]!);
  }
  out[0] = 0.5 * (0.5 * pre[1]! + pre[0]!);
  if (channels === 2) {
    const b = preLen;
    for (let i = 1; i < n; i++) {
      out[i] =
        out[i]! + 0.5 * (0.5 * (pre[b + 2 * i - 1]! + pre[b + 2 * i + 1]!) + pre[b + 2 * i]!);
    }
    out[0] = out[0]! + 0.5 * (0.5 * pre[b + 1]! + pre[b]!);
  }

  const ac = new Float64Array(5);
  autocorrelacion(out, n, 4, ac);
  // Suelo de ruido a −40 dB y ventana de retardo: las dos ensanchan un pelo los
  // picos de la autocorrelación para que el Levinson no salga mal condicionado.
  ac[0] = ac[0]! * 1.0001;
  for (let i = 1; i <= 4; i++) ac[i] = ac[i]! - ac[i]! * (0.008 * i) * (0.008 * i);

  const lpc = new Float64Array(4);
  levinson(ac, 4, lpc);
  // Ensanchado de los polos: 0,9 por orden. Un blanqueado total dejaría la
  // señal tan plana que el pico de tono se perdería en el ruido.
  let tmp = 1;
  for (let i = 0; i < 4; i++) {
    tmp *= 0.9;
    lpc[i] = lpc[i]! * tmp;
  }
  const mem = new Float64Array(4);
  fir(out, lpc, 4, n, mem);
  mem[0] = 0;
  lpc[0] = 0.8;
  fir(out, lpc, 1, n, mem);
}

/**
 * Los dos mejores retardos por correlación normalizada.
 *
 * Se compara `xcorr²/Syy` con productos cruzados en vez de dividir, que es lo
 * mismo y no lleva divisiones. `Syy` se arrastra sumando la muestra que entra y
 * restando la que sale, así que el bucle es lineal en el número de retardos y
 * no cuadrático.
 *
 * Port de `find_best_pitch` de `celt/pitch.c`.
 */
function mejoresRetardos(
  xcorr: Float64Array,
  y: Float64Array,
  len: number,
  maxPitch: number,
  best: Int32Array,
): void {
  let syy = 1;
  const bestNum = [-1, -1];
  const bestDen = [0, 0];
  best[0] = 0;
  best[1] = 1;
  for (let j = 0; j < len; j++) syy += y[j]! * y[j]!;
  for (let i = 0; i < maxPitch; i++) {
    if (xcorr[i]! > 0) {
      const num = xcorr[i]! * xcorr[i]!;
      if (num * bestDen[1]! > bestNum[1]! * syy) {
        if (num * bestDen[0]! > bestNum[0]! * syy) {
          bestNum[1] = bestNum[0]!;
          bestDen[1] = bestDen[0]!;
          best[1] = best[0]!;
          bestNum[0] = num;
          bestDen[0] = syy;
          best[0] = i;
        } else {
          bestNum[1] = num;
          bestDen[1] = syy;
          best[1] = i;
        }
      }
    }
    syy += y[i + len]! * y[i + len]! - y[i]! * y[i]!;
    if (syy < 1) syy = 1;
  }
}

/**
 * Busca el retardo de tono. Devuelve el retardo contado desde el principio del
 * historial, en muestras a media frecuencia — quien llama lo convierte.
 *
 * Tres pasadas de grueso a fino, y ahí está todo el ahorro: la primera diezma
 * otra vez por 4 y recorre los 1009 retardos con la cuarta parte de las
 * muestras; la segunda sólo mira ±2 alrededor de los dos mejores; la tercera
 * interpola con las tres correlaciones de alrededor. Una correlación completa a
 * resolución fina costaría unas dieciséis veces más.
 *
 * Port de `pitch_search` de `celt/pitch.c`.
 */
export function pitchSearch(
  x: Float64Array,
  xOff: number,
  y: Float64Array,
  len: number,
  maxPitch: number,
): number {
  const lag = len + maxPitch;
  const n4 = len >> 2;
  const l4 = lag >> 2;
  const x4 = new Float64Array(n4);
  const y4 = new Float64Array(l4);
  const xcorr = new Float64Array(maxPitch >> 1);
  const best = new Int32Array(2);

  for (let j = 0; j < n4; j++) x4[j] = x[xOff + 2 * j]!;
  for (let j = 0; j < l4; j++) y4[j] = y[2 * j]!;

  // Pasada gruesa, diezmando otra vez por 4.
  for (let i = 0; i < maxPitch >> 2; i++) {
    let sum = 0;
    for (let j = 0; j < n4; j++) sum += x4[j]! * y4[i + j]!;
    xcorr[i] = sum > -1 ? sum : -1;
  }
  mejoresRetardos(xcorr, y4, n4, maxPitch >> 2, best);

  // Pasada fina, sólo cerca de los dos mejores.
  const n2 = len >> 1;
  const b0 = best[0]!;
  const b1 = best[1]!;
  for (let i = 0; i < maxPitch >> 1; i++) {
    xcorr[i] = 0;
    if (Math.abs(i - 2 * b0) > 2 && Math.abs(i - 2 * b1) > 2) continue;
    let sum = 0;
    for (let j = 0; j < n2; j++) sum += x[xOff + j]! * y[i + j]!;
    xcorr[i] = sum > -1 ? sum : -1;
  }
  mejoresRetardos(xcorr, y, n2, maxPitch >> 1, best);

  // Pseudo-interpolación: el pico de la correlación casi nunca cae justo en una
  // muestra, y media muestra de error en el período es un peine desafinado.
  let offset = 0;
  if (best[0]! > 0 && best[0]! < (maxPitch >> 1) - 1) {
    const a = xcorr[best[0]! - 1]!;
    const b = xcorr[best[0]!]!;
    const c = xcorr[best[0]! + 1]!;
    if (c - a > 0.7 * (b - a)) offset = 1;
    else if (a - c > 0.7 * (b - c)) offset = -1;
  }
  return 2 * best[0]! - offset;
}

/**
 * Tabla del segundo candidato de `remove_doubling`.
 *
 * NO es del formato —el decodificador no la ve nunca—: es la heurística del
 * codificador para comprobar si un submúltiplo del período tiene sus armónicos
 * donde deberían. Por eso vive aquí y no en `tables.ts`.
 */
const SEGUNDO_CANDIDATO = [0, 0, 3, 2, 3, 2, 5, 2, 3, 2, 3, 2, 5, 2, 3, 2] as const;

export interface Tono {
  /** Período en muestras a 48 kHz, nunca por debajo de `COMBFILTER_MINPERIOD`. */
  period: number;
  /** Ganancia de predicción, de 0 a 1. Es lo que decide si se enciende. */
  gain: number;
}

/**
 * Quita el doblado de octava y afina el período.
 *
 * El problema que resuelve: la correlación de una señal periódica es igual de
 * alta en `T` que en `2T`, `3T`… y la búsqueda se queda con cualquiera. Elegir
 * `2T` no da un error pequeño: da un peine con un diente de más entre cada dos
 * parciales, que reinyecta energía donde no hay nada. Así que se prueban los
 * submúltiplos `T/k` y se salta a uno cuando su correlación es lo bastante
 * buena — con el listón bajado si coincide con el período de la trama anterior,
 * porque la continuidad vale más que un decimal.
 *
 * Devuelve además la ganancia con la que se decide si el postfiltro se enciende.
 *
 * Port de `remove_doubling` de `celt/pitch.c`, rama de coma flotante.
 */
export function removeDoubling(
  buf: Float64Array,
  maxperiodIn: number,
  minperiodIn: number,
  nIn: number,
  T0In: number,
  prevPeriodIn: number,
  prevGain: number,
): Tono {
  const minperiod0 = minperiodIn;
  const maxperiod = maxperiodIn >> 1;
  const minperiod = minperiodIn >> 1;
  const prevPeriod = prevPeriodIn >> 1;
  const N = nIn >> 1;
  // El buffer se mira desde la mitad del historial: `x[i − T]` con `T` hasta
  // `maxperiod` cae justo en la primera muestra.
  const off = maxperiod;
  let T0 = T0In >> 1;
  if (T0 >= maxperiod) T0 = maxperiod - 1;

  let T = T0;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (let i = 0; i < N; i++) {
    const a = buf[off + i]!;
    const b = buf[off + i - T0]!;
    xy += a * b;
    xx += a * a;
    yy += b * b;
  }
  let bestXy = xy;
  let bestYy = yy;
  const g0 = xy / Math.sqrt(1 + xx * yy);
  let g = g0;

  for (let k = 2; k <= 15; k++) {
    // División entera de C: trunca hacia cero, no hacia −∞. Aquí todo es
    // positivo, pero se escribe explícito porque este encoder ya se comió ese
    // fallo una vez y sólo lo vio ffmpeg.
    const T1 = Math.trunc((2 * T0 + k) / (2 * k));
    if (T1 < minperiod) break;
    let T1b: number;
    if (k === 2) T1b = T1 + T0 > maxperiod ? T0 : T0 + T1;
    else T1b = Math.trunc((2 * SEGUNDO_CANDIDATO[k]! * T0 + k) / (2 * k));
    xy = 0;
    yy = 0;
    for (let i = 0; i < N; i++) {
      const a = buf[off + i]!;
      const b = buf[off + i - T1]!;
      const c = buf[off + i - T1b]!;
      xy += a * b + a * c;
      yy += b * b + c * c;
    }
    const g1 = xy / Math.sqrt(1 + 2 * xx * yy);
    let cont = 0;
    if (Math.abs(T1 - prevPeriod) <= 1) cont = prevGain;
    else if (Math.abs(T1 - prevPeriod) <= 2 && 5 * k * k < T0) cont = 0.5 * prevGain;
    if (g1 > 0.3 + 0.4 * g0 - cont) {
      bestXy = xy;
      bestYy = yy;
      T = T1;
      g = g1;
    }
  }

  let pg = bestYy <= bestXy ? 1 : bestXy / (bestYy + 1);

  const xcorr = new Float64Array(3);
  for (let k = 0; k < 3; k++) {
    const T1 = T + k - 1;
    let s = 0;
    for (let i = 0; i < N; i++) s += buf[off + i]! * buf[off + i - T1]!;
    xcorr[k] = s;
  }
  let offset = 0;
  if (xcorr[2]! - xcorr[0]! > 0.7 * (xcorr[1]! - xcorr[0]!)) offset = 1;
  else if (xcorr[0]! - xcorr[2]! > 0.7 * (xcorr[1]! - xcorr[2]!)) offset = -1;
  if (pg > g) pg = g;

  let period = 2 * T + offset;
  if (period < minperiod0) period = minperiod0;
  return { period, gain: pg };
}

/**
 * El análisis completo de una trama: de la señal con pre-énfasis al período y
 * la ganancia.
 *
 * `pre` lleva, por canal y con paso `preLen`, las `COMBFILTER_MAXPERIOD`
 * muestras de historial seguidas de las `frameSize` nuevas.
 */
export function pitchAnalysis(
  pre: Float64Array,
  preLen: number,
  frameSize: number,
  channels: number,
  prevPeriod: number,
  prevGain: number,
  scratch: Float64Array,
): Tono {
  const len = COMBFILTER_MAXPERIOD + frameSize;
  pitchDownsample(pre, preLen, len, channels, scratch);
  let period =
    COMBFILTER_MAXPERIOD -
    pitchSearch(
      scratch,
      COMBFILTER_MAXPERIOD >> 1,
      scratch,
      frameSize,
      COMBFILTER_MAXPERIOD - COMBFILTER_MINPERIOD,
    );
  const tono = removeDoubling(
    scratch,
    COMBFILTER_MAXPERIOD,
    COMBFILTER_MINPERIOD,
    frameSize,
    period,
    prevPeriod,
    prevGain,
  );
  period = tono.period;
  // Dos muestras de margen: el peine lee hasta `x[i − T − 2]`, y con `T` al
  // tope eso se saldría del historial.
  if (period > COMBFILTER_MAXPERIOD - 2) period = COMBFILTER_MAXPERIOD - 2;
  // El 0,7 de la referencia: la ganancia medida es la de un predictor perfecto,
  // y aplicarla entera dejaría el peine al borde de oscilar cuando el período
  // se estima con medio decimal de error.
  return { period, gain: 0.7 * tono.gain };
}
