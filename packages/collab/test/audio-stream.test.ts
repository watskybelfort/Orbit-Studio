/**
 * Streaming del master: formato del mensaje y reloj de reproducción.
 *
 * Lo que se prueba es lo que decide si esto se oye o suena a trompicones: que
 * el trozo sobreviva al viaje tal cual, que lo que llega roto (o gigante) se
 * descarte en vez de reventar el reproductor, y que el reloj re-enganche
 * cuando un trozo llega tarde y frene cuando la cola se va por delante.
 */

import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import {
  AUDIO_MAX_SAMPLES,
  MESSAGE_AUDIO,
  StreamClock,
  encodeAudioChunk,
  fromInt16,
  readAudioChunkBody,
  toMonoInt16,
} from '../src/audio-stream';

/** Lee un mensaje entero (tipo + cuerpo), como hace quien lo recibe. */
function roundTrip(bytes: Uint8Array) {
  const decoder = decoding.createDecoder(bytes);
  expect(decoding.readVarUint(decoder)).toBe(MESSAGE_AUDIO);
  return readAudioChunkBody(decoder);
}

describe('mensaje de audio', () => {
  it('sin comprimir va y vuelve igual', () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const chunk = roundTrip(
      encodeAudioChunk({ from: 42, sampleRate: 44100, seq: 7, samples, codec: 'pcm16' }),
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.from).toBe(42);
    expect(chunk!.sampleRate).toBe(44100);
    expect(chunk!.seq).toBe(7);
    expect(chunk!.codec).toBe('pcm16');
    expect([...chunk!.samples]).toEqual([...samples]);
  });

  it('por defecto viaja COMPRIMIDO y ocupa la mitad', () => {
    const samples = new Int16Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(Math.sin((i * 2 * Math.PI * 440) / 48000) * 16000);
    }
    const crudo = encodeAudioChunk({ from: 1, sampleRate: 48000, seq: 0, samples, codec: 'pcm16' });
    const comprimido = encodeAudioChunk({ from: 1, sampleRate: 48000, seq: 0, samples });
    expect(comprimido.byteLength).toBeLessThan(crudo.byteLength / 1.9);

    const chunk = roundTrip(comprimido);
    expect(chunk!.codec).toBe('adpcm');
    expect(chunk!.samples).toHaveLength(1000);
    // Con pérdida, pero parecido: el error no puede ser el de otra señal.
    let error = 0;
    let señal = 0;
    for (let i = 100; i < samples.length; i++) {
      error += (samples[i]! - chunk!.samples[i]!) ** 2;
      señal += samples[i]! ** 2;
    }
    expect(10 * Math.log10(señal / error)).toBeGreaterThan(20);
  });

  it('un número impar de muestras sobrevive al viaje', () => {
    const samples = new Int16Array([100, -200, 300]);
    const chunk = roundTrip(encodeAudioChunk({ from: 1, sampleRate: 48000, seq: 0, samples }));
    expect(chunk!.samples).toHaveLength(3);
  });

  it('no comparte memoria con el mensaje (que se reutiliza)', () => {
    const bytes = encodeAudioChunk({
      from: 1,
      sampleRate: 48000,
      seq: 1,
      samples: new Int16Array([500, -500]),
      codec: 'pcm16',
    });
    const chunk = roundTrip(bytes);
    bytes.fill(0); // el buffer del socket se reaprovecha
    expect([...chunk!.samples]).toEqual([500, -500]);
  });

  it('descarta lo que no cuadra', () => {
    const bad = (sampleRate: number, count: number) => {
      const samples = new Int16Array(count);
      return roundTrip(encodeAudioChunk({ from: 1, sampleRate, seq: 0, samples, codec: 'pcm16' }));
    };
    expect(bad(44100, 0)).toBeNull(); // sin muestras
    expect(bad(1000, 10)).toBeNull(); // sample rate imposible
    expect(bad(44100, AUDIO_MAX_SAMPLES + 1)).toBeNull(); // trozo desmesurado
  });
});

describe('conversión', () => {
  it('estéreo a mono, con recorte a la escala entera', () => {
    const mono = toMonoInt16(new Float32Array([1, -1, 2]), new Float32Array([1, -1, 2]));
    expect([...mono]).toEqual([32767, -32767, 32767]);
  });

  it('mezcla los dos canales', () => {
    const mono = toMonoInt16(new Float32Array([1, 0]), new Float32Array([0, -1]));
    expect(mono[0]).toBe(Math.round(0.5 * 32767));
    expect(mono[1]).toBe(Math.round(-0.5 * 32767));
  });

  it('y vuelve a flotante casi igual', () => {
    const back = fromInt16(toMonoInt16(new Float32Array([0.5]), new Float32Array([0.5])));
    expect(back[0]).toBeCloseTo(0.5, 4);
  });

  it('el trozo mono dura lo del canal más corto', () => {
    expect(toMonoInt16(new Float32Array(10), new Float32Array(4))).toHaveLength(4);
  });
});

describe('reloj de reproducción', () => {
  it('el primer trozo entra con colchón, y el siguiente pegado a él', () => {
    const clock = new StreamClock({ lead: 0.15 });
    const first = clock.plan(10, 0.1);
    expect(first).toEqual({ at: 10.15, reset: true, dropped: false });
    const second = clock.plan(10.05, 0.1);
    expect(second.at).toBeCloseTo(10.25, 6);
    expect(second.reset).toBe(false);
  });

  it('un trozo que llega tarde re-engancha en vez de sonar en el pasado', () => {
    const clock = new StreamClock({ lead: 0.15 });
    clock.plan(10, 0.1); // programado hasta 10.25
    const late = clock.plan(11, 0.1); // la red se atascó un segundo
    expect(late.reset).toBe(true);
    expect(late.at).toBeCloseTo(11.15, 6);
  });

  it('si la cola se va por delante, se tira el trozo', () => {
    const clock = new StreamClock({ lead: 0.15, maxAhead: 0.4 });
    // El emisor manda más rápido de lo que suena: la cola crece.
    for (let i = 0; i < 6; i++) clock.plan(10, 0.1);
    const plan = clock.plan(10, 0.1);
    expect(plan.dropped).toBe(true);
    // Y tirarlo no mueve el reloj: lo que ya estaba programado sigue igual.
    expect(clock.ahead(10)).toBeLessThanOrEqual(0.55);
  });

  it('reset lo deja como recién empezado', () => {
    const clock = new StreamClock({ lead: 0.15 });
    clock.plan(10, 0.1);
    clock.reset();
    expect(clock.ahead(10)).toBe(0);
    expect(clock.plan(20, 0.1).reset).toBe(true);
  });
});
