/**
 * Las herramientas Pincel y Cortar del Piano Roll (`tools.ts`), sin canvas.
 *
 * `occupied` decide si el pincel repinta (no debería); `sliceCuts` decide qué
 * notas cruza una tijera dibujada a mano y en qué punto exacto; y
 * `applySliceCuts` las convierte en el parche + las colas que van en un solo
 * `batch`. Las tres son geometría pura, y las tres tienen una regla que se
 * rompe en silencio si alguien las toca sin mirar: un pincel que repinta deja
 * dos notas superpuestas indistinguibles en pantalla, un corte que no respeta
 * `MIN_PIECE` deja restos de un tick que no se pueden ni ver ni seleccionar.
 */

import { describe, expect, it } from 'vitest';
import type { Note } from '@orbit/core';
import { applySliceCuts, occupied, sliceCuts } from '../src/editors/pianoroll/tools';

const nota = (id: string, over: Partial<Note> = {}): Note => ({
  id,
  start: 0,
  duration: 1,
  key: 60,
  velocity: 0.8,
  pan: 0,
  slide: false,
  ...over,
});

describe('el pincel no repinta', () => {
  const notes = [nota('a', { key: 60, start: 4, duration: 2 })];

  it('dentro del tramo de una nota de su misma fila: ocupado', () => {
    expect(occupied(notes, 60, 4)).toBe(true);
    expect(occupied(notes, 60, 5.5)).toBe(true);
  });

  it('justo en el final (exclusivo) ya está libre: ahí puede empezar la siguiente', () => {
    expect(occupied(notes, 60, 6)).toBe(false);
  });

  it('otra fila en el mismo beat no cuenta', () => {
    expect(occupied(notes, 61, 4)).toBe(false);
  });
});

describe('qué corta la tijera', () => {
  // Filas cada 10px, C5=60 en y=0 y sube con la fila; 4 beats = 40px, para que
  // xToBeat/rowCenterY sean triviales de leer a ojo en los tests.
  const rowCenterY = (key: number) => (72 - key) * 10;
  const xToBeat = (x: number) => x / 10;

  it('una línea horizontal (o un clic) no corta nada — como en FL', () => {
    const notes = [nota('a', { key: 60, start: 0, duration: 4 })];
    expect(sliceCuts(notes, { x0: 0, y0: 120, x1: 40, y1: 120 }, rowCenterY, xToBeat)).toEqual([]);
  });

  it('un tajo vertical corta la nota que atraviesa, en el beat exacto', () => {
    const notes = [nota('a', { key: 60, start: 0, duration: 4 })];
    // La fila de key=60 está en y=120. Un tajo vertical en x=20 la cruza ahí.
    const cuts = sliceCuts(notes, { x0: 20, y0: 0, x1: 20, y1: 240 }, rowCenterY, xToBeat);
    expect(cuts).toHaveLength(1);
    expect(cuts[0]!.note.id).toBe('a');
    expect(cuts[0]!.at).toBeCloseTo(2, 6);
  });

  it('una fila que el tajo no toca (fuera de x0..x1 en su y) no se corta', () => {
    const notes = [nota('a', { key: 55, start: 0, duration: 4 })]; // fila muy abajo
    const cuts = sliceCuts(notes, { x0: 20, y0: 0, x1: 20, y1: 50 }, rowCenterY, xToBeat);
    expect(cuts).toEqual([]);
  });

  it('un corte demasiado cerca del borde no cuenta (dejaría un resto invisible)', () => {
    const notes = [nota('a', { key: 60, start: 0, duration: 4 })];
    // x=0.1 -> beat 0.01, por debajo de MIN_PIECE (1/64 = 0.015625).
    const cuts = sliceCuts(notes, { x0: 0.1, y0: 0, x1: 0.1, y1: 240 }, rowCenterY, xToBeat);
    expect(cuts).toEqual([]);
  });

  it('varias notas de la misma fila: cada una se corta con SU propio inicio', () => {
    const notes = [
      nota('a', { key: 60, start: 0, duration: 4 }),
      nota('b', { key: 60, start: 8, duration: 4 }),
    ];
    const cuts = sliceCuts(notes, { x0: 20, y0: 0, x1: 20, y1: 240 }, rowCenterY, xToBeat);
    // beat 2 solo cae DENTRO de 'a' (0..4); 'b' (8..12) no lo cruza.
    expect(cuts.map((c) => c.note.id)).toEqual(['a']);
  });
});

describe('lo que sale de aplicar los cortes', () => {
  it('la cabeza conserva el id y pierde el slide; la cola nace nueva y se lo queda', () => {
    const original = nota('a', { start: 0, duration: 4, slide: true, velocity: 0.5 });
    const { patches, tails } = applySliceCuts([{ note: original, at: 1.5 }]);

    expect(patches).toEqual([{ id: 'a', duration: 1.5, slide: false }]);
    expect(tails).toHaveLength(1);
    const cola = tails[0]!;
    expect(cola.id).not.toBe('a'); // nace con id nuevo
    expect(cola.start).toBe(1.5);
    expect(cola.duration).toBeCloseTo(2.5, 6); // 4 - 1.5
    expect(cola.slide).toBe(true); // el glide sigue apuntando al final original
    expect(cola.velocity).toBe(0.5); // el resto de la nota viaja igual
  });

  it('varios cortes producen sus pares en el mismo orden', () => {
    const a = nota('a', { start: 0, duration: 4 });
    const b = nota('b', { start: 10, duration: 4 });
    const { patches, tails } = applySliceCuts([
      { note: a, at: 1 },
      { note: b, at: 12 },
    ]);
    expect(patches.map((p) => p.id)).toEqual(['a', 'b']);
    expect(tails.map((t) => t.start)).toEqual([1, 12]);
  });
});
