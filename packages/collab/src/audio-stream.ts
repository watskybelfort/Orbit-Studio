/**
 * Streaming del master de la sesión (mensajes de tipo 3).
 *
 * En una sala cada uno renderiza lo suyo: el proyecto converge, pero lo que
 * SUENA depende de la máquina, del tema del mixer que cada cual esté tocando y
 * de si el otro tiene el limitador puesto. Esto cierra el "¿lo estás oyendo
 * igual que yo?": quien quiera puede emitir su salida final y los demás
 * escucharla, sin tocar el proyecto ni el kernel.
 *
 * El audio va en mono a la sample rate del emisor y COMPRIMIDO con el ADPCM
 * propio (4 bits por muestra, ver adpcm.ts): en v1.8 viajaba crudo y eso son
 * ~1,4 Mbit/s, que sobra para una LAN y molesta para todo lo demás. El tipo de
 * codificación viaja en el mensaje, así que un trozo sin comprimir (pcm16)
 * sigue siendo válido. Es monitorización, no masterización: la referencia
 * sigue siendo el render.
 *
 * Aquí solo vive lo que se puede probar sin sonido: el formato del mensaje y
 * el RELOJ de reproducción, que es lo que de verdad decide si esto se oye bien
 * o a trompicones.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { decodeAdpcm, encodeAdpcm } from './adpcm';

/** Tipo de mensaje del protocolo de sala (0 sync · 1 awareness · 2 control · 3 audio). */
export const MESSAGE_AUDIO = 3;

/**
 * Tope por trozo. Con 100 ms por envío esto da margen de sobra; un mensaje
 * mayor es un cliente roto (o uno hostil intentando llenarnos la memoria).
 */
export const AUDIO_MAX_SAMPLES = 96000;

/** Cómo viaja el audio: crudo o comprimido con el ADPCM propio. */
export type AudioCodec = 'pcm16' | 'adpcm';

const CODEC_PCM16 = 0;
const CODEC_ADPCM = 1;

export interface AudioChunk {
  /** clientID de Yjs de quien emite. */
  from: number;
  sampleRate: number;
  /** Contador del emisor: un salto = hubo un hueco. */
  seq: number;
  /** Muestras mono, ya descomprimidas. */
  samples: Int16Array;
  /** Con qué llegó (informativo: el contador de bytes del panel). */
  codec: AudioCodec;
  /** Bytes que ocupó en la red. */
  bytes: number;
}

export interface AudioChunkInput {
  from: number;
  sampleRate: number;
  seq: number;
  samples: Int16Array;
  /** Por defecto comprimido; 'pcm16' deja el trozo tal cual. */
  codec?: AudioCodec;
}

export function encodeAudioChunk(chunk: AudioChunkInput): Uint8Array {
  const codec: AudioCodec = chunk.codec ?? 'adpcm';
  const payload =
    codec === 'adpcm'
      ? encodeAdpcm(chunk.samples)
      : new Uint8Array(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AUDIO);
  encoding.writeVarUint(encoder, chunk.from);
  encoding.writeVarUint(encoder, chunk.sampleRate);
  encoding.writeVarUint(encoder, chunk.seq);
  encoding.writeVarUint(encoder, codec === 'adpcm' ? CODEC_ADPCM : CODEC_PCM16);
  // Las muestras van aparte del payload: con 4 bits por muestra, el número de
  // bytes no dice cuántas había (un trozo impar deja medio byte sin usar).
  encoding.writeVarUint(encoder, chunk.samples.length);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

/** Cuerpo de un mensaje de audio (el tipo ya se leyó). null si no cuadra. */
export function readAudioChunkBody(decoder: decoding.Decoder): AudioChunk | null {
  try {
    const from = decoding.readVarUint(decoder);
    const sampleRate = decoding.readVarUint(decoder);
    const seq = decoding.readVarUint(decoder);
    const codecId = decoding.readVarUint(decoder);
    const count = decoding.readVarUint(decoder);
    const payload = decoding.readVarUint8Array(decoder);
    if (sampleRate < 8000 || sampleRate > 192000) return null;
    if (count === 0 || count > AUDIO_MAX_SAMPLES) return null;
    const bytes = payload.byteLength;

    if (codecId === CODEC_ADPCM) {
      if (bytes !== Math.ceil(count / 2)) return null;
      // Se copia: `payload` apunta al buffer del mensaje, que se reutiliza.
      return {
        from,
        sampleRate,
        seq,
        samples: decodeAdpcm(payload.slice(), count),
        codec: 'adpcm',
        bytes,
      };
    }
    if (codecId === CODEC_PCM16) {
      if (bytes !== count * 2) return null;
      const samples = new Int16Array(count);
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true);
      return { from, sampleRate, seq, samples, codec: 'pcm16', bytes };
    }
    return null; // codec que no conocemos: mejor callar que reproducir ruido
  } catch {
    return null;
  }
}

/** Estéreo del kernel → mono Int16 (lo que viaja). */
export function toMonoInt16(left: Float32Array, right: Float32Array): Int16Array {
  const n = Math.min(left.length, right.length);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const mix = (left[i]! + right[i]!) * 0.5;
    const clamped = mix > 1 ? 1 : mix < -1 ? -1 : mix;
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}

/** Int16 → Float32 para meterlo en un AudioBuffer. */
export function fromInt16(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 32767;
  return out;
}

export interface ChunkPlan {
  /** Momento del AudioContext en el que suena este trozo. */
  at: number;
  /** Se ha reenganchado el reloj (primer trozo, o llegó tarde). */
  reset: boolean;
  /** Se tira: el buffer se había ido demasiado por delante. */
  dropped: boolean;
}

export interface StreamClockOptions {
  /** Colchón contra el jitter de la red, en segundos. */
  lead?: number;
  /** Si acumulamos más que esto por delante, sobra: se tira el trozo. */
  maxAhead?: number;
}

/**
 * Reloj de reproducción del stream.
 *
 * Un trozo que llega tarde no se puede programar en el pasado (sonaría
 * inmediatamente y encima del anterior): se re-engancha con colchón. Y si la
 * red viene disparada —o el emisor va más rápido que nuestro reloj— la cola
 * crecería sin fin y la escucha se iría quedando atrás: por eso hay tope.
 */
export class StreamClock {
  private next = 0;
  private readonly lead: number;
  private readonly maxAhead: number;

  constructor(options: StreamClockOptions = {}) {
    this.lead = options.lead ?? 0.15;
    this.maxAhead = options.maxAhead ?? 0.6;
  }

  /** Vuelve al estado inicial (cambiar de emisor, o parar la escucha). */
  reset(): void {
    this.next = 0;
  }

  plan(now: number, duration: number): ChunkPlan {
    if (this.next === 0 || this.next < now) {
      this.next = now + this.lead + duration;
      return { at: now + this.lead, reset: true, dropped: false };
    }
    if (this.next - now > this.maxAhead) {
      return { at: this.next, reset: false, dropped: true };
    }
    const at = this.next;
    this.next = at + duration;
    return { at, reset: false, dropped: false };
  }

  /** Cuánto audio hay programado por delante ahora mismo. */
  ahead(now: number): number {
    return this.next === 0 ? 0 : Math.max(0, this.next - now);
  }
}
