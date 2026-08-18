/**
 * Contenedor Ogg para el FLAC propio: exportar a `.ogg` sin depender de nadie.
 *
 * El OGG estaba descartado desde v0.6 con su razón: `MediaRecorder` de este
 * Electron no admite ningún contenedor Ogg y además grabaría en tiempo real.
 * La salida no era un códec nuevo — era el ENVOLTORIO. Y el envoltorio sí se
 * puede escribir: Ogg es paginado, con su tabla de trozos y su CRC, y el mapeo
 * de FLAC sobre Ogg está especificado (xiph.org/flac/ogg_mapping.html).
 *
 * Así que un `.ogg` de Orbit es Ogg FLAC: SIN PÉRDIDA, del mismo encoder que
 * ya sonaba bit-exacto contra ffmpeg, y lo abre cualquier reproductor que lea
 * Ogg FLAC. Un Opus propio sigue siendo otro proyecto: eso es un códec entero
 * (MDCT, PVQ, range coder), no un contenedor.
 *
 * Estructura que se escribe:
 *  - página 0 (BOS): el paquete de mapeo — 0x7F "FLAC", versión 1.0, cuántas
 *    cabeceras vienen detrás, y dentro el "fLaC" + STREAMINFO de siempre;
 *  - página 1: el VORBIS_COMMENT que la spec exige justo después;
 *  - a partir de ahí, un paquete por frame FLAC, con la posición de granulado
 *    (la muestra en la que acaba la página) y EOS en la última.
 */

import type { FlacStream } from './flac';

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const HEADER_CONTINUED = 0x01;
const HEADER_BOS = 0x02;
const HEADER_EOS = 0x04;
/** Trozos por página (el máximo del formato). */
const MAX_SEGMENTS = 255;

// ── CRC de Ogg ───────────────────────────────────────────────────────────────
// Polinomio 0x04c11db7 SIN reflejar y sin xor final: no es el CRC32 de zip, y
// usar aquel da un archivo que ningún reproductor abre.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  }
  return crc >>> 0;
}

/** Trozos de 255 bytes de un paquete (el último, siempre < 255). */
export function lacing(size: number): number[] {
  const out: number[] = [];
  let left = size;
  while (left >= 255) {
    out.push(255);
    left -= 255;
  }
  out.push(left); // un 0 final es obligatorio si el paquete es múltiplo de 255
  return out;
}

interface PageInput {
  segments: number[];
  body: Uint8Array;
  granule: number;
  serial: number;
  sequence: number;
  flags: number;
}

function writePage(page: PageInput): Uint8Array {
  const out = new Uint8Array(27 + page.segments.length + page.body.length);
  const view = new DataView(out.buffer);
  out.set(CAPTURE, 0);
  out[4] = 0; // versión
  out[5] = page.flags;
  // La posición de granulado es de 64 bits; -1 (todo unos) significa "esta
  // página no termina ningún paquete".
  if (page.granule < 0) {
    view.setInt32(6, -1, true);
    view.setInt32(10, -1, true);
  } else {
    view.setUint32(6, page.granule >>> 0, true);
    view.setUint32(10, Math.floor(page.granule / 0x100000000), true);
  }
  view.setUint32(14, page.serial >>> 0, true);
  view.setUint32(18, page.sequence >>> 0, true);
  view.setUint32(22, 0, true); // CRC: se calcula con este campo a cero
  out[26] = page.segments.length;
  out.set(page.segments, 27);
  out.set(page.body, 27 + page.segments.length);
  view.setUint32(22, oggCrc(out), true);
  return out;
}

/** Cabecera de mapeo de FLAC sobre Ogg (primer paquete del flujo). */
function mappingPacket(header: Uint8Array, headerPackets: number): Uint8Array {
  const out = new Uint8Array(9 + header.length);
  out[0] = 0x7f;
  out.set([0x46, 0x4c, 0x41, 0x43], 1); // "FLAC"
  out[5] = 1; // versión mayor del mapeo
  out[6] = 0; // versión menor
  out[7] = (headerPackets >> 8) & 0xff;
  out[8] = headerPackets & 0xff;
  out.set(header, 9); // "fLaC" + STREAMINFO
  // En el flujo nativo el STREAMINFO es el ÚLTIMO bloque de metadatos; aquí
  // detrás va el VORBIS_COMMENT, así que hay que quitarle esa marca (el bit
  // alto del byte que abre el bloque) o el decodificador se planta.
  out[13] = out[13]! & 0x7f;
  return out;
}

/** VORBIS_COMMENT mínimo: la spec lo pide justo detrás del mapeo. */
function commentPacket(vendor: string): Uint8Array {
  const bytes = new TextEncoder().encode(vendor);
  const out = new Uint8Array(4 + 4 + bytes.length + 4);
  const view = new DataView(out.buffer);
  out[0] = 0x84; // último bloque de metadatos + tipo 4 (VORBIS_COMMENT)
  const length = 4 + bytes.length + 4;
  out[1] = (length >> 16) & 0xff;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  view.setUint32(4, bytes.length, true);
  out.set(bytes, 8);
  view.setUint32(8 + bytes.length, 0, true); // 0 comentarios
  return out;
}

export interface OggFlacOptions {
  /** Número de serie del flujo (identifica este stream dentro del archivo). */
  serial?: number;
  vendor?: string;
}

/**
 * Empaqueta un flujo FLAC en un archivo Ogg. Cada frame va en su propio
 * paquete y las páginas se cierran al llegar a 255 trozos, que es lo que
 * permite el formato.
 */
export function encodeOggFlac(stream: FlacStream, options: OggFlacOptions = {}): Uint8Array {
  const serial = options.serial ?? 0x0deb17; // cualquiera vale: identifica el flujo
  const vendor = options.vendor ?? 'Orbit Studio';
  const pages: Uint8Array[] = [];
  let sequence = 0;

  // Página 0: el mapeo, solo (BOS). Detrás va 1 cabecera más (el comentario).
  const mapping = mappingPacket(stream.header, 1);
  pages.push(
    writePage({
      segments: lacing(mapping.length),
      body: mapping,
      granule: 0,
      serial,
      sequence: sequence++,
      flags: HEADER_BOS,
    }),
  );

  // Página 1: el VORBIS_COMMENT.
  const comment = commentPacket(vendor);
  pages.push(
    writePage({
      segments: lacing(comment.length),
      body: comment,
      granule: 0,
      serial,
      sequence: sequence++,
      flags: 0,
    }),
  );

  // Audio: un paquete por frame, agrupando en páginas de hasta 255 trozos.
  let segments: number[] = [];
  const bodies: Uint8Array[] = [];
  let bodyBytes = 0;
  let samplesDone = 0;
  let granule = 0;

  const flush = (last: boolean): void => {
    if (segments.length === 0) return;
    const body = new Uint8Array(bodyBytes);
    let at = 0;
    for (const part of bodies) {
      body.set(part, at);
      at += part.length;
    }
    pages.push(
      writePage({
        segments,
        body,
        granule,
        serial,
        sequence: sequence++,
        flags: last ? HEADER_EOS : 0,
      }),
    );
    segments = [];
    bodies.length = 0;
    bodyBytes = 0;
  };

  stream.frames.forEach((frame, i) => {
    const parts = lacing(frame.length);
    // Un paquete no se parte entre páginas aquí: si no cabe entero, se cierra
    // la página y empieza otra (más simple y perfectamente válido).
    if (segments.length + parts.length > MAX_SEGMENTS) flush(false);
    segments = segments.concat(parts);
    bodies.push(frame);
    bodyBytes += frame.length;
    const isLast = i === stream.frames.length - 1;
    samplesDone = isLast
      ? stream.totalSamples
      : Math.min(stream.totalSamples, samplesDone + stream.blockSize);
    granule = samplesDone;
    if (isLast) flush(true);
  });

  // Sin frames (audio vacío) hace falta una última página igualmente: un Ogg
  // sin EOS está truncado para cualquier lector.
  if (stream.frames.length === 0) {
    pages.push(
      writePage({
        segments: [0],
        body: new Uint8Array(0),
        granule: 0,
        serial,
        sequence: sequence++,
        flags: HEADER_EOS,
      }),
    );
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

/** Solo para tests: la bandera de "continúa" existe aunque aquí no se use. */
export const OGG_FLAGS = {
  continued: HEADER_CONTINUED,
  bos: HEADER_BOS,
  eos: HEADER_EOS,
} as const;
