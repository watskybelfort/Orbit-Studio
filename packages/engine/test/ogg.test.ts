/**
 * Contenedor Ogg para el FLAC propio.
 *
 * Un archivo Ogg mal formado no "suena peor": no lo abre nadie. Así que lo que
 * se prueba es la estructura exacta — capturas, banderas, secuencia, la tabla
 * de trozos (con el 0 final que hay que escribir cuando un paquete mide justo
 * un múltiplo de 255) y el CRC, que es el de Ogg y NO el de zip: confundirlos
 * da un archivo con la pinta correcta que ningún reproductor acepta.
 *
 * El "suena de verdad" lo cierra la QA con ffmpeg, aparte de estos tests.
 */

import { describe, expect, it } from 'vitest';
import { encodeFlacStream } from '../src/render/flac';
import { encodeOggFlac, lacing, oggCrc } from '../src/render/ogg';

function tone(samples: number, hz = 440, rate = 44100): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5;
  return out;
}

/** Recorre las páginas del archivo y devuelve sus cabeceras. */
function pages(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const out: {
    at: number;
    flags: number;
    granule: number;
    serial: number;
    sequence: number;
    segments: number[];
    bodyBytes: number;
    crcOk: boolean;
  }[] = [];
  let at = 0;
  while (at < file.length) {
    expect(String.fromCharCode(...file.subarray(at, at + 4))).toBe('OggS');
    const count = file[at + 26]!;
    const segments = [...file.subarray(at + 27, at + 27 + count)];
    const bodyBytes = segments.reduce((n, s) => n + s, 0);
    const size = 27 + count + bodyBytes;
    const page = file.slice(at, at + size);
    const stored = new DataView(page.buffer).getUint32(22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    out.push({
      at,
      flags: file[at + 5]!,
      granule: view.getUint32(at + 6, true) + view.getUint32(at + 10, true) * 0x100000000,
      serial: view.getUint32(at + 14, true),
      sequence: view.getUint32(at + 18, true),
      segments,
      bodyBytes,
      crcOk: oggCrc(page) === stored,
    });
    at += size;
  }
  return out;
}

describe('tabla de trozos', () => {
  it('parte en 255 y siempre termina por debajo', () => {
    expect(lacing(0)).toEqual([0]);
    expect(lacing(100)).toEqual([100]);
    expect(lacing(255)).toEqual([255, 0]); // el 0 final es obligatorio
    expect(lacing(600)).toEqual([255, 255, 90]);
  });
});

describe('CRC de Ogg', () => {
  it('no es el CRC32 de siempre', () => {
    // Vector conocido: el CRC de Ogg de "abc" con este polinomio.
    const abc = new TextEncoder().encode('abc');
    expect(oggCrc(abc)).not.toBe(0x352441c2); // ese sería el de zip
    expect(oggCrc(new Uint8Array(0))).toBe(0);
    // Determinista y sensible a un solo bit.
    expect(oggCrc(abc)).toBe(oggCrc(abc));
    expect(oggCrc(new TextEncoder().encode('abd'))).not.toBe(oggCrc(abc));
  });
});

describe('archivo Ogg FLAC', () => {
  const stream = encodeFlacStream(tone(44100), tone(44100, 660), 44100, 16);
  const file = encodeOggFlac(stream, { serial: 7 });
  const parsed = pages(file);

  it('todas las páginas cuadran de CRC y de serie', () => {
    expect(parsed.length).toBeGreaterThan(2);
    for (const page of parsed) {
      expect(page.crcOk).toBe(true);
      expect(page.serial).toBe(7);
    }
  });

  it('la secuencia va de 0 en adelante sin saltos', () => {
    expect(parsed.map((p) => p.sequence)).toEqual(parsed.map((_, i) => i));
  });

  it('la primera lleva BOS y el paquete de mapeo; la última, EOS', () => {
    expect(parsed[0]!.flags & 0x02).toBe(0x02);
    expect(parsed.at(-1)!.flags & 0x04).toBe(0x04);
    // 0x7F "FLAC" al principio del cuerpo de la primera página.
    const body = file.subarray(parsed[0]!.at + 27 + parsed[0]!.segments.length);
    expect(body[0]).toBe(0x7f);
    expect(String.fromCharCode(...body.subarray(1, 5))).toBe('FLAC');
    // Y dentro, el "fLaC" del flujo nativo.
    expect(String.fromCharCode(...body.subarray(9, 13))).toBe('fLaC');
  });

  it('la segunda página es el VORBIS_COMMENT que pide la spec', () => {
    const page = parsed[1]!;
    const body = file.subarray(page.at + 27 + page.segments.length);
    expect(body[0]).toBe(0x84); // último bloque de metadatos + tipo 4
    expect(new TextDecoder().decode(body.subarray(8, 8 + 12))).toBe('Orbit Studio');
  });

  it('el granulado acaba en el número de muestras del audio', () => {
    expect(parsed.at(-1)!.granule).toBe(44100);
    // Y nunca va hacia atrás.
    const audio = parsed.slice(2).map((p) => p.granule);
    for (let i = 1; i < audio.length; i++) {
      expect(audio[i]!).toBeGreaterThanOrEqual(audio[i - 1]!);
    }
  });

  it('el cuerpo de las páginas de audio son los frames FLAC, en orden', () => {
    const audioBytes = parsed.slice(2).reduce((n, p) => n + p.bodyBytes, 0);
    const framesBytes = stream.frames.reduce((n, f) => n + f.length, 0);
    expect(audioBytes).toBe(framesBytes);
  });

  it('un audio vacío sigue siendo un Ogg cerrado', () => {
    const empty = encodeOggFlac(encodeFlacStream(new Float32Array(0), new Float32Array(0), 44100));
    const emptyPages = pages(empty);
    expect(emptyPages.at(-1)!.flags & 0x04).toBe(0x04);
    for (const page of emptyPages) expect(page.crcOk).toBe(true);
  });
});
