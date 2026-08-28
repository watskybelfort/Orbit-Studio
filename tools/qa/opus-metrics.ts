/**
 * Las dos medidas del banco de calidad: la de forma de onda y la de oído.
 *
 * Viven juntas y separadas de `opus-quality.ts` a propósito: son la parte que
 * hay que poder probar sin ffmpeg, sin codificar nada y sin esperar minuto y
 * medio. El banco las usa; `packages/engine/test/opus-perceptual.test.ts` las
 * pone a prueba con señales construidas a mano.
 *
 * ## Por qué hacen falta DOS
 *
 * La SNR mide **error total**: energía de la diferencia entre el original y lo
 * decodificado. Es una medida de *diferencia*, y por eso tiene un punto ciego
 * exacto y demostrable: **es invariante a cómo se reparte el error dentro de
 * una banda**. Si un cambio del codificador coge el mismo error y lo mueve de
 * unos bins a otros de la misma banda crítica, la SNR sale idéntica.
 *
 * Y eso no es un caso raro: es LITERALMENTE lo que hace la dispersión (el
 * `spreading` del PVQ de CELT). La rotación de dispersión es ortogonal —
 * conserva la norma—, así que reparte el error sin cambiar cuánto hay. Medida
 * con SNR, la dispersión no existe. Medida con el oído, sí: una banda de ruido
 * reconstruida con cuatro pulsos sueltos suena a pájaros metálicos, y la misma
 * banda reconstruida densa suena a ruido, que es lo que era.
 *
 * La segunda medida no es una diferencia: es una **comparación de dos
 * representaciones internas**. Se calcula el patrón de excitación del original
 * y el de lo decodificado por separado, cada uno pasado por el oído, y se
 * comparan en el dominio comprimido de la sonoridad. Ahí mover el error dentro
 * de la banda SÍ se nota, porque cambia la forma del patrón.
 *
 * ## Qué es exactamente la segunda medida
 *
 * Un PEAQ simplificado. Del modelo de oído FFT de la ITU-R BS.1387 (PEAQ
 * versión básica) están las piezas que importan:
 *
 * 1. FFT de 2048 con ventana de Hann (salto 1024), calibrada a dB SPL.
 * 2. Ponderación de oído externo y medio.
 * 3. Agrupación en 109 bandas de **0,25 Bark**.
 * 4. Ruido interno (el umbral absoluto de audición).
 * 5. Dispersión frecuencial de dos pendientes, la de agudos dependiente del
 *    nivel, normalizada para conservar energía.
 * 6. Suavizado temporal hacia delante (enmascaramiento posterior).
 * 7. Compresión de sonoridad `E^0,23`.
 *
 * Y de ahí salen **dos términos de error**, no uno:
 *
 * **Sonoridad.** La distancia entre los dos patrones comprimidos, celda a
 * celda. Ve un nivel de banda equivocado, un agujero espectral, ruido metido
 * donde no hay nada que lo tape, y bits gastados donde no se oyen.
 *
 * **Carácter.** El primer término no basta, y esto se puede medir: dentro de
 * una banda crítica el oído **no resuelve qué bins están sonando** —no tiene
 * resolución para eso, y el patrón de excitación de un modelo honesto tampoco—
 * pero sí distingue perfectamente **si aquello suena a ruido o a tonos**. Es la
 * asimetría del enmascaramiento, medida desde Zwicker: un tono metido en ruido
 * necesita mucho más margen para taparse que ruido metido en ruido.
 *
 * Y ése es exactamente el defecto de un PVQ sin dispersión. Medido sobre las
 * salidas reales del encoder con ruido rosa a 64 kbps, la planitud espectral de
 * la banda de 15,6–20 kHz sale **0,56 en el original, 0,25 sin dispersión y
 * 0,39 con la constante de siempre**: la banda de ruido vuelve convertida en
 * silbidos. Ni la SNR ni la sonoridad lo ven, porque la energía de la banda es
 * la misma; el oído sí.
 *
 * Así que la planitud espectral (media geométrica partido media aritmética de
 * las potencias de los bins: 1 es ruido, 0 es un tono) entra como segunda
 * dimensión de la representación interna, por bandas de 1 Bark, y su
 * diferencia cuenta como error **pesada por la sonoridad de esa banda**: si una
 * banda cambia de carácter por completo, cuenta como si su contenido entero
 * estuviera mal. Esa es toda la convención, y no hay más constantes que ajustar.
 *
 * Lo que NO es: no es BS.1387 conforme (falta la mitad de los MOV, la red
 * neuronal y la calibración de nivel de reproducción), no da un ODG, y **es
 * ciega a la fase** — compara magnitudes. Por eso la SNR no se quita: la SNR es
 * la que cazaría una catástrofe de fase o un desalineado, y ésta la que ve el
 * reparto perceptual. Se leen juntas o no se leen.
 *
 * ---
 * El modelo de oído sigue a ITU-R BS.1387-1 (PEAQ), «Method for objective
 * measurements of perceived audio quality», en su versión básica.
 */

import { Fft } from '../../packages/engine/src/dsp/fft';

// ── La medida de forma de onda ──────────────────────────────────────────────

/**
 * Relación señal/ruido en dB, alineando retardo y ganancia óptima.
 *
 * La ganancia se ajusta a propósito: un códec puede salir un pelo más alto o
 * más bajo y eso no es ruido, es un factor de escala. Sin quitarlo, la medida
 * castigaría algo que no se oye.
 */
export function snrDb(
  original: Float64Array,
  decodificado: Float64Array,
  maxLag: number,
): number {
  let mejor = -Infinity;
  const n = Math.min(original.length, decodificado.length) - maxLag;
  if (n <= 0) return NaN;
  for (let lag = 0; lag <= maxLag; lag++) {
    let ab = 0;
    let bb = 0;
    for (let i = 0; i < n; i++) {
      const b = decodificado[i + lag]!;
      ab += original[i]! * b;
      bb += b * b;
    }
    if (bb <= 0) continue;
    const g = ab / bb;
    let senal = 0;
    let error = 0;
    for (let i = 0; i < n; i++) {
      const a = original[i]!;
      const d = a - g * decodificado[i + lag]!;
      senal += a * a;
      error += d * d;
    }
    const db = 10 * Math.log10(senal / (error + 1e-30));
    if (db > mejor) mejor = db;
  }
  return mejor;
}

/** Retardo y ganancia que mejor casan `prueba` con `referencia`. */
export function alinear(
  referencia: Float64Array,
  prueba: Float64Array,
  maxLag: number,
): { lag: number; ganancia: number; correlacion: number } {
  const n = Math.min(referencia.length, prueba.length) - maxLag;
  let mejor = { lag: 0, ganancia: 1, correlacion: -2 };
  if (n <= 0) return mejor;
  for (let lag = 0; lag <= maxLag; lag++) {
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = 0; i < n; i++) {
      const a = referencia[i]!;
      const b = prueba[i + lag]!;
      ab += a * b;
      aa += a * a;
      bb += b * b;
    }
    const correlacion = ab / Math.sqrt(aa * bb + 1e-30);
    if (correlacion > mejor.correlacion) {
      mejor = { lag, ganancia: bb > 0 ? ab / bb : 1, correlacion };
    }
  }
  return mejor;
}

// ── El modelo de oído ───────────────────────────────────────────────────────

/** Tamaño de la FFT del modelo: 2048 a 48 kHz son 42,7 ms y 23,4 Hz por bin. */
const NFFT = 2048;
/** Salto entre tramas de análisis: medio solape. */
const HOP = 1024;
/** Resolución en Bark. 0,25 es la de PEAQ: por debajo de la banda crítica. */
const DZ = 0.25;
const F_MIN = 80;
const F_MAX = 18000;
/** Exponente de compresión de la sonoridad (Zwicker; PEAQ usa el mismo). */
const P_SONORIDAD = 0.23;
/** Pendiente de la dispersión hacia graves, en dB/Bark. Fija. */
const PENDIENTE_GRAVE = 27;
/** Constantes de tiempo del suavizado hacia delante, en segundos. */
const TAU_MIN = 0.008;
const TAU_100 = 0.030;
/** Nivel de reproducción: fondo de escala = 92 dB SPL. */
const SPL_FONDO_ESCALA = 92;
/**
 * Bins mínimos para estimar la planitud de una banda.
 *
 * La planitud es un estadístico y con pocas muestras es puro ruido: con `n`
 * bins su logaritmo tiene una desviación de `sqrt(1,64/n)`. Con 16 baja a 0,32,
 * y el suavizado entre tramas la deja utilizable. Por debajo de eso no se
 * estima: son las bandas de 1 Bark por debajo de unos 2,7 kHz, donde además el
 * oído resuelve los parciales uno a uno y la pregunta «¿ruido o tonos?» tiene
 * mucho menos sentido.
 */
const BINS_MIN_PLANITUD = 16;
/** Suelo relativo de un bin al estimar la planitud: 40 dB bajo la media. */
const SUELO_PLANITUD = 1e-4;
/** Constante de tiempo con la que se promedia la planitud entre tramas. */
const TAU_CARACTER = 0.05;

/** Bark de PEAQ: `z = 7·asinh(f/650)`. */
function bark(f: number): number {
  return 7 * Math.asinh(f / 650);
}

/** La vuelta. */
function hertz(z: number): number {
  return 650 * Math.sinh(z / 7);
}

interface Banda {
  fc: number;
  /** Bins de la FFT que caen dentro, y qué fracción de cada uno. */
  bins: Int32Array;
  pesos: Float64Array;
}

/** Banda de 1 Bark: la unidad en la que se mira el carácter (ruido o tonos). */
interface BandaCaracter {
  desde: number;
  hasta: number;
  /** Ruido interno repartido por bin, como suelo del logaritmo. */
  sueloBin: number;
}

interface Oido {
  sampleRate: number;
  bandas: Banda[];
  /** Bandas de 1 Bark con bins de sobra para estimar la planitud. */
  caracter: BandaCaracter[];
  /** Para cada celda de 0,25 Bark, qué banda de carácter le toca (−1 = ninguna). */
  celdaCaracter: Int32Array;
  /** Coeficiente del promediado temporal de la planitud. */
  alfaCaracter: number;
  /** Ventana de análisis, ya con el factor de potencia de PEAQ. */
  ventana: Float64Array;
  /** Escala de la magnitud a dB SPL. */
  escala: number;
  /** Ponderación de oído externo/medio, en POTENCIA, por bin. */
  w2: Float64Array;
  /** Ruido interno por banda. */
  ruidoInterno: Float64Array;
  /** Coeficiente del suavizado temporal por banda. */
  alfa: Float64Array;
  /** Sonoridad del silencio: el suelo desde el que se mide. */
  suelo: Float64Array;
  fft: Fft;
}

const CACHE = new Map<number, Oido>();

function construirOido(sampleRate: number): Oido {
  const df = sampleRate / NFFT;
  const nBins = NFFT / 2 + 1;

  // ── Bandas de 0,25 Bark, de 80 Hz a 18 kHz ───────────────────────────────
  const z0 = bark(F_MIN);
  const zMax = bark(Math.min(F_MAX, sampleRate / 2));
  const nBandas = Math.floor((zMax - z0) / DZ);
  const bandas: Banda[] = [];
  for (let l = 0; l < nBandas; l++) {
    const fl = hertz(z0 + l * DZ);
    const fu = hertz(z0 + (l + 1) * DZ);
    const fc = hertz(z0 + (l + 0.5) * DZ);
    const bins: number[] = [];
    const pesos: number[] = [];
    const desde = Math.max(0, Math.floor(fl / df - 0.5));
    const hasta = Math.min(nBins - 1, Math.ceil(fu / df + 0.5));
    for (let k = desde; k <= hasta; k++) {
      // Fracción del bin `k` (que cubre ±df/2 alrededor de su centro) que cae
      // dentro de la banda. Así la energía de cada bin se reparte entera entre
      // las bandas que lo tocan, sin crearla ni perderla.
      const solape = Math.min(fu, (k + 0.5) * df) - Math.max(fl, (k - 0.5) * df);
      if (solape > 0) {
        bins.push(k);
        pesos.push(solape / df);
      }
    }
    bandas.push({ fc, bins: Int32Array.from(bins), pesos: Float64Array.from(pesos) });
  }

  // ── Ventana ──────────────────────────────────────────────────────────────
  // El `sqrt(8/3)` es el de PEAQ: compensa la potencia que se lleva la ventana,
  // para que un ruido salga con su nivel de verdad y no 4,3 dB por debajo.
  const ventana = new Float64Array(NFFT);
  const compensacion = Math.sqrt(8 / 3);
  for (let n = 0; n < NFFT; n++) {
    ventana[n] = compensacion * 0.5 * (1 - Math.cos((2 * Math.PI * n) / (NFFT - 1)));
  }
  // Un seno a fondo de escala da |X| = compensación·N/4 en su bin.
  const escala = 10 ** (SPL_FONDO_ESCALA / 20) / ((compensacion * NFFT) / 4);

  // ── Oído externo y medio ─────────────────────────────────────────────────
  const w2 = new Float64Array(nBins);
  for (let k = 0; k < nBins; k++) {
    const f = Math.max(k * df, 1) / 1000;
    const dB =
      -0.6 * 3.64 * f ** -0.8 +
      6.5 * Math.exp(-0.6 * (f - 3.3) ** 2) -
      1e-3 * f ** 3.6;
    const w = 10 ** (dB / 20);
    w2[k] = w * w;
  }

  // ── Ruido interno y constantes de tiempo ─────────────────────────────────
  const ruidoInterno = new Float64Array(nBandas);
  const alfa = new Float64Array(nBandas);
  const saltoS = HOP / sampleRate;
  for (let l = 0; l < nBandas; l++) {
    const fc = bandas[l]!.fc;
    ruidoInterno[l] = 10 ** (0.4 * 0.364 * (fc / 1000) ** -0.8);
    const tau = Math.min(TAU_100, TAU_MIN + (100 / fc) * (TAU_100 - TAU_MIN));
    alfa[l] = Math.exp(-saltoS / tau);
  }

  // ── Bandas de carácter: 1 Bark, que es la banda crítica de verdad ────────
  //
  // La planitud se estima aquí y no en las celdas de 0,25 Bark porque lo que se
  // pregunta —«¿esto suena a ruido o a tonos?»— es una propiedad de la banda
  // crítica entera; y porque una celda de 0,25 Bark no tiene bins suficientes
  // para estimar nada.
  const caracter: BandaCaracter[] = [];
  const celdaCaracter = new Int32Array(nBandas).fill(-1);
  const porBark = Math.round(1 / DZ);
  for (let l = 0; l + porBark <= nBandas; l += porBark) {
    const fl = hertz(z0 + l * DZ);
    const fu = hertz(z0 + (l + porBark) * DZ);
    const desde = Math.max(1, Math.round(fl / df));
    const hasta = Math.min(nBins - 1, Math.round(fu / df));
    if (hasta - desde < BINS_MIN_PLANITUD) continue;
    // El ruido interno de la banda, repartido entre sus bins.
    let ruido = 0;
    for (let c = l; c < l + porBark; c++) ruido += ruidoInterno[c]!;
    const indice = caracter.length;
    caracter.push({ desde, hasta, sueloBin: ruido / (hasta - desde) });
    for (let c = l; c < l + porBark; c++) celdaCaracter[c] = indice;
  }

  const oido: Oido = {
    sampleRate,
    bandas,
    caracter,
    celdaCaracter,
    alfaCaracter: Math.exp(-HOP / sampleRate / TAU_CARACTER),
    ventana,
    escala,
    w2,
    ruidoInterno,
    alfa,
    suelo: new Float64Array(nBandas),
    fft: new Fft(NFFT),
  };

  // El suelo: la excitación que produce el SILENCIO, que no es cero sino el
  // ruido interno ya disperso. Restarlo es lo que hace que una trama muda no
  // aporte ni al numerador ni al denominador.
  const sueloExc = new Float64Array(nBandas);
  dispersar(ruidoInterno, sueloExc, oido);
  for (let l = 0; l < nBandas; l++) oido.suelo[l] = sueloExc[l]! ** P_SONORIDAD;

  return oido;
}

function oidoPara(sampleRate: number): Oido {
  let o = CACHE.get(sampleRate);
  if (!o) {
    o = construirOido(sampleRate);
    CACHE.set(sampleRate, o);
  }
  return o;
}

/**
 * Dispersión frecuencial: el enmascaramiento de cada banda sobre sus vecinas.
 *
 * Dos pendientes, como en el modelo clásico: hacia graves cae rápido y fijo (27
 * dB/Bark), hacia agudos cae más despacio y **según el nivel** — cuanto más
 * fuerte es el enmascarador, más se extiende hacia arriba, que es la asimetría
 * que hace que un grave fuerte tape los medios y no al revés.
 *
 * Como las bandas están equiespaciadas en Bark, la atenuación de cada paso es
 * una constante por banda origen: se recorre multiplicando, sin una sola
 * exponencial dentro del bucle.
 *
 * Se normaliza a suma 1 para que la dispersión **conserve la energía total**.
 * Sin eso, un pico repartido a los lados sin perder el suyo inventaría
 * sonoridad, y un patrón plano saldría más alto de lo que entró.
 */
function dispersar(entrada: Float64Array, salida: Float64Array, o: Oido): void {
  const n = o.bandas.length;
  salida.fill(0);
  const a = new Float64Array(n);
  const LN10_10 = Math.LN10 / 10;
  const baseGrave = Math.exp(-PENDIENTE_GRAVE * DZ * LN10_10);
  for (let j = 0; j < n; j++) {
    const pj = entrada[j]!;
    if (pj <= 0) continue;
    const nivelDb = 10 * Math.log10(pj);
    let pendienteAguda = 24 + 230 / o.bandas[j]!.fc - 0.2 * nivelDb;
    if (pendienteAguda < 5) pendienteAguda = 5;
    const baseAgudo = Math.exp(-pendienteAguda * DZ * LN10_10);

    let suma = 0;
    let v = 1;
    for (let l = j; l < n; l++) {
      a[l] = v;
      suma += v;
      v *= baseAgudo;
    }
    v = baseGrave;
    for (let l = j - 1; l >= 0; l--) {
      a[l] = v;
      suma += v;
      v *= baseGrave;
    }
    const g = pj / suma;
    for (let l = 0; l < n; l++) salida[l] = salida[l]! + a[l]! * g;
  }
}

/**
 * Una trama: FFT, ponderación del oído, y de ahí las dos cosas que hacen falta.
 *
 * `porBin` sale con la potencia ponderada bin a bin —la estructura fina, que es
 * de donde se saca el carácter— y `porBanda` con esa misma potencia ya agrupada
 * en las celdas de 0,25 Bark.
 */
function espectroBandas(
  x: Float64Array,
  desde: number,
  o: Oido,
  re: Float32Array,
  im: Float32Array,
  porBin: Float64Array,
  porBanda: Float64Array,
): void {
  const v = o.ventana;
  for (let n = 0; n < NFFT; n++) {
    re[n] = (x[desde + n] ?? 0) * v[n]!;
    im[n] = 0;
  }
  o.fft.forward(re, im);
  const e2 = o.escala * o.escala;
  for (let k = 0; k < porBin.length; k++) {
    const r = re[k]!;
    const m = im[k]!;
    porBin[k] = (r * r + m * m) * e2 * o.w2[k]!;
  }
  const bandas = o.bandas;
  for (let l = 0; l < bandas.length; l++) {
    const { bins, pesos } = bandas[l]!;
    let suma = 0;
    for (let i = 0; i < bins.length; i++) suma += porBin[bins[i]!]! * pesos[i]!;
    porBanda[l] = suma;
  }
}

/**
 * Planitud espectral de cada banda de carácter: media geométrica partido media
 * aritmética de las potencias de sus bins. Vale 1 para ruido blanco y tiende a
 * 0 para un tono puro.
 *
 * Se devuelve el LOGARITMO porque es lo que luego se promedia entre tramas: la
 * media geométrica es la que tiene sentido para un cociente de medias, y además
 * el estadístico es aproximadamente normal en log.
 *
 * Los bins se limitan por abajo antes del logaritmo, y por dos motivos que van
 * en la misma dirección: `log(0)` no existe —y una reconstrucción sin
 * dispersión tiene ceros exactos—, y un hueco de 60 dB dentro de una banda
 * crítica no se oye como un hueco de 60 dB, porque las faldas del filtro
 * auditivo lo rellenan. El suelo es el mayor entre el ruido interno de la banda
 * y 40 dB por debajo de su media.
 */
function planitudLog(porBin: Float64Array, o: Oido, salida: Float64Array): void {
  for (let b = 0; b < o.caracter.length; b++) {
    const { desde, hasta, sueloBin } = o.caracter[b]!;
    const n = hasta - desde;
    let media = 0;
    for (let k = desde; k < hasta; k++) media += porBin[k]!;
    media /= n;
    const suelo = Math.max(sueloBin, media * SUELO_PLANITUD);
    // El suelo se aplica a las DOS medias, y eso no es un detalle: si sólo se
    // limitara la geométrica, una banda entera por debajo del ruido interno
    // daría un cociente mayor que uno —y por el logaritmo, un número
    // astronómico— en vez de la planitud 1 que le corresponde al silencio.
    let logs = 0;
    let suma = 0;
    for (let k = desde; k < hasta; k++) {
      const v = porBin[k]!;
      const w = v > suelo ? v : suelo;
      logs += Math.log(w);
      suma += w;
    }
    salida[b] = logs / n - Math.log(suma / n);
  }
}

/**
 * Relación patrón/distorsión en dB: la medida perceptual.
 *
 * Mismo sentido que la SNR —**más alto es mejor**— pero lo que hay arriba y
 * abajo de la fracción no es energía de señal y de error, sino **sonoridad**:
 *
 * ```
 *   arriba = Σ (sonoridad del original por encima del silencio)²
 *   abajo  = Σ (error de sonoridad)² + Σ (error de carácter)²
 * ```
 *
 * La diferencia con la SNR está en que los dos patrones se calculan **por
 * separado** y se restan DESPUÉS de pasar por el oído. Restar antes (que es lo
 * que hace la SNR) borra todo lo que sea reparto: la energía de una diferencia
 * no depende de en qué bins esté. Restar después, no.
 *
 * El error de carácter es la diferencia de planitud de la banda de 1 Bark,
 * pesada por la sonoridad del original en esa celda: una banda que pasa de
 * ruido a tonos cuenta como si su contenido entero estuviera mal, que es lo que
 * pasa cuando el PVQ devuelve cuatro silbidos donde había aire.
 *
 * `maxLag` es la ventana en la que se busca el retardo del códec; la ganancia
 * global se compensa, igual que en la SNR, porque un cambio de volumen no es un
 * defecto.
 */
export function patronDb(
  referencia: Float64Array,
  prueba: Float64Array,
  sampleRate = 48000,
  maxLag = 1600,
): number {
  const o = oidoPara(sampleRate);
  const nb = o.bandas.length;
  const nc = o.caracter.length;
  const nBins = NFFT / 2 + 1;
  const { lag, ganancia } = alinear(referencia, prueba, maxLag);
  const n = Math.min(referencia.length, prueba.length - lag);
  if (n < NFFT) return NaN;

  const alineada = new Float64Array(n);
  for (let i = 0; i < n; i++) alineada[i] = ganancia * prueba[i + lag]!;

  const re = new Float32Array(NFFT);
  const im = new Float32Array(NFFT);
  const binRef = new Float64Array(nBins);
  const binPru = new Float64Array(nBins);
  const pRef = new Float64Array(nb);
  const pPru = new Float64Array(nb);
  const eRef = new Float64Array(nb);
  const ePru = new Float64Array(nb);
  const sRef = new Float64Array(nb);
  const sPru = new Float64Array(nb);
  const planRef = new Float64Array(nc);
  const planPru = new Float64Array(nc);
  const medRef = new Float64Array(nc);
  const medPru = new Float64Array(nc);

  let arriba = 0;
  let abajo = 0;
  let primera = true;

  for (let desde = 0; desde + NFFT <= n; desde += HOP) {
    espectroBandas(referencia, desde, o, re, im, binRef, pRef);
    espectroBandas(alineada, desde, o, re, im, binPru, pPru);

    // ── Carácter: la planitud, promediada entre tramas ────────────────────
    //
    // El promediado no es cosmético. La planitud de una trama suelta es un
    // estadístico ruidoso, y su ruido entraría entero en el denominador como
    // error que no existe. Y además el oído tampoco juzga el carácter de una
    // banda en 40 ms: lo integra.
    planitudLog(binRef, o, planRef);
    planitudLog(binPru, o, planPru);
    const ac = o.alfaCaracter;
    for (let b = 0; b < nc; b++) {
      if (primera) {
        medRef[b] = planRef[b]!;
        medPru[b] = planPru[b]!;
      } else {
        medRef[b] = ac * medRef[b]! + (1 - ac) * planRef[b]!;
        medPru[b] = ac * medPru[b]! + (1 - ac) * planPru[b]!;
      }
    }

    // ── Sonoridad ─────────────────────────────────────────────────────────
    // El ruido interno entra ANTES de dispersar: es una fuente más, no un
    // suelo que se aplica al final.
    for (let l = 0; l < nb; l++) {
      pRef[l] = pRef[l]! + o.ruidoInterno[l]!;
      pPru[l] = pPru[l]! + o.ruidoInterno[l]!;
    }
    dispersar(pRef, eRef, o);
    dispersar(pPru, ePru, o);

    // Suavizado hacia delante: lo que acaba de sonar sigue tapando un rato.
    for (let l = 0; l < nb; l++) {
      const a = o.alfa[l]!;
      if (primera) {
        sRef[l] = eRef[l]!;
        sPru[l] = ePru[l]!;
      } else {
        sRef[l] = Math.max(a * sRef[l]! + (1 - a) * eRef[l]!, eRef[l]!);
        sPru[l] = Math.max(a * sPru[l]! + (1 - a) * ePru[l]!, ePru[l]!);
      }
    }
    primera = false;

    for (let l = 0; l < nb; l++) {
      const suelo = o.suelo[l]!;
      const lr = sRef[l]! ** P_SONORIDAD - suelo;
      const lp = sPru[l]! ** P_SONORIDAD - suelo;
      const audible = lr > 0 ? lr : 0;
      const dSonoridad = lr - lp;
      arriba += audible * audible;
      abajo += dSonoridad * dSonoridad;

      const b = o.celdaCaracter[l]!;
      if (b >= 0) {
        // Planitud de 0 a 1 por los dos lados; su diferencia, pesada por lo
        // que se oye de esa celda, es el error de carácter.
        const dCaracter = audible * (Math.exp(medPru[b]!) - Math.exp(medRef[b]!));
        abajo += dCaracter * dCaracter;
      }
    }
  }

  if (abajo <= 0) return Infinity;
  return 10 * Math.log10(arriba / abajo);
}
