/**
 * Mapeo de Opus sobre Ogg (RFC 7845).
 *
 * El contenedor y el códec son problemas distintos, y éste es el fácil de los
 * dos: paginar, numerar y firmar con CRC. La ventaja de separarlos es que este
 * módulo **se puede validar hoy, sin tener el encoder terminado** — se le meten
 * paquetes Opus reales (los que saca ffmpeg), se pagina, y se comprueba que
 * ffmpeg vuelve a leer exactamente el mismo audio. Eso es lo que hace
 * `tools/qa/ogg-opus-verify.ts`.
 *
 * Tres cosas de este mapeo que no son obvias y que rompen el archivo si se
 * hacen a ojo:
 *
 * 1. **El granulado va SIEMPRE en muestras de 48 kHz**, aunque el audio se haya
 *    codificado a 16 o a 24. No es la frecuencia del audio: es la escala fija
 *    del formato.
 * 2. **El pre-skip no es opcional.** Todo encoder con MDCT arranca con un
 *    transitorio de relleno; el contenedor dice cuántas muestras tirar al
 *    principio, y el granulado las INCLUYE. La duración real es
 *    `granulado_final − preSkip`: quien no lo reste alarga el tema.
 * 3. **Las dos cabeceras van solas en su página.** OpusHead en la página BOS y
 *    OpusTags en la siguiente, cada una sin compañía. Meterlas juntas o
 *    pegarles audio detrás da un archivo que muchos lectores rechazan.
 */

import { OGG_FLAGS, lacing, oggCrc, writePage } from './ogg';

/** Escala de granulado del formato: fija, pase lo que pase con el audio. */
export const OPUS_GRANULE_RATE = 48000;

/**
 * Pre-skip por defecto, en muestras de 48 kHz.
 *
 * 312 es lo que usa libopus con su configuración normal, y es la cifra sensata
 * mientras el encoder propio no fije la suya: la RFC pide como mínimo 80.
 */
export const DEFAULT_PRE_SKIP = 312;

const MAX_SEGMENTS = 255;

export interface OpusPacket {
  /** El paquete Opus tal cual, con su byte TOC delante. */
  data: Uint8Array;
  /** Muestras que produce, a 48 kHz (120, 240, 480, 960, 1920, 2880…). */
  samples: number;
}

export interface OggOpusOptions {
  channels?: number;
  /** Frecuencia de la fuente. Es informativa: NO cambia el granulado. */
  inputRate?: number;
  preSkip?: number;
  /** Ganancia de salida en dB. Se guarda en Q7.8 y la aplica el decodificador. */
  gainDb?: number;
  serial?: number;
  vendor?: string;
  /** Etiquetas `NOMBRE=valor` de VorbisComment (TITLE, ARTIST, …). */
  tags?: Record<string, string>;
}

/** Cabecera de identificación: siempre la primera, siempre sola. */
export function opusHeadPacket(options: OggOpusOptions = {}): Uint8Array {
  const channels = options.channels ?? 2;
  if (channels < 1 || channels > 255) throw new Error(`canales fuera de rango: ${channels}`);
  if (channels > 2) {
    throw new Error(`la familia de canales 0 sólo admite 1 o 2 canales, no ${channels}`);
  }
  const preSkip = options.preSkip ?? DEFAULT_PRE_SKIP;
  const inputRate = options.inputRate ?? OPUS_GRANULE_RATE;
  // La ganancia va en Q7.8: 256 pasos por dB, con signo.
  const gain = Math.max(-32768, Math.min(32767, Math.round((options.gainDb ?? 0) * 256)));

  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('OpusHead'), 0);
  out[8] = 1; // versión del mapeo
  out[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, gain, true);
  // Familia 0: mono o estéreo, sin tabla de canales detrás. Es la única que no
  // arrastra más campos, y la que cubre todo lo que exporta Orbit.
  out[18] = 0;
  return out;
}

/** Cabecera de metadatos: VorbisComment con la cabecera "OpusTags" delante. */
export function opusTagsPacket(vendor: string, tags: Record<string, string> = {}): Uint8Array {
  const encoder = new TextEncoder();
  const vendorBytes = encoder.encode(vendor);
  const entries = Object.entries(tags).map(([key, value]) => encoder.encode(`${key}=${value}`));

  let size = 8 + 4 + vendorBytes.length + 4;
  for (const entry of entries) size += 4 + entry.length;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(encoder.encode('OpusTags'), 0);
  view.setUint32(8, vendorBytes.length, true);
  out.set(vendorBytes, 12);
  let at = 12 + vendorBytes.length;
  view.setUint32(at, entries.length, true);
  at += 4;
  for (const entry of entries) {
    view.setUint32(at, entry.length, true);
    at += 4;
    out.set(entry, at);
    at += entry.length;
  }
  return out;
}

/**
 * Empaqueta paquetes Opus en un archivo Ogg completo.
 *
 * El granulado de cada página es el total acumulado de muestras a 48 kHz,
 * pre-skip incluido. La última página lleva EOS.
 */
export function encodeOggOpus(
  packets: readonly OpusPacket[],
  options: OggOpusOptions = {},
): Uint8Array {
  const serial = options.serial ?? 0x0deb18;
  const vendor = options.vendor ?? 'Orbit Studio';
  const preSkip = options.preSkip ?? DEFAULT_PRE_SKIP;
  const pages: Uint8Array[] = [];
  let sequence = 0;

  const headerPage = (body: Uint8Array, flags: number): Uint8Array =>
    writePage({ segments: lacing(body.length), body, granule: 0, serial, sequence: sequence++, flags });

  // Las dos cabeceras, cada una sola en su página. Granulado 0 en ambas.
  pages.push(headerPage(opusHeadPacket(options), OGG_FLAGS.bos));
  pages.push(headerPage(opusTagsPacket(vendor, options.tags ?? {}), 0));

  let segments: number[] = [];
  const bodies: Uint8Array[] = [];
  let bodyBytes = 0;
  // El granulado arranca en preSkip: esas muestras existen en el flujo aunque
  // el decodificador las tire.
  let granule = preSkip;

  const flush = (last: boolean): void => {
    const body = new Uint8Array(bodyBytes);
    let at = 0;
    for (const part of bodies) {
      body.set(part, at);
      at += part.length;
    }
    pages.push(
      writePage({
        // Sin trozos cuando no hay nada: una página con un trozo de longitud 0
        // sería un PAQUETE Opus de cero bytes, y eso no existe. Una página con
        // cero trozos es Ogg válido y no dice nada que sea mentira.
        segments,
        body,
        granule,
        serial,
        sequence: sequence++,
        flags: last ? OGG_FLAGS.eos : 0,
      }),
    );
    segments = [];
    bodies.length = 0;
    bodyBytes = 0;
  };

  packets.forEach((packet, i) => {
    const parts = lacing(packet.data.length);
    if (parts.length > MAX_SEGMENTS) {
      throw new Error(`un paquete de ${packet.data.length} bytes no cabe en una página`);
    }
    if (segments.length + parts.length > MAX_SEGMENTS) flush(false);
    segments = segments.concat(parts);
    bodies.push(packet.data);
    bodyBytes += packet.data.length;
    granule += packet.samples;
    if (i === packets.length - 1) flush(true);
  });

  // Sin paquetes hace falta igualmente una página con EOS: un Ogg sin EOS está
  // truncado para cualquier lector. Y ahí el granulado es 0, no el pre-skip:
  // no hay nada que saltarse porque no hay nada.
  if (packets.length === 0) {
    granule = 0;
    flush(true);
  }

  let total = 0;
  for (const page of pages) total += page.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const page of pages) {
    out.set(page, at);
    at += page.length;
  }
  return out;
}

/** Muestras reales de un Ogg Opus: el granulado final menos el pre-skip. */
export function opusDuration(finalGranule: number, preSkip: number): number {
  return Math.max(0, finalGranule - preSkip);
}

// ── Lectura ──────────────────────────────────────────────────────────────────
// Existe por dos motivos: los tests comprueban lo que se escribió leyéndolo de
// vuelta (no mirando bytes a mano), y la herramienta de QA necesita sacar los
// paquetes de un Ogg de ffmpeg para volver a paginarlos con esto.

export interface OggPage {
  granule: number;
  serial: number;
  sequence: number;
  flags: number;
  /** Paquetes que TERMINAN en esta página. */
  packets: Uint8Array[];
  /** El último paquete sigue en la página siguiente. */
  incomplete: Uint8Array | null;
  crcOk: boolean;
}

export interface OggOpusInfo {
  channels: number;
  preSkip: number;
  inputRate: number;
  gainDb: number;
  vendor: string;
  tags: Record<string, string>;
  packets: Uint8Array[];
  finalGranule: number;
  pages: OggPage[];
  /** Muestras reales de audio: granulado final menos pre-skip. */
  samples: number;
}

/** Trocea un archivo Ogg en páginas, comprobando el CRC de cada una. */
export function parseOggPages(data: Uint8Array): OggPage[] {
  const pages: OggPage[] = [];
  let at = 0;
  while (at + 27 <= data.length) {
    if (data[at] !== 0x4f || data[at + 1] !== 0x67 || data[at + 2] !== 0x67 || data[at + 3] !== 0x53) {
      throw new Error(`no hay "OggS" en el byte ${at}`);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flags = data[at + 5]!;
    const granule = view.getUint32(at + 6, true) + view.getUint32(at + 10, true) * 0x100000000;
    const serial = view.getUint32(at + 14, true);
    const sequence = view.getUint32(at + 18, true);
    const storedCrc = view.getUint32(at + 22, true);
    const segmentCount = data[at + 26]!;
    const segments = data.subarray(at + 27, at + 27 + segmentCount);
    let bodyBytes = 0;
    for (const size of segments) bodyBytes += size;
    const headerSize = 27 + segmentCount;
    const pageBytes = data.subarray(at, at + headerSize + bodyBytes);

    // El CRC se calcula con su propio campo a cero, así que hay que copiarlo.
    const check = Uint8Array.from(pageBytes);
    check[22] = 0;
    check[23] = 0;
    check[24] = 0;
    check[25] = 0;
    const crcOk = oggCrc(check) === storedCrc;

    const packets: Uint8Array[] = [];
    let incomplete: Uint8Array | null = null;
    let cursor = at + headerSize;
    let start = cursor;
    for (let i = 0; i < segmentCount; i++) {
      const size = segments[i]!;
      cursor += size;
      // Un trozo de menos de 255 cierra el paquete; 255 significa "sigue".
      if (size < 255) {
        packets.push(data.subarray(start, cursor));
        start = cursor;
      } else if (i === segmentCount - 1) {
        incomplete = data.subarray(start, cursor);
      }
    }

    pages.push({ granule, serial, sequence, flags, packets, incomplete, crcOk });
    at += headerSize + bodyBytes;
  }
  return pages;
}

/** Lee un Ogg Opus entero: cabeceras, etiquetas y paquetes de audio. */
export function parseOggOpus(data: Uint8Array): OggOpusInfo {
  const pages = parseOggPages(data);
  const all: Uint8Array[] = [];
  // Un paquete puede cruzar el borde de página: lo que quedó a medias se guarda
  // aquí y se pega delante de lo primero que llegue en la página siguiente.
  let carry: Uint8Array | null = null;
  const join = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
    const out = new Uint8Array(head.length + tail.length);
    out.set(head, 0);
    out.set(tail, head.length);
    return out;
  };

  for (const page of pages) {
    for (const packet of page.packets) {
      all.push(carry ? join(carry, packet) : packet);
      carry = null;
    }
    if (page.incomplete) {
      carry = carry ? join(carry, page.incomplete) : page.incomplete;
    }
  }

  const decoder = new TextDecoder();
  const head = all[0];
  if (!head || decoder.decode(head.subarray(0, 8)) !== 'OpusHead') {
    throw new Error('el primer paquete no es OpusHead');
  }
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const channels = head[9]!;
  const preSkip = headView.getUint16(10, true);
  const inputRate = headView.getUint32(12, true);
  const gainDb = headView.getInt16(16, true) / 256;

  const tagsPacket = all[1];
  if (!tagsPacket || decoder.decode(tagsPacket.subarray(0, 8)) !== 'OpusTags') {
    throw new Error('el segundo paquete no es OpusTags');
  }
  const tagsView = new DataView(tagsPacket.buffer, tagsPacket.byteOffset, tagsPacket.byteLength);
  const vendorLength = tagsView.getUint32(8, true);
  const vendor = decoder.decode(tagsPacket.subarray(12, 12 + vendorLength));
  let at = 12 + vendorLength;
  const count = tagsView.getUint32(at, true);
  at += 4;
  const tags: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = tagsView.getUint32(at, true);
    at += 4;
    const entry = decoder.decode(tagsPacket.subarray(at, at + size));
    at += size;
    const split = entry.indexOf('=');
    if (split > 0) tags[entry.slice(0, split)] = entry.slice(split + 1);
  }

  const finalGranule = pages.length > 0 ? pages[pages.length - 1]!.granule : 0;
  return {
    channels,
    preSkip,
    inputRate,
    gainDb,
    vendor,
    tags,
    packets: all.slice(2),
    finalGranule,
    pages,
    samples: opusDuration(finalGranule, preSkip),
  };
}
