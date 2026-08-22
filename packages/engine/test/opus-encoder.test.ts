/**
 * Encoder Opus completo.
 *
 * Estos tests comprueban la estructura sin salir de casa: que el TOC diga la
 * verdad, que el archivo se lea de vuelta, que no aparezcan NaN, que el
 * resultado sea determinista.
 *
 * **La comprobación que de verdad decide está fuera**, en
 * `tools/qa/opus-verify.ts`: allí ffmpeg decodifica lo que sale de aquí y se
 * compara con el original. Nada de lo que hay en este archivo demuestra que el
 * códec funcione — sólo que no se ha roto por dentro. Se dice aquí para que
 * nadie confunda una cosa con la otra.
 */

import { describe, expect, it } from 'vitest';
import { parseOggOpus, parseOggPages } from '../src/render/ogg-opus';
import { PRE_SKIP, encodeOpusFile, encodeOpusPackets, tocByte } from '../src/render/opus/encoder';

/** Señal con varios tonos, para que toque bandas graves, medias y agudas. */
function signal(seconds: number, channels: number): Float64Array {
  const samples = Math.floor(48000 * seconds);
  const out = new Float64Array(samples * channels);
  for (let i = 0; i < samples; i++) {
    const t = i / 48000;
    const value =
      0.3 * Math.sin(2 * Math.PI * 440 * t) +
      0.15 * Math.sin(2 * Math.PI * 1370 * t) +
      0.05 * Math.sin(2 * Math.PI * 4400 * t);
    for (let c = 0; c < channels; c++) out[i * channels + c] = value * (c === 1 ? 0.7 : 1);
  }
  return out;
}

describe('encoder · el byte TOC', () => {
  it('dice CELT en banda completa y una trama por paquete', () => {
    // Configuraciones 28 a 31: CELT puro, banda completa, por duración.
    expect(tocByte(120, 1) >> 3).toBe(28); // 2,5 ms
    expect(tocByte(240, 1) >> 3).toBe(29); // 5 ms
    expect(tocByte(480, 1) >> 3).toBe(30); // 10 ms
    expect(tocByte(960, 1) >> 3).toBe(31); // 20 ms
    // Los dos bits bajos a cero: un paquete, una trama.
    for (const size of [120, 240, 480, 960]) expect(tocByte(size, 1) & 0x3).toBe(0);
  });

  it('marca el estéreo en su bit', () => {
    expect(tocByte(960, 1) & 0x4).toBe(0);
    expect(tocByte(960, 2) & 0x4).toBe(0x4);
  });

  it('rechaza duraciones que CELT no tiene', () => {
    expect(() => tocByte(1000, 1)).toThrow(/no válido/);
    expect(() => tocByte(960 * 2, 1)).toThrow(/no válido/);
  });
});

describe('encoder · paquetes', () => {
  it('saca una trama por cada bloque de muestras', () => {
    for (const frameSize of [120, 240, 480, 960]) {
      const packets = encodeOpusPackets(signal(0.5, 1), { channels: 1, frameSize });
      expect(packets.length, `trama de ${frameSize}`).toBe(Math.ceil(24000 / frameSize));
      for (const packet of packets) {
        expect(packet.samples).toBe(frameSize);
        expect(packet.data[0]).toBe(tocByte(frameSize, 1));
      }
    }
  });

  it('el tamaño del paquete sigue al bitrate pedido', () => {
    const sizes = [32000, 64000, 128000, 256000].map((bitrate) => {
      const packets = encodeOpusPackets(signal(0.1, 2), { channels: 2, bitrate });
      return packets[0]!.data.length;
    });
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]!, `paso ${i}`).toBeGreaterThan(sizes[i - 1]!);
    }
    // A 64 kbps y 20 ms tocan 160 bytes por trama.
    expect(sizes[1]).toBe(160);
  });

  it('la última trama incompleta se rellena, no se pierde', () => {
    // 25 ms de audio con tramas de 20 ms son dos paquetes, no uno.
    const packets = encodeOpusPackets(signal(0.025, 1), { channels: 1, frameSize: 960 });
    expect(packets).toHaveLength(2);
  });
});

describe('encoder · el archivo', () => {
  it('se lee de vuelta con nuestro propio demuxer', () => {
    for (const channels of [1, 2]) {
      const file = encodeOpusFile(signal(0.3, channels), { channels });
      const info = parseOggOpus(file);
      expect(info.channels, `${channels} canales`).toBe(channels);
      expect(info.preSkip).toBe(PRE_SKIP);
      expect(info.packets.length).toBeGreaterThan(0);
      expect(info.pages.every((page) => page.crcOk)).toBe(true);
    }
  });

  it('la duración declarada cuadra con lo que entró', () => {
    const file = encodeOpusFile(signal(1, 1), { channels: 1 });
    const info = parseOggOpus(file);
    // 1 segundo son 50 tramas de 960; el granulado las cuenta todas.
    expect(info.samples).toBe(50 * 960);
  });

  it('empieza por OggS y acaba con EOS', () => {
    const file = encodeOpusFile(signal(0.2, 2), { channels: 2 });
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe('OggS');
    const pages = parseOggPages(file);
    expect(pages[0]!.flags & 0x02).toBe(0x02);
    expect(pages[pages.length - 1]!.flags & 0x04).toBe(0x04);
  });

  it('lleva las etiquetas que se le pasen', () => {
    const tags = { TITLE: 'Materia Gris', ARTIST: 'Orbit' };
    const info = parseOggOpus(encodeOpusFile(signal(0.1, 1), { channels: 1, tags }));
    expect(info.tags).toEqual(tags);
  });
});

describe('encoder · casos límite', () => {
  it('el silencio se codifica y ocupa poco', () => {
    const silence = new Float64Array(48000);
    const file = encodeOpusFile(silence, { channels: 1 });
    const info = parseOggOpus(file);
    expect(info.packets.length).toBe(50);
    // Una trama de silencio lleva su bandera y poco más: si ocupara lo mismo
    // que música, la bandera no estaría haciendo nada.
    expect(file.length).toBeLessThan(20000);
  });

  it('una señal a tope no revienta', () => {
    const loud = new Float64Array(9600);
    for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 1 : -1;
    const file = encodeOpusFile(loud, { channels: 1 });
    expect(parseOggOpus(file).packets.length).toBeGreaterThan(0);
  });

  it('audio más corto que una trama sigue dando un archivo válido', () => {
    const tiny = signal(0.005, 1); // 240 muestras, menos de una trama de 960
    const info = parseOggOpus(encodeOpusFile(tiny, { channels: 1 }));
    expect(info.packets).toHaveLength(1);
    expect(info.pages.every((page) => page.crcOk)).toBe(true);
  });

  it('es determinista: dos veces lo mismo dan el mismo archivo', () => {
    // Si no lo fuera, no habría forma de reproducir un fallo.
    const pcm = signal(0.2, 2);
    const a = encodeOpusFile(pcm, { channels: 2 });
    const b = encodeOpusFile(pcm, { channels: 2 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('los bytes del paquete son bytes de verdad', () => {
    // Un NaN o un infinito por dentro saldría aquí como un byte imposible.
    const packets = encodeOpusPackets(signal(0.3, 2), { channels: 2 });
    for (const packet of packets) {
      for (const byte of packet.data) {
        expect(Number.isInteger(byte)).toBe(true);
        expect(byte).toBeGreaterThanOrEqual(0);
        expect(byte).toBeLessThan(256);
      }
    }
  });
});
