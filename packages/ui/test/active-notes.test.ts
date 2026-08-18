/**
 * Notas activas: la unión de lo que tienes pulsado y lo que el kernel dice que
 * suena. Lo que se prueba es justo lo que se ve en pantalla: que una tecla
 * pulsada se encienda al instante (sin esperar al motor), que no se apague
 * porque el kernel le robe la voz, y que el Set publicado NO cambie de
 * referencia si el contenido es el mismo (o los teclados se repintarían 20
 * veces por segundo).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const previewSpy = vi.fn();
vi.mock('../src/state/app', () => ({ engine: { previewNote: previewSpy } }));

const {
  clearHeldNotes,
  packNote,
  previewNote,
  setKernelNotes,
  useActiveNotesStore,
} = await import('../src/state/active-notes');

/** Teclas del canal 0 que hay publicadas ahora mismo. */
function keys(): number[] {
  return [...useActiveNotesStore.getState().notes]
    .filter((p) => p >> 8 === 0)
    .map((p) => p & 0xff)
    .sort((a, b) => a - b);
}

beforeEach(() => {
  previewSpy.mockClear();
  clearHeldNotes();
  setKernelNotes(undefined);
});

describe('notas activas', () => {
  it('packNote empaqueta canal y tecla en 8+8 bits', () => {
    expect(packNote(0, 60)).toBe(60);
    expect(packNote(3, 60)).toBe((3 << 8) | 60);
    expect(packNote(3, 60) >> 8).toBe(3);
  });

  it('la tecla pulsada se enciende sin esperar al kernel y se apaga al soltar', () => {
    previewNote(0, 64, true);
    expect(previewSpy).toHaveBeenCalledWith(0, 64, true);
    expect(keys()).toEqual([64]);

    previewNote(0, 64, false);
    expect(keys()).toEqual([]);
  });

  it('lo que reporta el kernel se suma (secuenciador) y se va solo', () => {
    setKernelNotes(new Uint16Array([60, 67]));
    expect(keys()).toEqual([60, 67]);
    setKernelNotes(new Uint16Array([67]));
    expect(keys()).toEqual([67]);
    setKernelNotes(new Uint16Array([]));
    expect(keys()).toEqual([]);
  });

  it('una tecla que sigues apretando no se apaga aunque el kernel deje de verla', () => {
    previewNote(0, 72, true);
    setKernelNotes(new Uint16Array([72]));
    expect(keys()).toEqual([72]);

    // Robo de voz en el kernel: la tecla sigue pulsada, así que sigue encendida.
    setKernelNotes(new Uint16Array([]));
    expect(keys()).toEqual([72]);

    previewNote(0, 72, false);
    expect(keys()).toEqual([]);
  });

  it('cada canal enciende lo suyo', () => {
    previewNote(2, 60, true);
    const packed = [...useActiveNotesStore.getState().notes];
    expect(packed).toEqual([(2 << 8) | 60]);
    expect(keys()).toEqual([]); // el canal 0 no se entera
  });

  it('el Set no cambia de referencia si el contenido no cambia', () => {
    setKernelNotes(new Uint16Array([60]));
    const first = useActiveNotesStore.getState().notes;
    setKernelNotes(new Uint16Array([60])); // mismo frame, otra vez
    expect(useActiveNotesStore.getState().notes).toBe(first);

    setKernelNotes(new Uint16Array([61]));
    expect(useActiveNotesStore.getState().notes).not.toBe(first);
  });

  it('clearHeldNotes suelta lo que quedara pulsado', () => {
    previewNote(0, 60, true);
    previewNote(0, 64, true);
    clearHeldNotes();
    expect(keys()).toEqual([]);
  });
});
