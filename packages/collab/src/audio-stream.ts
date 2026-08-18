/**
 * Streaming del master de la sesión (mensajes de tipo 3).
 *
 * En una sala cada uno renderiza lo suyo: el proyecto converge, pero lo que
 * SUENA depende de la máquina, del tema del mixer que cada cual esté tocando y
 * de si el otro tiene el limitador puesto. Esto cierra el "¿lo estás oyendo
 * igual que yo?": quien quiera puede emitir su salida final y los demás
 * escucharla, sin tocar el proyecto ni el kernel.
 *
 * El audio va crudo y en mono —Int16, a la sample rate del emisor— porque no
 * hay encoder propio todavía (el de Opus está en el horizonte, igual que para
 * el OGG) y porque en una sala de trabajo el enlace es una LAN o un VPN. Es
 * monitorización, no masterización: la referencia sigue siendo el render.
 *
 * Aquí solo vive lo que se puede probar sin sonido: el formato del mensaje y
 * el RELOJ de reproducción, que es lo que de verdad decide si esto se oye bien
 * o a trompicones.
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** Tipo de mensaje del protocolo de sala (0 sync · 1 awareness · 2 control · 3 audio). */
export const MESSAGE_AUDIO = 3;

/**
 * Tope por trozo. Con 100 ms por envío esto da margen de sobra; un mensaje
 * mayor es un cliente roto (o uno hostil intentando llenarnos la memoria).
 */
export const AUDIO_MAX_SAMPLES = 96000;

export interface AudioChunk {
  /** clientID de Yjs de quien emite. */
  from: number;
  sampleRate: number;
  /** Contador del emisor: un salto = hubo un hueco. */
  seq: number;
  /** Muestras mono. */
  samples: Int16Array;
}

export function encodeAudioChunk(chunk: AudioChunk): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AUDIO);
  encoding.writeVarUint(encoder, chunk.from);
  encoding.writeVarUint(encoder, chunk.sampleRate);
  encoding.writeVarUint(encoder, chunk.seq);
  encoding.writeVarUint8Array(
    encoder,
    new Uint8Array(chunk.samples.buffer, chunk.samples.byteOffset, chunk.samples.byteLength),
  );
  return encoding.toUint8Array(encoder);
}

/** Cuerpo de un mensaje de audio (el tipo ya se leyó). null si no cuadra. */
export function readAudioChunkBody(decoder: decoding.Decoder): AudioChunk | null {
  try {
    const from = decoding.readVarUint(decoder);
    const sampleRate = decoding.readVarUint(decoder);
    const seq = decoding.readVarUint(decoder);
    const bytes = decoding.readVarUint8Array(decoder);
    if (sampleRate < 8000 || sampleRate > 192000) return null;
    if (bytes.byteLength % 2 !== 0) return null;
    const count = bytes.byteLength / 2;
    if (count === 0 || count > AUDIO_MAX_SAMPLES) return null;
    // La vista se copia: `bytes` apunta al buffer del mensaje, que se reutiliza.
    const samples = new Int16Array(count);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true);
    return { from, sampleRate, seq, samples };
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
