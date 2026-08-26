/**
 * El manifest: lo que el browser lee para saber qué hay en un pack.
 *
 * Se prueba entero y no solo lo nuevo porque `loadManifest` es la única puerta
 * por la que entra el pack: lo que se le cuele mal aquí sale por el otro lado
 * como un sonido que no suena, un instrumento con agujeros en el teclado, o
 * una entrada duplicada que pisa a otra. Y el archivo lo puede haber escrito
 * el generador, un pack del usuario, o una versión anterior de la app.
 */

import { describe, expect, it } from 'vitest';
import {
  dynamicLabel,
  entrySamples,
  loadManifest,
  sampleIdFor,
  DEFAULT_ROOT_MIDI,
  type SoundEntry,
} from '../src/index';

function manifest(entries: unknown[]): string {
  return JSON.stringify({
    version: '1.0.0',
    pack: 'Prueba',
    generatedWith: 'test',
    entries,
  });
}

const UNA = {
  id: 'instrumentos/piano',
  name: 'Piano',
  category: 'instrumentos',
  file: 'instrumentos/piano-c4.wav',
  tags: ['piano'],
  durationSec: 3,
};

describe('lo mínimo que tiene que cumplir un manifest', () => {
  it('carga uno correcto', () => {
    const m = loadManifest(manifest([UNA]));
    expect(m.pack).toBe('Prueba');
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]!.id).toBe('instrumentos/piano');
  });

  it('rechaza lo que no es JSON, o no es un objeto, o no trae entradas', () => {
    expect(() => loadManifest('{roto')).toThrow(/no es JSON/);
    // Un array también es `typeof 'object'`: hay que descartarlo aparte.
    expect(() => loadManifest('[]')).toThrow(/objeto/);
    expect(() => loadManifest('null')).toThrow(/objeto/);
    expect(() => loadManifest('"soy un texto"')).toThrow(/objeto/);
    expect(() => loadManifest('{"version":"1","pack":"p","generatedWith":"g"}')).toThrow(/entries/);
  });

  it('rechaza ids repetidos', () => {
    // Dos entradas con el mismo id se pisan: la segunda gana y la primera
    // desaparece del browser sin que nadie lo diga.
    expect(() => loadManifest(manifest([UNA, UNA]))).toThrow(/duplicado/);
  });

  it('rechaza una categoría que el browser no sabe pintar', () => {
    expect(() => loadManifest(manifest([{ ...UNA, category: 'inventada' }]))).toThrow(/categoría/);
  });

  it('se queda solo con los campos que conoce', () => {
    const m = loadManifest(manifest([{ ...UNA, colorFavorito: 'azul' }]));
    expect(m.entries[0]).not.toHaveProperty('colorFavorito');
  });
});

describe('instrumentos multisample en el manifest', () => {
  const multi = {
    ...UNA,
    samples: [
      { file: 'instrumentos/piano-c3.wav', rootMidi: 36, durationSec: 3.2 },
      { file: 'instrumentos/piano-c4.wav', rootMidi: 48, durationSec: 3 },
      { file: 'instrumentos/piano-c5.wav', rootMidi: 60, durationSec: 2.6 },
    ],
  };

  it('carga las grabaciones con su nota', () => {
    const entry = loadManifest(manifest([multi])).entries[0]!;
    expect(entry.samples).toHaveLength(3);
    expect(entry.samples!.map((s) => s.rootMidi)).toEqual([36, 48, 60]);
  });

  it('un `samples` roto tira el manifest en vez de dejar medio instrumento', () => {
    // Media entrada válida deja un instrumento con agujeros en el teclado, y
    // eso solo se descubre tocándolo. Mejor no cargar y decir por qué.
    const roto = (samples: unknown) => () => loadManifest(manifest([{ ...UNA, samples }]));
    expect(roto([])).toThrow(/no vacío/);
    expect(roto('no soy un array')).toThrow(/no vacío/);
    expect(roto([{ rootMidi: 60, durationSec: 1 }])).toThrow(/file/);
    expect(roto([{ file: 'a.wav', durationSec: 1 }])).toThrow(/rootMidi/);
    expect(roto([{ file: 'a.wav', rootMidi: 999, durationSec: 1 }])).toThrow(/rootMidi/);
    expect(roto([{ file: 'a.wav', rootMidi: -1, durationSec: 1 }])).toThrow(/rootMidi/);
    expect(roto([{ file: 'a.wav', rootMidi: 60 }])).toThrow(/durationSec/);
    expect(roto([{ file: 'a.wav', rootMidi: 60, durationSec: 0 }])).toThrow(/durationSec/);
  });

  it('sin `samples` la entrada sigue siendo válida', () => {
    expect(loadManifest(manifest([UNA])).entries[0]!.samples).toBeUndefined();
  });
});

describe('entrySamples', () => {
  it('una entrada normal es una grabación en el do de referencia', () => {
    const s = entrySamples(UNA as SoundEntry);
    expect(s).toEqual([
      { file: 'instrumentos/piano-c4.wav', rootMidi: DEFAULT_ROOT_MIDI, durationSec: 3 },
    ]);
  });

  it('una multisample devuelve las suyas', () => {
    const entry = {
      ...UNA,
      samples: [{ file: 'a.wav', rootMidi: 48, durationSec: 1 }],
    } as SoundEntry;
    expect(entrySamples(entry)).toBe(entry.samples);
  });

  it('un `samples` vacío se trata como si no estuviera', () => {
    expect(entrySamples({ ...UNA, samples: [] } as SoundEntry)).toHaveLength(1);
  });
});

describe('sampleIdFor', () => {
  it('la grabación principal CONSERVA el id de la entrada', () => {
    // Es lo que hace que un proyecto guardado antes de que esto existiera siga
    // encontrando su sample, y que las audiciones y los clips no cambien.
    expect(sampleIdFor(UNA as SoundEntry, UNA.file)).toBe('instrumentos/piano');
  });

  it('las demás estrenan id, y es su ruta sin extensión', () => {
    expect(sampleIdFor(UNA as SoundEntry, 'instrumentos/piano-c3.wav')).toBe(
      'instrumentos/piano-c3',
    );
  });

  it('un pack del usuario conserva su esquema en el id', () => {
    const user = { ...UNA, id: 'user:C:/mis/piano.wav' } as SoundEntry;
    const id = sampleIdFor(user, 'C:/mis/piano-c3.wav');
    expect(id.startsWith('user:')).toBe(true);
    expect(id).not.toBe(user.id);
  });

  it('dos grabaciones distintas nunca comparten id', () => {
    const files = ['instrumentos/piano-c3.wav', 'instrumentos/piano-c5.wav', UNA.file];
    const ids = files.map((f) => sampleIdFor(UNA as SoundEntry, f));
    expect(new Set(ids).size).toBe(3);
  });
});

describe('las capas de fuerza del manifest', () => {
  const conCapas = (velLow: unknown, velHigh: unknown): string =>
    manifest([
      {
        ...UNA,
        samples: [{ file: 'a.wav', rootMidi: 60, durationSec: 3, velLow, velHigh }],
      },
    ]);

  it('lee la franja cuando viene', () => {
    const m = loadManifest(conCapas(0, 0.5));
    expect(m.entries[0]!.samples![0]).toMatchObject({ velLow: 0, velHigh: 0.5 });
  });

  it('sin franja, la grabación cubre la fuerza entera (packs de una capa)', () => {
    const m = loadManifest(
      manifest([{ ...UNA, samples: [{ file: 'a.wav', rootMidi: 60, durationSec: 3 }] }]),
    );
    const s = m.entries[0]!.samples![0]!;
    expect(s.velLow).toBeUndefined();
    expect(s.velHigh).toBeUndefined();
    expect(dynamicLabel(s)).toBeUndefined();
  });

  it('rechaza una franja fuera de 0..1 o que no es número', () => {
    expect(() => loadManifest(conCapas(-0.1, 0.5))).toThrow(/velLow/);
    expect(() => loadManifest(conCapas(0, 1.5))).toThrow(/velHigh/);
    expect(() => loadManifest(conCapas(0, 'medio'))).toThrow(/velHigh/);
    expect(() => loadManifest(conCapas(0, Number.NaN))).toThrow(/velHigh/);
  });

  it('rechaza la franja del revés', () => {
    // Del revés no es "casi bien": es una capa que no dispara NUNCA, y eso en
    // el teclado es un instrumento mudo a esa fuerza.
    expect(() => loadManifest(conCapas(0.8, 0.2))).toThrow(/del revés/);
  });
});

describe('dynamicLabel', () => {
  it('nombra la capa por el centro de su franja', () => {
    expect(dynamicLabel({ file: 'a', rootMidi: 60, durationSec: 1, velLow: 0, velHigh: 0.5 }))
      .toBe('p');
    expect(dynamicLabel({ file: 'a', rootMidi: 60, durationSec: 1, velLow: 0.5, velHigh: 1 }))
      .toBe('f');
  });

  it('con tres capas sale la de en medio, sin tocar nada', () => {
    // La notación por centro es justo lo que hace que esto siga valiendo si el
    // pack pasa de dos capas a tres.
    const tres = [
      { velLow: 0, velHigh: 1 / 3 },
      { velLow: 1 / 3, velHigh: 2 / 3 },
      { velLow: 2 / 3, velHigh: 1 },
    ].map((v) => dynamicLabel({ file: 'a', rootMidi: 60, durationSec: 1, ...v }));
    expect(tres).toEqual(['p', 'mf', 'f']);
  });
});
