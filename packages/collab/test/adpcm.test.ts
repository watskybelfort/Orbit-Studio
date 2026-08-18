/**
 * ADPCM del streaming del master.
 *
 * Con pérdida, así que no se compara muestra a muestra: lo que se mide es que
 * comprima 4:1 de verdad, que lo que sale se PAREZCA a lo que entró (error
 * pequeño frente a la señal, medido en dB), y que cada trozo sea independiente
 * — un paquete perdido no puede arrastrar al siguiente en un stream en vivo.
 */

import { describe, expect, it } from 'vitest';
import { adpcmBytes, decodeAdpcm, encodeAdpcm } from '../src/adpcm';

/** Tono de prueba: 440 Hz a 48 kHz, medio fondo de escala. */
function tone(samples: number, hz = 440, rate = 48000, amp = 0.5): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * amp * 32767);
  }
  return out;
}

/** Relación señal/ruido en dB entre el original y lo reconstruido. */
function snrDb(original: Int16Array, decoded: Int16Array): number {
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < original.length; i++) {
    const s = original[i]!;
    const e = s - decoded[i]!;
    signal += s * s;
    noise += e * e;
  }
  if (noise === 0) return Infinity;
  return 10 * Math.log10(signal / noise);
}

describe('compresión', () => {
  it('ocupa la mitad de bytes que el Int16 (4 bits por muestra)', () => {
    const samples = tone(4800);
    const packed = encodeAdpcm(samples);
    expect(packed.byteLength).toBe(adpcmBytes(samples.length));
    expect(packed.byteLength).toBe(samples.byteLength / 4);
  });

  it('un número impar de muestras cabe igual', () => {
    const samples = tone(101);
    const packed = encodeAdpcm(samples);
    expect(packed.byteLength).toBe(51);
    expect(decodeAdpcm(packed, 101)).toHaveLength(101);
  });
});

describe('calidad', () => {
  it('un tono vuelve reconocible (SNR alta)', () => {
    const samples = tone(4800);
    const decoded = decodeAdpcm(encodeAdpcm(samples), samples.length);
    // El arranque cuesta unas muestras (el predictor sale de 0): se mide el
    // resto, que es lo que se oye.
    expect(snrDb(samples.subarray(100), decoded.subarray(100))).toBeGreaterThan(20);
  });

  it('el silencio sigue siendo silencio', () => {
    const samples = new Int16Array(256);
    const decoded = decodeAdpcm(encodeAdpcm(samples), samples.length);
    expect([...decoded].every((v) => Math.abs(v) < 32)).toBe(true);
  });

  it('no se sale de rango ni con la señal a tope', () => {
    const samples = new Int16Array(512);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 32767 : -32768;
    const decoded = decodeAdpcm(encodeAdpcm(samples), samples.length);
    for (const v of decoded) {
      expect(v).toBeGreaterThanOrEqual(-32768);
      expect(v).toBeLessThanOrEqual(32767);
    }
  });
});

describe('trozos independientes', () => {
  it('perder un trozo no estropea el siguiente', () => {
    const todo = tone(3000);
    const a = todo.slice(0, 1000);
    const b = todo.slice(1000, 2000);
    const c = todo.slice(2000);

    // Se codifican los tres, se "pierde" el segundo y se decodifican los que
    // llegaron: el tercero tiene que salir igual de bien que si no faltara nada.
    const packedA = encodeAdpcm(a);
    encodeAdpcm(b);
    const packedC = encodeAdpcm(c);

    const decodedA = decodeAdpcm(packedA, a.length);
    const decodedC = decodeAdpcm(packedC, c.length);
    expect(snrDb(a.subarray(100), decodedA.subarray(100))).toBeGreaterThan(20);
    expect(snrDb(c.subarray(100), decodedC.subarray(100))).toBeGreaterThan(20);
  });

  it('el mismo trozo siempre da los mismos bytes', () => {
    const samples = tone(500);
    expect([...encodeAdpcm(samples)]).toEqual([...encodeAdpcm(samples)]);
  });
});
