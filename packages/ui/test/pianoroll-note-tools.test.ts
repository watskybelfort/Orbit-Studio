/**
 * Los botones de la toolbar del Piano Roll que no vienen ya de `@orbit/core`:
 * a qué notas afecta cada uno (selección viva, o todo si no hay o si murió
 * con un deshacer) y qué escriben Cuantizar/Transponer.
 *
 * `arpeggiate`, `strum`, `humanize` y `chop` son de `@orbit/core` y ya tienen
 * sus tests en `packages/core/test/note-tools.test.ts` y `arp-full.test.ts` —
 * no se repiten aquí.
 */

import { describe, expect, it } from 'vitest';
import type { Note } from '@orbit/core';
import {
  affectedNoteIds,
  quantizePatches,
  transposePatches,
} from '../src/editors/pianoroll/note-tools';

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

describe('a qué notas afecta un botón de la toolbar', () => {
  const notes = [nota('a'), nota('b'), nota('c')];

  it('con selección, son solo las seleccionadas', () => {
    expect(affectedNoteIds(notes, new Set(['b']))).toEqual(['b']);
  });

  it('sin selección, son todas — nunca un botón que no hace nada', () => {
    expect(affectedNoteIds(notes, new Set())).toEqual(['a', 'b', 'c']);
  });

  it('una selección de ids que ya no existen (deshecho de por medio) cae a todas', () => {
    // El escenario real: se aplicó una herramienta, se deshizo, y `selection`
    // se quedó con los ids del resultado — que ya no están en `notes`.
    expect(affectedNoteIds(notes, new Set(['fantasma-1', 'fantasma-2']))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('una selección MIXTA (vivas y muertas) se poda, no se descarta entera', () => {
    expect(affectedNoteIds(notes, new Set(['b', 'fantasma']))).toEqual(['b']);
  });
});

describe('Cuantizar: redondea el inicio a la rejilla', () => {
  it('cuadra cada nota afectada a la rejilla, deja las demás fuera del parche', () => {
    const notes = [nota('a', { start: 0.31 }), nota('b', { start: 0.9 }), nota('c', { start: 2.1 })];
    const patches = quantizePatches(notes, new Set(['a', 'b']), 0.25);
    expect(patches).toEqual([
      { id: 'a', start: 0.25 },
      { id: 'b', start: 1 },
    ]);
  });
});

describe('Transponer: mueve semitonos y recorta al rango MIDI de la rejilla', () => {
  it('sube y baja lo pedido', () => {
    const notes = [nota('a', { key: 60 })];
    expect(transposePatches(notes, new Set(['a']), 12, 127)).toEqual([{ id: 'a', key: 72 }]);
    expect(transposePatches(notes, new Set(['a']), -12, 127)).toEqual([{ id: 'a', key: 48 }]);
  });

  it('no se sale del teclado por ninguno de los dos lados', () => {
    // Un teclado de 88 (maxKey más bajo que 127): recorta ahí, no a 127.
    expect(transposePatches([nota('a', { key: 5 })], new Set(['a']), -12, 87)).toEqual([
      { id: 'a', key: 0 },
    ]);
    expect(transposePatches([nota('a', { key: 80 })], new Set(['a']), 12, 87)).toEqual([
      { id: 'a', key: 87 },
    ]);
  });
});
