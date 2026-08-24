/**
 * Lectura de los bytes que manda un controlador MIDI.
 *
 * Todo lo de aquí se prueba sin teclado, sin navegador y sin audio, que es
 * justo la parte donde más cosas raras hace el hardware real.
 */

import { describe, expect, it } from 'vitest';
import {
  applyVelocityCurve,
  bendSemitones,
  channelMatches,
  isBendRange,
  parseMidiMessage,
  transposeKey,
  BEND_DEADZONE,
  BEND_RANGE_DEFAULT,
  BEND_RANGES,
  CC_SUSTAIN,
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

describe('rueda de tono', () => {
  it('arriba del todo dobla el rango entero, abajo lo mismo al revés', () => {
    expect(bendSemitones(1, 2)).toBe(2);
    expect(bendSemitones(-1, 2)).toBe(-2);
    expect(bendSemitones(1, 12)).toBe(12);
    expect(bendSemitones(0.5, 12)).toBe(6);
  });

  it('centrada no dobla nada', () => {
    expect(bendSemitones(0, 2)).toBe(0);
    expect(bendSemitones(0, 24)).toBe(0);
  });

  it('la zona muerta se traga el muelle que no vuelve al centro exacto', () => {
    // Es el caso real: una rueda física se queda en 8191 o en 8193 y manda un
    // valor minúsculo para siempre. Sin zona muerta, el canal se quedaba
    // marcado como doblado y el motor reafinando cada nota que nacía.
    expect(bendSemitones(BEND_DEADZONE / 2, 2)).toBe(0);
    expect(bendSemitones(-BEND_DEADZONE / 2, 2)).toBe(0);
    // Pero justo por encima ya dobla: la zona muerta es del centro, no un
    // redondeo que se coma los movimientos pequeños de verdad.
    expect(bendSemitones(BEND_DEADZONE * 2, 12)).not.toBe(0);
  });

  it('una rueda que manda de más se acota, no se dispara', () => {
    expect(bendSemitones(5, 2)).toBe(2);
    expect(bendSemitones(-5, 2)).toBe(-2);
  });

  it('el rango de fábrica es el que trae cualquier teclado', () => {
    expect(BEND_RANGE_DEFAULT).toBe(2);
    expect(isBendRange(BEND_RANGE_DEFAULT)).toBe(true);
    expect(BEND_RANGES).toContain(12);
    expect(isBendRange(3.5)).toBe(false);
    expect(isBendRange('2')).toBe(false);
    expect(isBendRange(999)).toBe(false);
  });

  it('lo que sale del parser encaja con lo que espera el doblez', () => {
    // La rueda arriba del todo son 16383 y el centro 8192: el parser da +1 y
    // 0, y de ahí salen el rango entero y nada. Si estos dos dejaran de
    // cuadrar, la rueda doblaría la mitad de lo que dice el ajuste.
    const arriba = parseMidiMessage([0xe0, 0x7f, 0x7f]);
    expect(arriba).toEqual({ kind: 'pitchBend', channel: 1, value: (16383 - 8192) / 8192 });
    expect(bendSemitones((arriba as { value: number }).value, 12)).toBeCloseTo(12, 1);

    const centro = parseMidiMessage([0xe0, 0x00, 0x40]);
    expect(centro).toEqual({ kind: 'pitchBend', channel: 1, value: 0 });
    expect(bendSemitones((centro as { value: number }).value, 12)).toBe(0);
  });
});
