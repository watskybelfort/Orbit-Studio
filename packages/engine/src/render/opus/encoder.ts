/**
 * Encoder Opus completo: de PCM a un archivo `.opus`.
 *
 * Pone el byte TOC delante de cada trama CELT y las empaqueta en Ogg. El TOC es
 * lo único que Opus añade por encima de CELT, y es un solo byte:
 *
 * ```
 *   ccccc s ff     ccccc = configuración (modo, ancho de banda, duración)
 *                  s     = estéreo
 *                  ff    = cuántas tramas van en el paquete
 * ```
 *
 * Aquí se usa siempre **CELT puro, banda completa, una trama por paquete**, que
 * son las configuraciones 28 a 31. Ni SILK ni híbrido: son otro códec entero
 * dentro del mismo formato, y para música CELT es el que toca.
 *
 * ## El pre-skip no es opcional
 *
 * La primera trama sale de una MDCT que sólo tiene medio bloque de datos reales,
 * así que sus primeras muestras son transitorio de arranque. El contenedor
 * declara cuántas hay que tirar; si no se declararan, el tema empezaría con un
 * chasquido y duraría de más.
 */

import { celtEncodeFrame, createCeltEncoder, OVERLAP, type CeltEncoderState } from './celt-encoder';
import type { SpreadMode } from './spread';
import type { TransientMode } from './transient';
import { encodeOggOpus, type OpusPacket } from '../ogg-opus';

/** Configuraciones de CELT en banda completa, por duración de trama. */
const CELT_FULLBAND_CONFIG: Record<number, number> = {
  120: 28, // 2,5 ms
  240: 29, // 5 ms
  480: 30, // 10 ms
  960: 31, // 20 ms
};

/**
 * Muestras que el decodificador debe descartar al principio.
 *
 * Es el solape de la ventana: hasta que no ha entrado una trama entera, la MDCT
 * no tiene con qué solapar y lo que sale de ahí es arranque, no señal.
 */
export const PRE_SKIP = OVERLAP;

/** Byte TOC: qué hay dentro del paquete. */
export function tocByte(frameSize: number, channels: number): number {
  const config = CELT_FULLBAND_CONFIG[frameSize];
  if (config === undefined) throw new Error(`tamaño de trama no válido: ${frameSize}`);
  // Los dos bits bajos a cero: una sola trama por paquete.
  return (config << 3) | ((channels === 2 ? 1 : 0) << 2);
}

export interface EncodeOptions {
  channels: number;
  /** 120, 240, 480 o 960 muestras por canal. */
  frameSize?: number;
  /** Bitrate objetivo en bits por segundo. */
  bitrate?: number;
  vendor?: string;
  tags?: Record<string, string>;
  /**
   * Qué hace el codificador con la dispersión del PVQ.
   *
   * Por defecto `'adaptive'`: se decide por trama según la planitud de cada
   * banda. `'normal'` fija la constante de siempre y `'none'` la apaga; las dos
   * existen para que el banco de calidad pueda medir una contra otra, que es la
   * única forma de decidir esto.
   */
  spread?: SpreadMode;
  /**
   * Qué hace el codificador con los transitorios.
   *
   * Por defecto `'adaptive'`: se detecta el ataque por trama y, si lo hay, la
   * trama va en sub-tramas cortas de 2,5 ms para que el ruido de cuantización
   * no se derrame hacia atrás (pre-eco). `'tf'` deja sólo la decisión de
   * resolución por banda y `'off'` vuelve a bloques largos siempre; las dos
   * existen para que el banco pueda medir una contra otra.
   */
  transient?: TransientMode;
}

/** Bytes por trama para un bitrate dado, con los topes del formato. */
function bytesPerFrame(bitrate: number, frameSize: number): number {
  const bytes = Math.round((bitrate * frameSize) / 48000 / 8);
  // El formato admite hasta 1275 bytes por trama; por debajo de 2 no cabe ni la
  // cabecera del range coder.
  return Math.max(2, Math.min(1275, bytes));
}

/**
 * Codifica PCM entrelazado (±1) a paquetes Opus.
 *
 * Devuelve un paquete por trama, ya con su byte TOC delante.
 */
export function encodeOpusPackets(
  pcm: Float64Array | Float32Array,
  options: EncodeOptions,
): OpusPacket[] {
  const channels = options.channels;
  const frameSize = options.frameSize ?? 960;
  const bitrate = options.bitrate ?? 96000;
  const bytes = bytesPerFrame(bitrate, frameSize);
  const toc = tocByte(frameSize, channels);

  const state: CeltEncoderState = createCeltEncoder(channels);
  const total = Math.floor(pcm.length / channels);
  const packets: OpusPacket[] = [];
  const block = new Float64Array(frameSize * channels);

  for (let start = 0; start < total; start += frameSize) {
    // La última trama se rellena con silencio hasta frameSize (Opus solo codifica
    // tamaños fijos), pero se REPORTAN solo las muestras reales: el granulado de
    // la última página suma esas y no el frame entero, y el decoder recorta el
    // relleno (RFC 7845 §4.5). Antes se reportaba frameSize siempre, así que el
    // .opus duraba hasta 20 ms de más (silencio al final).
    block.fill(0);
    const available = Math.min(frameSize, total - start);
    for (let i = 0; i < available * channels; i++) block[i] = pcm[start * channels + i]!;

    const frame = celtEncodeFrame(state, block, {
      frameSize,
      bytes: bytes - 1,
      spread: options.spread,
      transient: options.transient,
    });
    const data = new Uint8Array(frame.length + 1);
    data[0] = toc;
    data.set(frame, 1);
    packets.push({ data, samples: available });
  }
  return packets;
}

/** Codifica PCM a un archivo `.opus` completo (Ogg Opus). */
export function encodeOpusFile(
  pcm: Float64Array | Float32Array,
  options: EncodeOptions,
): Uint8Array {
  const packets = encodeOpusPackets(pcm, options);
  return encodeOggOpus(packets, {
    channels: options.channels,
    preSkip: PRE_SKIP,
    inputRate: 48000,
    vendor: options.vendor ?? 'Orbit Studio',
    tags: options.tags ?? {},
  });
}
