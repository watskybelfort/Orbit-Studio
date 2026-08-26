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
import { zonesForNote } from '@orbit/core';
import {
  describeKeymapDrop,
  getDragEntries,
  getDragEntry,
  keymapOf,
  mapLimited,
  setDragEntries,
  setDragEntry,
  SOUND_MIME,
  SOUNDS_MIME,
  type LoadedPart,
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

describe('un instrumento del pack cae repartido por tecla Y por fuerza', () => {
  /** Una grabación del manifest, con su nota y su franja. */
  const toma = (
    file: string,
    rootMidi: number,
    vel?: { velLow: number; velHigh: number },
  ): LoadedPart => ({
    sample: { file, rootMidi, durationSec: 3, ...(vel ?? {}) },
    id: file.replace(/\.wav$/, ''),
    bytes: new ArrayBuffer(0),
  });

  const entrada = { id: 'instrumentos/piano', name: 'Piano' } as SoundEntry;
  const P = { velLow: 0, velHigh: 0.5 };
  const F = { velLow: 0.500001, velHigh: 1 };

  it('las dos capas de una nota comparten teclas y se separan por velocidad', () => {
    const zones = keymapOf({
      entry: entrada,
      parts: [
        toma('a-48-p.wav', 48, P), toma('a-48.wav', 48, F),
        toma('a-60-p.wav', 60, P), toma('a-60.wav', 60, F),
      ],
    })!;
    expect(zones).toHaveLength(4);
    const de = (root: number) => zones.filter((z) => z.keyRoot === root);
    for (const root of [48, 60]) {
      const [suave, fuerte] = de(root).sort((a, b) => a.velLow - b.velLow);
      // Mismo trozo de teclado: son la misma nota grabada dos veces, no dos
      // notas. Repartir por ZONA en vez de por raíz las dejaba peleándose el
      // punto medio y con el rango del revés.
      expect(suave!.keyLow).toBe(fuerte!.keyLow);
      expect(suave!.keyHigh).toBe(fuerte!.keyHigh);
      // Y la fuerza las separa sin dejar hueco ni solape.
      expect(suave!.velLow).toBe(0);
      expect(fuerte!.velHigh).toBe(1);
      expect(fuerte!.velLow).toBeGreaterThan(suave!.velHigh);
      expect(fuerte!.velLow - suave!.velHigh).toBeLessThan(0.01);
    }
  });

  it('ninguna tecla y ninguna fuerza se quedan sin zona', () => {
    const zones = keymapOf({
      entry: entrada,
      parts: [
        toma('a-48-p.wav', 48, P), toma('a-48.wav', 48, F),
        toma('a-60-p.wav', 60, P), toma('a-60.wav', 60, F),
        toma('a-72-p.wav', 72, P), toma('a-72.wav', 72, F),
      ],
    })!;
    for (const key of [0, 30, 53, 54, 60, 66, 67, 90, 127]) {
      for (const vel of [0, 0.3, 0.5, 0.500001, 0.7, 1]) {
        const suenan = zonesForNote(zones, key, vel);
        expect(suenan.length, `tecla ${key} a velocidad ${vel}`).toBe(1);
      }
    }
  });

  it('un pack sin capas declaradas se reparte solo por teclas, como siempre', () => {
    // Los packs del usuario y cualquier pack anterior a las capas: la zona
    // coge la fuerza entera y no cambia nada de lo que ya funcionaba.
    const zones = keymapOf({
      entry: entrada,
      parts: [toma('a-48.wav', 48), toma('a-60.wav', 60)],
    })!;
    expect(zones).toHaveLength(2);
    for (const z of zones) {
      expect(z.velLow).toBe(0);
      expect(z.velHigh).toBe(1);
    }
  });

  it('un sonido de una sola grabación no lleva keymap', () => {
    expect(keymapOf({ entry: entrada, parts: [toma('a.wav', 60)] })).toBeUndefined();
  });
});
