/**
 * Lectura de los bytes que manda un controlador MIDI.
 *
 * Todo lo de aquí se prueba sin teclado, sin navegador y sin audio, que es
 * justo la parte donde más cosas raras hace el hardware real.
 */

import { describe, expect, it } from 'vitest';
import {
  applyVelocityCurve,
  channelMatches,
  CC_SUSTAIN,
  parseMidiMessage,
  transposeKey,
} from '../src/state/midi-message';

describe('parseMidiMessage', () => {
  it('lee note-on con su canal, tecla y velocidad', () => {
    expect(parseMidiMessage([0x90, 60, 127])).toEqual({
      kind: 'noteOn',
      channel: 1,
      key: 60,
      velocity: 1,
    });
    // Canal 10 (el de la batería en GM): nibble bajo 9.
    expect(parseMidiMessage([0x99, 36, 64])).toMatchObject({ channel: 10, key: 36 });
  });

  it('un note-on con velocidad 0 es un note-off', () => {
    // Medio hardware manda esto para poder usar running status. Tratarlo como
    // nota nueva deja la tecla sonando para siempre.
    expect(parseMidiMessage([0x90, 60, 0])).toEqual({ kind: 'noteOff', channel: 1, key: 60 });
  });

  it('lee note-off explícito', () => {
    expect(parseMidiMessage([0x80, 60, 64])).toEqual({ kind: 'noteOff', channel: 1, key: 60 });
  });

  it('el pedal de sostenido sale resuelto a pisado o suelto', () => {
    expect(parseMidiMessage([0xb0, CC_SUSTAIN, 127])).toEqual({
      kind: 'sustain',
      channel: 1,
      down: true,
    });
    expect(parseMidiMessage([0xb0, CC_SUSTAIN, 0])).toMatchObject({ down: false });
    // Pedal continuo: la mitad de la carrera ya cuenta como pisado.
    expect(parseMidiMessage([0xb0, CC_SUSTAIN, 70])).toMatchObject({ down: true });
    expect(parseMidiMessage([0xb0, CC_SUSTAIN, 50])).toMatchObject({ down: false });
  });

  it('los CC normales salen normalizados a 0..1', () => {
    expect(parseMidiMessage([0xb0, 1, 127])).toEqual({
      kind: 'cc',
      channel: 1,
      controller: 1,
      value: 1,
    });
    expect(parseMidiMessage([0xb0, 74, 0])).toMatchObject({ value: 0 });
  });

  it('all notes off y all sound off son lo mismo', () => {
    expect(parseMidiMessage([0xb0, 123, 0])).toEqual({ kind: 'allNotesOff', channel: 1 });
    expect(parseMidiMessage([0xb0, 120, 0])).toEqual({ kind: 'allNotesOff', channel: 1 });
  });

  it('el pitch bend se rearma de dos bytes de 7 bits y sale bipolar', () => {
    // Centro: 8192 = LSB 0, MSB 64.
    expect(parseMidiMessage([0xe0, 0, 64])).toEqual({ kind: 'pitchBend', channel: 1, value: 0 });
    // Arriba del todo: 16383.
    const up = parseMidiMessage([0xe0, 127, 127]);
    expect(up?.kind).toBe('pitchBend');
    expect((up as { value: number }).value).toBeCloseTo(1, 2);
    // Abajo del todo: 0.
    expect(parseMidiMessage([0xe0, 0, 0])).toMatchObject({ value: -1 });
  });

  it('lo que no usamos devuelve null en vez de adivinarse', () => {
    expect(parseMidiMessage([0xf8])).toBeNull(); // reloj
    expect(parseMidiMessage([0xf0, 0x7e])).toBeNull(); // SysEx
    expect(parseMidiMessage([0xc0, 5])).toBeNull(); // program change
    expect(parseMidiMessage([0x90])).toBeNull(); // truncado
    expect(parseMidiMessage([0x90, 60])).toBeNull(); // sin velocidad
  });
});

describe('curva de pulsación', () => {
  it('respeta los extremos siempre', () => {
    for (const curve of ['soft', 'linear', 'hard'] as const) {
      expect(applyVelocityCurve(0, curve)).toBeCloseTo(0, 6);
      expect(applyVelocityCurve(1, curve)).toBeCloseTo(1, 6);
    }
  });

  it('suave sube las flojas y dura las baja', () => {
    const v = 0.4;
    expect(applyVelocityCurve(v, 'soft')).toBeGreaterThan(v);
    expect(applyVelocityCurve(v, 'hard')).toBeLessThan(v);
    expect(applyVelocityCurve(v, 'linear')).toBeCloseTo(v, 6);
  });

  it('fija ignora la dinámica', () => {
    expect(applyVelocityCurve(0.1, 'fixed')).toBe(applyVelocityCurve(1, 'fixed'));
  });

  it('acota lo que venga fuera de rango', () => {
    expect(applyVelocityCurve(-1, 'linear')).toBe(0);
    expect(applyVelocityCurve(9, 'linear')).toBe(1);
  });
});

describe('filtro de canal y transposición', () => {
  it('canal 0 es omni', () => {
    expect(channelMatches(7, 0)).toBe(true);
    expect(channelMatches(7, 7)).toBe(true);
    expect(channelMatches(7, 8)).toBe(false);
  });

  it('transpone por octavas y descarta lo que se sale del rango', () => {
    expect(transposeKey(60, 1)).toBe(72);
    expect(transposeKey(60, -2)).toBe(36);
    expect(transposeKey(0, 0)).toBe(0);
    expect(transposeKey(127, 0)).toBe(127);
    expect(transposeKey(120, 1)).toBeNull();
    expect(transposeKey(5, -1)).toBeNull();
  });
});
