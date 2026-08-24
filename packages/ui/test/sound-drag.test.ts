/**
 * El arrastre de sonidos del Browser cuando trae MÁS DE UNO.
 *
 * Las tres piezas que se prueban aquí son las que no se ven fallar: un payload
 * que un destino viejo ya no reconoce (el drop deja de funcionar sin decir
 * nada), un lote que se lee de disco en fila india (el drop tarda diez
 * segundos y parece colgado), y un resumen que se calla la mitad de lo que
 * pasó (faltan muestras en el instrumento y no hay forma de saber por qué).
 */

import { describe, expect, it } from 'vitest';
import type { SoundEntry } from '@orbit/sound-library';
import {
  describeKeymapDrop,
  getDragEntries,
  getDragEntry,
  mapLimited,
  setDragEntries,
  setDragEntry,
  SOUND_MIME,
  SOUNDS_MIME,
} from '../src/browser/sound-actions';

/** DataTransfer de mentira: lo justo que usa el arrastre. */
function fakeDataTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    get types() {
      return [...data.keys()];
    },
    setData(type: string, value: string) {
      data.set(type, value);
    },
    getData(type: string) {
      return data.get(type) ?? '';
    },
  } as unknown as DataTransfer;
}

function entry(id: string): SoundEntry {
  return {
    id,
    name: id,
    category: 'instrumentos',
    file: `instrumentos/${id}.wav`,
    tags: [],
    durationSec: 1,
  };
}

describe('payload del arrastre', () => {
  it('un sonido suelto viaja como siempre', () => {
    const dt = fakeDataTransfer();
    setDragEntry(dt, entry('uno'));
    expect(getDragEntry(dt)?.id).toBe('uno');
    expect(getDragEntries(dt).map((e) => e.id)).toEqual(['uno']);
  });

  it('un grupo viaja entero y en orden', () => {
    const dt = fakeDataTransfer();
    setDragEntries(dt, [entry('a'), entry('b'), entry('c')]);
    expect(getDragEntries(dt).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('un grupo SIGUE trayendo el MIME de siempre, con la primera dentro', () => {
    // Es lo que mantiene vivos los destinos que no saben de grupos: en
    // `dragover` el navegador solo deja ver los TIPOS, así que todos deciden si
    // aceptan el drop mirando si está `SOUND_MIME`. Si un arrastre múltiple
    // dejara de ponerlo, soltarlo no haría nada y no habría error que mirar.
    const dt = fakeDataTransfer();
    setDragEntries(dt, [entry('a'), entry('b')]);
    expect(dt.types).toContain(SOUND_MIME);
    expect(dt.types).toContain(SOUNDS_MIME);
    expect(getDragEntry(dt)?.id).toBe('a');
  });

  it('un arrastre vacío no ensucia el portapapeles de arrastre', () => {
    const dt = fakeDataTransfer();
    setDragEntries(dt, []);
    expect(dt.types).toEqual([]);
    expect(getDragEntries(dt)).toEqual([]);
  });

  it('un payload de grupo roto cae a la entrada suelta en vez de perderlo todo', () => {
    const dt = fakeDataTransfer();
    setDragEntry(dt, entry('uno'));
    dt.setData(SOUNDS_MIME, '{esto no es JSON');
    expect(getDragEntries(dt).map((e) => e.id)).toEqual(['uno']);
  });

  it('sin nada nuestro dentro, no hay entradas', () => {
    const dt = fakeDataTransfer();
    dt.setData('text/plain', 'hola');
    expect(getDragEntries(dt)).toEqual([]);
    expect(getDragEntry(dt)).toBeNull();
  });
});

describe('mapLimited', () => {
  it('devuelve los resultados EN ORDEN aunque acaben desordenados', () => {
    // El orden es el que decide qué muestra va en qué tecla: si el lote vuelve
    // barajado, el piano queda con las notas cambiadas de sitio.
    const items = [30, 5, 20, 1, 10];
    return mapLimited(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    }).then((out) => expect(out).toEqual(items));
  });

  it('no corre más de `limit` a la vez', async () => {
    let running = 0;
    let peak = 0;
    await mapLimited(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('una lista vacía no se queda esperando', async () => {
    expect(await mapLimited([], 4, async () => 1)).toEqual([]);
  });

  it('un límite absurdo no rompe nada', async () => {
    expect(await mapLimited([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6]);
    expect(await mapLimited([1, 2, 3], 99, async (n) => n * 2)).toEqual([2, 4, 6]);
  });
});

describe('lo que se le cuenta a quien acaba de soltar treinta muestras', () => {
  it('lo normal: entraron todas', () => {
    expect(describeKeymapDrop({ added: 12, unreadable: [], dropped: 0 })).toBe(
      '12 muestras al keymap.',
    );
    expect(describeKeymapDrop({ added: 1, unreadable: [], dropped: 0 })).toBe(
      '1 muestra al keymap.',
    );
  });

  it('cuenta las tres cosas A LA VEZ', () => {
    // En un drop grande pasan las tres. Decir solo la primera deja muestras
    // desaparecidas sin explicación, y eso se descubre tocando y encontrando
    // huecos en el teclado.
    const texto = describeKeymapDrop({
      added: 20,
      unreadable: ['a.wav', 'b.wav'],
      dropped: 2,
    });
    expect(texto).toContain('20 muestras');
    expect(texto).toContain('a.wav');
    expect(texto).toContain('b.wav');
    expect(texto).toContain('2 no cabían');
  });

  it('con muchos nombres ilegibles resume en vez de escupir una lista infinita', () => {
    const texto = describeKeymapDrop({
      added: 0,
      unreadable: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      dropped: 0,
    });
    expect(texto).toContain('de 7:');
    expect(texto).toContain('a, b, c, d');
    expect(texto).toContain('y 3 más');
    expect(texto).not.toContain('e, f, g');
  });

  it('cuando no entra nada, lo dice', () => {
    expect(describeKeymapDrop({ added: 0, unreadable: [], dropped: 0 })).toBe(
      'No ha entrado ninguna muestra.',
    );
  });
});
