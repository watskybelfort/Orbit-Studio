/**
 * Medir el retardo de ida y vuelta salida→entrada, en muestras, sin Web Audio
 * delante: el chirp que se manda por los altavoces, la correlación contra lo
 * que vuelve por el micro, y el veredicto de si el resultado es de fiar.
 *
 * Por qué un chirp y no un simple clic: un impulso de una muestra tiene toda
 * su energía en un instante y cualquier micro barato, altavoz con roll-off o
 * ruido de sala lo entierra. Un barrido de frecuencia reparte la misma
 * energía en el tiempo —se oye, y sobrevive al ruido— y sigue teniendo una
 * forma tan particular que correlacionarlo contra ruido de fondo da un pico
 * limpio y contra silencio no da nada.
 *
 * Todo esto es puro (sin AudioContext, sin `Date.now`) para poder probarlo
 * con una señal sintética y un retardo inyectado a mano, igual que
 * `version-compare.ts` o `midi-message.ts`.
 */

// ── El chirp ─────────────────────────────────────────────────────────────

export interface ChirpOptions {
  sampleRate: number;
  /** Duración del barrido. Corto: menos coste de correlación después. */
  durationMs?: number;
  /** Frecuencia de arranque. */
  startHz?: number;
  /** Frecuencia de llegada. */
  endHz?: number;
  /** Amplitud de pico (antes de la ventana). */
  amplitude?: number;
}

export const DEFAULT_CHIRP_MS = 50;
/**
 * 500–6000 Hz: banda que sobrevive al altavoz y al micro más mediocres (por
 * debajo se come el roll-off de graves de un altavoz de portátil, por arriba
 * el de agudos de un micro barato) y sigue siendo audible — el usuario tiene
 * que poder oír que algo sonó, para saber que el bucle se está probando.
 */
export const DEFAULT_CHIRP_START_HZ = 500;
export const DEFAULT_CHIRP_END_HZ = 6000;
export const DEFAULT_CHIRP_AMPLITUDE = 0.85;

/**
 * Barrido lineal de frecuencia (chirp) con ventana Hann completa: sin eso el
 * arranque y el final serían un escalón —un clic de banda ancha que se suma
 * a la propia señal y ensucia la correlación en vez de ayudarla.
 */
export function generateChirp(opts: ChirpOptions): Float32Array {
  const sampleRate = opts.sampleRate;
  const durationMs = opts.durationMs ?? DEFAULT_CHIRP_MS;
  const f0 = opts.startHz ?? DEFAULT_CHIRP_START_HZ;
  const f1 = opts.endHz ?? DEFAULT_CHIRP_END_HZ;
  const amplitude = opts.amplitude ?? DEFAULT_CHIRP_AMPLITUDE;

  const n = Math.max(2, Math.round((durationMs / 1000) * sampleRate));
  const out = new Float32Array(n);
  const durationSec = n / sampleRate;
  // Hz por segundo del barrido: fase instantánea = f0*t + (k/2)*t².
  const k = (f1 - f0) / durationSec;

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + (k / 2) * t * t);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = amplitude * hann * Math.sin(phase);
  }
  return out;
}

// ── La correlación ──────────────────────────────────────────────────────

export interface DelayEstimateOptions {
  sampleRate: number;
  /**
   * RMS lineal por debajo del cual la captura entera se trata como "no llegó
   * nada" (auriculares puestos, micro sin ganancia, cable sin conectar) y ni
   * se intenta correlacionar. ~0.001 ≈ -60 dBFS: muy por encima del ruido de
   * fondo de un ADC en silencio real, muy por debajo de un chirp que haya
   * hecho el viaje completo aunque sea flojo.
   */
  silenceRms?: number;
  /**
   * Correlación normalizada mínima (0..1) para aceptar el pico como el eco
   * de verdad. Ruido sin relación con el chirp cae por debajo de ~0.2–0.3;
   * un eco acústico limpio, aunque con reverberación de sala, suele pasar de
   * 0.6. 0.5 deja margen a los dos lados: rechaza ruido con holgura sin
   * exigir un laboratorio anecoico.
   */
  minPeak?: number;
  /**
   * Cuánto tiene que ganarle el mejor pico al segundo mejor candidato (fuera
   * de la zona de exclusión alrededor del primero). Un pico bueno pero con
   * un rival casi tan alto —eco múltiple, señal periódica, doble reflexión—
   * es una medida ambigua: mejor rechazarla que jugársela por el más alto.
   */
  minMargin?: number;
}

export const DEFAULT_SILENCE_RMS = 0.001;
export const DEFAULT_MIN_PEAK = 0.5;
export const DEFAULT_MIN_MARGIN = 0.15;

export interface DelayFound {
  ok: true;
  delaySamples: number;
  delayMs: number;
  /** Correlación normalizada del pico ganador (0..1). */
  confidence: number;
}

export interface DelayRejected {
  ok: false;
  reason: 'too-short' | 'silence' | 'weak-correlation';
  /** 0 para 'too-short'/'silence' (ni se llegó a correlacionar). */
  confidence: number;
}

export type DelayResult = DelayFound | DelayRejected;

/**
 * Busca `probe` dentro de `captured` por correlación cruzada normalizada
 * (matched filter) y devuelve el desfase en muestras del mejor candidato, o
 * por qué se rechaza.
 *
 * Un retardo mal medido es peor que ninguno —mueve todas las tomas en la
 * dirección equivocada—, así que esto rechaza ANTES de devolver un número:
 * primero un chequeo de silencio barato (evita además dividir por una
 * energía local ~0, que daría una confianza falsa), y sobre lo que
 * correlaciona bien, un margen sobre el segundo mejor candidato.
 *
 * Coste: O(len(probe) · len(captured)). No es código de audio thread —corre
 * una vez, a petición del usuario, con buffers acotados por quien llama— así
 * que no hace falta FFT ni ventanas gruesas-a-finas para que esto sea
 * razonable (con los tamaños por defecto de `latency-calibration.ts`, unos
 * cientos de ms en el hilo de UI).
 */
export function estimateDelaySamples(
  probe: Float32Array,
  captured: Float32Array,
  options: DelayEstimateOptions,
): DelayResult {
  const sampleRate = options.sampleRate;
  const silenceRms = options.silenceRms ?? DEFAULT_SILENCE_RMS;
  const minPeak = options.minPeak ?? DEFAULT_MIN_PEAK;
  const minMargin = options.minMargin ?? DEFAULT_MIN_MARGIN;

  if (probe.length === 0 || captured.length <= probe.length) {
    return { ok: false, reason: 'too-short', confidence: 0 };
  }

  // Chequeo de silencio GLOBAL, antes que nada: barato, y evita que una
  // captura entera sin señal (auriculares, micro cerrado) llegue siquiera a
  // la correlación normalizada, donde dividir por una energía ~0 podría
  // devolver un valor alto por pura casualidad numérica.
  let sumSq = 0;
  for (let i = 0; i < captured.length; i++) {
    const s = captured[i]!;
    sumSq += s * s;
  }
  const meanEnergy = sumSq / captured.length; // energía media por muestra
  const rms = Math.sqrt(meanEnergy);
  if (rms < silenceRms) {
    return { ok: false, reason: 'silence', confidence: 0 };
  }

  let probeEnergy = 0;
  for (let i = 0; i < probe.length; i++) probeEnergy += probe[i]! * probe[i]!;

  // Piso de energía LOCAL: sin esto, un tramo casi silencioso dentro de una
  // captura que en conjunto no es silenciosa (el hueco antes de que llegue
  // el eco, por ejemplo) podría dar una correlación normalizada alta por la
  // misma razón —dividir por una energía local ~0—, esta vez sin que el
  // chequeo global lo pille. Un candidato con menos de un 5% de la energía
  // media de una ventana del tamaño del chirp no se considera de fiar.
  const energyFloor = Math.max(meanEnergy * probe.length * 0.05, 1e-12);

  const maxLag = captured.length - probe.length;
  const values = new Float32Array(maxLag + 1);
  let bestLag = 0;
  let bestValue = 0;

  for (let lag = 0; lag <= maxLag; lag++) {
    let dot = 0;
    let energy = 0;
    for (let i = 0; i < probe.length; i++) {
      const c = captured[lag + i]!;
      dot += probe[i]! * c;
      energy += c * c;
    }
    // Valor absoluto: algunos aparatos invierten la fase en el camino (o el
    // propio driver del micro), y eso no debería contar como "no hay eco" —
    // el retardo es el mismo esté la onda derecha o del revés.
    const value = energy > energyFloor ? Math.abs(dot) / Math.sqrt(probeEnergy * energy) : 0;
    values[lag] = value;
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }

  // Segundo mejor candidato, fuera de una zona de exclusión de medio chirp
  // alrededor del ganador (la propia forma del pico no cuenta como "otro
  // candidato").
  const exclude = Math.max(1, Math.round(probe.length / 2));
  let secondBest = 0;
  for (let lag = 0; lag <= maxLag; lag++) {
    if (Math.abs(lag - bestLag) < exclude) continue;
    const v = values[lag]!;
    if (v > secondBest) secondBest = v;
  }

  if (bestValue < minPeak || bestValue - secondBest < minMargin) {
    return { ok: false, reason: 'weak-correlation', confidence: bestValue };
  }

  return {
    ok: true,
    delaySamples: bestLag,
    delayMs: samplesToMs(bestLag, sampleRate),
    confidence: bestValue,
  };
}

// ── Conversiones triviales, compartidas para no repetir la cuenta ─────────

export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

// ── Dónde cae el clip ───────────────────────────────────────────────────
//
// Lo que `recorder.ts` aplica al colocar cada toma, separado aquí para poder
// probarlo sin Electron, sin el motor y sin el store delante: dado el
// retardo medido (en muestras, al sample rate de la calibración) y el tempo
// del proyecto, cuántos BEATS hay que correr el clip hacia atrás.

/** El retardo medido, en beats, al tempo dado. 0 si no hay nada que compensar. */
export function latencyBeats(delaySamples: number, sampleRate: number, tempoBpm: number): number {
  if (delaySamples <= 0 || sampleRate <= 0) return 0;
  return (delaySamples / sampleRate) * (tempoBpm / 60);
}

/**
 * Dónde nace el clip: el beat donde arrancó la toma, corrido hacia atrás lo
 * que tarda el bucle salida→entrada de este aparato. Nunca antes del
 * compás 1 — si la toma empezó pegada al principio de la canción, el clip se
 * recorta a 0 en vez de nacer con un `start` negativo.
 */
export function compensateClipStart(
  startBeat: number,
  delaySamples: number,
  sampleRate: number,
  tempoBpm: number,
): number {
  return Math.max(0, startBeat - latencyBeats(delaySamples, sampleRate, tempoBpm));
}
