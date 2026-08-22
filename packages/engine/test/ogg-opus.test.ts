/**
 * Contenedor Ogg Opus (RFC 7845).
 *
 * Estos tests leen lo que se escribió con el demuxer, no comparando bytes a
 * mano: si el escritor y el lector se equivocaran del mismo modo no valdría de
 * nada, así que además hay comprobaciones sobre los bytes crudos en los sitios
 * donde el formato no admite interpretación (magias, granulado, CRC).
 *
 * La validación de verdad —paquetes Opus reales de ffmpeg repaginados con esto,
 * decodificados y comparados muestra a muestra— está en
 * `tools/qa/ogg-opus-verify.ts`, porque necesita ffmpeg y esto tiene que correr
 * en cualquier sitio.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRE_SKIP,
  OPUS_GRANULE_RATE,
  encodeOggOpus,
  opusDuration,
  opusHeadPacket,
  opusTagsPacket,
  parseOggOpus,
  parseOggPages,
  type OpusPacket,
} from '../src/render/ogg-opus';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Paquetes de mentira: para el contenedor sólo son bytes con una longitud. */
function fakePackets(count: number, samples = 960, size = 40): OpusPacket[] {
  return Array.from({ length: count }, (_, i) => ({
    data: Uint8Array.from({ length: size }, (_, b) => (i * 7 + b * 13) & 0xff),
    samples,
  }));
}

describe('ogg opus · OpusHead', () => {
  it('escribe los campos donde el formato los espera', () => {
    const head = opusHeadPacket({ channels: 2, preSkip: 312, inputRate: 44100, gainDb: 0 });
    expect(head).toHaveLength(19);
    expect(text(head.subarray(0, 8))).toBe('OpusHead');
    expect(head[8]).toBe(1); // versión
    expect(head[9]).toBe(2); // canales
    const view = new DataView(head.buffer);
    expect(view.getUint16(10, true)).toBe(312); // pre-skip
    expect(view.getUint32(12, true)).toBe(44100); // frecuencia de entrada
    expect(view.getInt16(16, true)).toBe(0); // ganancia
    expect(head[18]).toBe(0); // familia de canales
  });

  it('la frecuencia de entrada es informativa: NO toca el granulado', () => {
    // Es el error clásico del mapeo. El granulado va a 48 kHz aunque el audio
    // venga a 44,1: si se escalara, el archivo duraría lo que no es.
    const packets = fakePackets(50, 960);
    const at44 = parseOggOpus(encodeOggOpus(packets, { inputRate: 44100, preSkip: 0 }));
    const at48 = parseOggOpus(encodeOggOpus(packets, { inputRate: 48000, preSkip: 0 }));
    expect(at44.inputRate).toBe(44100);
    expect(at48.inputRate).toBe(48000);
    expect(at44.finalGranule).toBe(at48.finalGranule);
    expect(at44.finalGranule).toBe(50 * 960);
    expect(OPUS_GRANULE_RATE).toBe(48000);
  });

  it('guarda la ganancia en Q7.8 y la devuelve en dB', () => {
    expect(parseOggOpus(encodeOggOpus(fakePackets(2), { gainDb: -6 })).gainDb).toBe(-6);
    expect(parseOggOpus(encodeOggOpus(fakePackets(2), { gainDb: 3.5 })).gainDb).toBe(3.5);
  });

  it('rechaza más de 2 canales con la familia 0', () => {
    // Más canales exigen tabla de mapeo detrás; decirlo es mejor que escribir
    // una cabecera que miente sobre lo que hay.
    expect(() => opusHeadPacket({ channels: 6 })).toThrow(/1 o 2 canales/);
    expect(() => opusHeadPacket({ channels: 0 })).toThrow(/fuera de rango/);
  });
});

describe('ogg opus · OpusTags', () => {
  it('escribe el vendor y las etiquetas, y se leen de vuelta', () => {
    const tags = { TITLE: 'Materia Gris', ARTIST: 'Orbit', DATE: '2026' };
    const file = encodeOggOpus(fakePackets(3), { vendor: 'Orbit Studio', tags });
    const info = parseOggOpus(file);
    expect(info.vendor).toBe('Orbit Studio');
    expect(info.tags).toEqual(tags);
  });

  it('aguanta acentos y símbolos (va en UTF-8, contado en bytes)', () => {
    // La longitud del campo son BYTES, no caracteres: con acentos, contar
    // caracteres parte el archivo justo por la mitad de una letra.
    const tags = { TITLE: 'Canción · Ñandú 日本', COMMENT: 'ó'.repeat(50) };
    const info = parseOggOpus(encodeOggOpus(fakePackets(2), { tags }));
    expect(info.tags).toEqual(tags);
  });

  it('sin etiquetas escribe una lista vacía, no un campo ausente', () => {
    const packet = opusTagsPacket('x');
    expect(text(packet.subarray(0, 8))).toBe('OpusTags');
    const info = parseOggOpus(encodeOggOpus(fakePackets(1), { vendor: 'x' }));
    expect(info.tags).toEqual({});
    expect(info.vendor).toBe('x');
  });
});

describe('ogg opus · páginas', () => {
  it('empieza por "OggS" y las dos cabeceras van solas en su página', () => {
    const file = encodeOggOpus(fakePackets(10));
    expect(text(file.subarray(0, 4))).toBe('OggS');
    const pages = parseOggPages(file);
    expect(pages[0]!.packets).toHaveLength(1);
    expect(text(pages[0]!.packets[0]!.subarray(0, 8))).toBe('OpusHead');
    expect(pages[1]!.packets).toHaveLength(1);
    expect(text(pages[1]!.packets[0]!.subarray(0, 8))).toBe('OpusTags');
  });

  it('marca BOS en la primera y EOS en la última', () => {
    const pages = parseOggPages(encodeOggOpus(fakePackets(10)));
    expect(pages[0]!.flags & 0x02).toBe(0x02);
    expect(pages[pages.length - 1]!.flags & 0x04).toBe(0x04);
    // Y en ninguna otra.
    pages.slice(1, -1).forEach((page, i) => {
      expect(page.flags & 0x06, `página ${i + 1}`).toBe(0);
    });
  });

  it('las cabeceras llevan granulado 0', () => {
    const pages = parseOggPages(encodeOggOpus(fakePackets(5)));
    expect(pages[0]!.granule).toBe(0);
    expect(pages[1]!.granule).toBe(0);
  });

  it('el CRC de todas las páginas cuadra', () => {
    const pages = parseOggPages(encodeOggOpus(fakePackets(300)));
    expect(pages.every((page) => page.crcOk)).toBe(true);
    expect(pages.length).toBeGreaterThan(3);
  });

  it('un byte cambiado rompe el CRC (o sea: el CRC sirve)', () => {
    const file = encodeOggOpus(fakePackets(20));
    const broken = Uint8Array.from(file);
    broken[broken.length - 5] = broken[broken.length - 5]! ^ 0xff;
    expect(parseOggPages(broken).some((page) => !page.crcOk)).toBe(true);
  });

  it('numera las páginas en orden y sin saltos', () => {
    const pages = parseOggPages(encodeOggOpus(fakePackets(400)));
    pages.forEach((page, i) => expect(page.sequence, `página ${i}`).toBe(i));
  });

  it('todas las páginas comparten número de serie', () => {
    const pages = parseOggPages(encodeOggOpus(fakePackets(50), { serial: 0x1234 }));
    expect(pages.every((page) => page.serial === 0x1234)).toBe(true);
  });

  it('cierra la página al llegar al tope de trozos y sigue en otra', () => {
    // 255 trozos es el máximo del formato; con 400 paquetes hay que partir.
    const pages = parseOggPages(encodeOggOpus(fakePackets(400)));
    const audio = pages.slice(2);
    expect(audio.length).toBeGreaterThan(1);
    const total = audio.reduce((sum, page) => sum + page.packets.length, 0);
    expect(total).toBe(400);
  });
});

describe('ogg opus · granulado y pre-skip', () => {
  it('el granulado acumula muestras a 48 kHz e incluye el pre-skip', () => {
    const info = parseOggOpus(encodeOggOpus(fakePackets(100, 960), { preSkip: 312 }));
    expect(info.finalGranule).toBe(312 + 100 * 960);
    expect(info.preSkip).toBe(312);
  });

  it('la duración real es el granulado menos el pre-skip', () => {
    // Ésta es la resta que, si se olvida, alarga todos los temas exportados.
    const info = parseOggOpus(encodeOggOpus(fakePackets(50, 960), { preSkip: 312 }));
    expect(info.samples).toBe(50 * 960);
    expect(opusDuration(info.finalGranule, info.preSkip)).toBe(50 * 960);
    expect(info.samples / OPUS_GRANULE_RATE).toBeCloseTo(1, 6);
  });

  it('crece de forma monótona página a página', () => {
    const pages = parseOggPages(encodeOggOpus(fakePackets(400, 480)));
    const audio = pages.slice(2);
    let last = -1;
    for (const page of audio) {
      expect(page.granule).toBeGreaterThan(last);
      last = page.granule;
    }
  });

  it('el pre-skip por defecto es el de libopus', () => {
    expect(DEFAULT_PRE_SKIP).toBe(312);
    expect(parseOggOpus(encodeOggOpus(fakePackets(2))).preSkip).toBe(312);
  });

  it('aguanta tramas de todos los tamaños de Opus', () => {
    for (const samples of [120, 240, 480, 960, 1920, 2880]) {
      const info = parseOggOpus(encodeOggOpus(fakePackets(20, samples), { preSkip: 0 }));
      expect(info.samples, `tramas de ${samples}`).toBe(20 * samples);
    }
  });
});

describe('ogg opus · ida y vuelta', () => {
  it('los paquetes vuelven byte a byte', () => {
    const packets = fakePackets(120, 960, 77);
    const info = parseOggOpus(encodeOggOpus(packets));
    expect(info.packets).toHaveLength(packets.length);
    packets.forEach((packet, i) => {
      expect(Array.from(info.packets[i]!), `paquete ${i}`).toEqual(Array.from(packet.data));
    });
  });

  it('un paquete de más de 255 bytes se trocea y se vuelve a juntar bien', () => {
    // El troceado (lacing) es donde más fácil se pierde un byte: un paquete de
    // 255 exactos necesita un trozo final de 0 o el lector lo pega con el
    // siguiente.
    for (const size of [254, 255, 256, 510, 511, 1000]) {
      const packets = [{ data: Uint8Array.from({ length: size }, (_, i) => i & 0xff), samples: 960 }];
      const info = parseOggOpus(encodeOggOpus(packets));
      expect(info.packets, `tamaño ${size}`).toHaveLength(1);
      expect(info.packets[0]!.length, `tamaño ${size}`).toBe(size);
      expect(Array.from(info.packets[0]!), `tamaño ${size}`).toEqual(Array.from(packets[0]!.data));
    }
  });

  it('un paquete que cruza el borde de página se vuelve a juntar', () => {
    // Con paquetes grandes el cuerpo no cabe en una página y el último queda a
    // medias: el lector tiene que pegarlo con lo que llega en la siguiente.
    const packets = Array.from({ length: 40 }, (_, i) => ({
      data: Uint8Array.from({ length: 900 }, (_, b) => (i + b) & 0xff),
      samples: 960,
    }));
    const info = parseOggOpus(encodeOggOpus(packets));
    expect(info.packets).toHaveLength(40);
    info.packets.forEach((packet, i) => {
      expect(Array.from(packet), `paquete ${i}`).toEqual(Array.from(packets[i]!.data));
    });
  });

  it('un flujo sin audio sigue siendo un Ogg válido', () => {
    // Sin EOS el archivo está truncado para cualquier lector, aunque no haya
    // nada que reproducir.
    const file = encodeOggOpus([]);
    const pages = parseOggPages(file);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages[pages.length - 1]!.flags & 0x04).toBe(0x04);
    expect(pages.every((page) => page.crcOk)).toBe(true);
    const info = parseOggOpus(file);
    expect(info.packets).toHaveLength(0);
    expect(info.samples).toBe(0);
  });

  it('protesta si no es un Ogg', () => {
    expect(() => parseOggPages(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].concat(Array(30).fill(0))))).toThrow(
      /OggS/,
    );
  });

  it('protesta si el Ogg no lleva Opus dentro', () => {
    const file = encodeOggOpus(fakePackets(3));
    const broken = Uint8Array.from(file);
    // Se destroza la magia de OpusHead dejando el resto intacto.
    broken[28] = 0x58;
    expect(() => parseOggOpus(broken)).toThrow(/OpusHead/);
  });
});
