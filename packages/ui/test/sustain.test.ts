/**
 * Pedal de sostenido: lo que decide qué nota se suelta y cuándo.
 *
 * Los casos que se prueban aquí son los que dejan notas colgando en un DAW:
 * repicar la misma tecla con el pedal pisado, y desenchufar el teclado sin
 * levantarlo.
 */

import { describe, expect, it } from 'vitest';
import { SustainPedal } from '../src/state/sustain';

const DEV = 'teclado-1';
const OTHER = 'teclado-2';

describe('pedal de sostenido', () => {
  it('sin pedal, un note-off suelta como siempre', () => {
    const pedal = new SustainPedal();
    expect(pedal.holdNoteOff(DEV, 'midi:teclado-1:60')).toBe(false);
    expect(pedal.holding).toBe(0);
  });

  it('con el pedal pisado retiene, y al levantarlo suelta todo lo retenido', () => {
    const pedal = new SustainPedal();
    pedal.press(DEV);
    expect(pedal.holdNoteOff(DEV, 'a')).toBe(true);
    expect(pedal.holdNoteOff(DEV, 'b')).toBe(true);
    expect(pedal.holding).toBe(2);
    expect(pedal.release(DEV).sort()).toEqual(['a', 'b']);
    expect(pedal.holding).toBe(0);
  });

  it('repicar la misma tecla con el pedal pisado suelta la vieja primero', () => {
    // Sin esto el kernel ignora el note-on (esa fuente ya está sonando) y la
    // tecla repicada no suena: el fallo clásico de tocar acordes con pedal.
    const pedal = new SustainPedal();
    pedal.press(DEV);
    pedal.holdNoteOff(DEV, 'a');
    expect(pedal.takeRetrigger('a')).toBe(true);
    expect(pedal.holding).toBe(0);
    // Ya no está retenida: levantar el pedal no la suelta otra vez.
    expect(pedal.release(DEV)).toEqual([]);
  });

  it('una tecla que nunca se retuvo no dispara re-ataque', () => {
    const pedal = new SustainPedal();
    expect(pedal.takeRetrigger('a')).toBe(false);
  });

  it('el pedal de un teclado no sostiene lo del otro', () => {
    const pedal = new SustainPedal();
    pedal.press(DEV);
    expect(pedal.isDown(DEV)).toBe(true);
    expect(pedal.isDown(OTHER)).toBe(false);
    expect(pedal.holdNoteOff(OTHER, 'x')).toBe(false);
    expect(pedal.holdNoteOff(DEV, 'y')).toBe(true);
    expect(pedal.release(OTHER)).toEqual([]);
    expect(pedal.release(DEV)).toEqual(['y']);
  });

  it('apagar el teclado con el pedal pisado suelta lo suyo y levanta su pedal', () => {
    const pedal = new SustainPedal();
    pedal.press(DEV);
    pedal.press(OTHER);
    pedal.holdNoteOff(DEV, 'a');
    pedal.holdNoteOff(OTHER, 'b');
    expect(pedal.forgetDevice(DEV)).toEqual(['a']);
    expect(pedal.isDown(DEV)).toBe(false);
    // El otro sigue intacto.
    expect(pedal.isDown(OTHER)).toBe(true);
    expect(pedal.holding).toBe(1);
  });

  it('el panic lo olvida todo', () => {
    const pedal = new SustainPedal();
    pedal.press(DEV);
    pedal.press(OTHER);
    pedal.holdNoteOff(DEV, 'a');
    pedal.holdNoteOff(OTHER, 'b');
    expect(pedal.clear().sort()).toEqual(['a', 'b']);
    expect(pedal.holding).toBe(0);
    expect(pedal.isDown(DEV)).toBe(false);
    expect(pedal.isDown(OTHER)).toBe(false);
  });
});
