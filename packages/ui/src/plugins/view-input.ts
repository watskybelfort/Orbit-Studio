/**
 * Qué datos ve la vista de un plugin, y de dónde salen.
 *
 * ## Por qué esto NO toca el hilo de audio
 *
 * La tentación obvia sería que el `process()` del plugin —que corre dentro del
 * worklet— fuera publicando lo que quiere pintar. Eso es exactamente lo que no
 * se hace, por dos motivos:
 *
 * 1. La regla dura del repo: en el audio thread no se reserva memoria ni se
 *    habla con nadie. Añadirle un canal de telemetría por plugin sería meter
 *    trabajo, y sincronización, en el sitio donde un microsegundo de más es un
 *    click.
 * 2. Porque no hace falta. Lo que un plugin quiere enseñar es casi siempre una
 *    función de sus PARÁMETROS —la curva de transferencia de un compresor, la
 *    respuesta de un EQ, las repeticiones de un delay—, y los parámetros ya
 *    están en el store, en la UI, en el mismo hilo que dibuja. Y cuando lo que
 *    quiere enseñar es señal (un medidor, un espectro), esa señal ya viaja: es
 *    el mismo tap del kernel (`scopeFrame`) que alimentan el Orbit Scope, el EQ
 *    del mixer y el analizador de pista. Un consumidor más de ese tap no le
 *    cuesta nada al audio.
 *
 * Así que del audio thread al dibujo no cruza NADA nuevo. La vista se alimenta
 * de lo que la UI ya tenía delante.
 *
 * ## Y sin reservar memoria por frame
 *
 * Todo se escribe en el `Float32Array` de entrada que ya existe y que va y
 * vuelve por transferencia. Estas funciones no crean arrays ni objetos: reciben
 * el buffer y los destinos y escriben en sitio.
 *
 * Módulo puro: sin React, sin store, sin DOM. Se prueba bajo Node.
 */

import {
  FLAG_LEVEL,
  FLAG_SPECTRUM,
  IN_ASPECT,
  IN_FLAGS,
  IN_LEVEL,
  IN_NBINS,
  IN_NPARAMS,
  IN_PARAMS,
  IN_SAMPLE_RATE,
  IN_SPECTRUM,
  VIEW_MAX_PARAMS,
  VIEW_SPECTRUM_BINS,
} from './view-protocol';

/**
 * Pico y RMS de un frame del tap, escritos en `out` (índices 0 y 1).
 *
 * El tap del kernel manda mono (L+R)/2 — ver `state/scope-track.ts` — así que
 * esto es el nivel de la PISTA, no un estéreo. Se dice en la doc del SDK para
 * que nadie dibuje un medidor de dos canales creyendo que tiene dos canales.
 *
 * `out` es un Float32Array(2) preasignado por el llamante: esta función no
 * reserva nada.
 */
export function levelOfFrame(frame: Float32Array | null, out: Float32Array): void {
  if (!frame || frame.length === 0) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i]!;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
    sum += s * s;
  }
  out[0] = peak > 1 ? 1 : peak;
  const rms = Math.sqrt(sum / frame.length);
  out[1] = rms > 1 ? 1 : rms;
}

export interface ViewInputSources {
  /** alto/ancho del área de dibujo. */
  aspect: number;
  sampleRate: number;
  /** Claves de las perillas en el orden acordado con el worker. */
  paramKeys: readonly string[];
  /** Valores actuales (los del slot, ya con automatización aplicada). */
  params: Readonly<Record<string, number>>;
  /** Fallback por clave cuando el slot no trae valor (el default del spec). */
  defaults: Readonly<Record<string, number>>;
  /** [pico, rms] ya calculados, o null si la vista no pidió nivel. */
  level: Float32Array | null;
  /** Magnitudes en dB por bin, o null si la vista no pidió espectro. */
  spectrumDb: Float32Array | null;
}

/**
 * Rellena el buffer de entrada de un frame. Escribe SOLO lo que la vista pidió:
 * un plugin que no declara `needs: ['spectrum']` no hace que se copien 512
 * floats por frame ni que se calcule una FFT que nadie va a mirar.
 */
export function fillViewInput(input: Float32Array, src: ViewInputSources): void {
  input[IN_ASPECT] = Number.isFinite(src.aspect) && src.aspect > 0 ? src.aspect : 1;
  input[IN_SAMPLE_RATE] = src.sampleRate;

  const n = Math.min(src.paramKeys.length, VIEW_MAX_PARAMS);
  input[IN_NPARAMS] = n;
  for (let i = 0; i < n; i++) {
    const key = src.paramKeys[i]!;
    const v = src.params[key];
    const value = typeof v === 'number' && Number.isFinite(v) ? v : (src.defaults[key] ?? 0);
    input[IN_PARAMS + i] = value;
  }

  let flags = 0;
  if (src.level) {
    flags |= FLAG_LEVEL;
    input[IN_LEVEL] = src.level[0] ?? 0;
    input[IN_LEVEL + 1] = src.level[1] ?? 0;
  } else {
    input[IN_LEVEL] = 0;
    input[IN_LEVEL + 1] = 0;
  }

  if (src.spectrumDb && src.spectrumDb.length > 0) {
    flags |= FLAG_SPECTRUM;
    const bins = Math.min(src.spectrumDb.length, VIEW_SPECTRUM_BINS);
    input[IN_NBINS] = bins;
    if (bins === src.spectrumDb.length) {
      // Caso normal (512 bins): `set` directo, un memcpy y nada reservado.
      input.set(src.spectrumDb, IN_SPECTRUM);
    } else {
      // Solo si el analizador trajera más bins de los que caben: `subarray`
      // crea una vista (no copia los datos, pero sí reserva la cabecera), así
      // que se evita en el camino de siempre.
      input.set(src.spectrumDb.subarray(0, bins), IN_SPECTRUM);
    }
  } else {
    input[IN_NBINS] = 0;
  }
  input[IN_FLAGS] = flags;
}
