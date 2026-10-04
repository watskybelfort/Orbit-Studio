/**
 * BUG 017 — `parseProject` aceptaba tipos inválidos en campos aditivos y en las
 * entidades internas.
 *
 * Lo que pasaba: el esqueleto se comprobaba y los campos aditivos se rellenaban
 * con `??=` sin mirar qué traían. `patternOrder: 42` pasaba; un patrón `null`
 * pasaba y compilaba en silencio; `channels: null` reventaba después, dentro del
 * compilador, con un TypeError que no nombraba el campo. Aquí se decide qué es
 * estructura (falla por su nombre) y qué es contenido musical (se sanea).
 */

import { describe, expect, it } from 'vitest';
import {
  createChannel,
  createEmptyProject,
  findProjectProblems,
  keepExistingIds,
  parseProject,
  serializeProject,
} from '../src/index';

/** Copia del proyecto vacío como JSON plano, para mutar campos y volver a parsear. */
function base(): Record<string, unknown> {
  return JSON.parse(serializeProject(createEmptyProject())) as Record<string, unknown>;
}

function parse(mut: (p: Record<string, unknown>) => void): ReturnType<typeof parseProject> {
  const data = base();
  mut(data);
  return parseProject(JSON.stringify(data));
}

describe('017 · findProjectProblems ve lo que el motor no puede leer', () => {
  it.each(['title', 'author', 'comments'])('valida meta.%s dentro del archivo, no solo en setMeta', (field) => {
    expect(() => parse((p) => { (p.meta as Record<string, unknown>)[field] = { corrupt: true }; }))
      .toThrow(`meta.${field}`);
    expect(() => parse((p) => { delete (p.meta as Record<string, unknown>)[field]; }))
      .toThrow(`meta.${field}`);
  });

  it('una lista de orden que no es lista', () => {
    const data = base();
    data.patternOrder = 42;
    const problemas = findProjectProblems(data);
    expect(problemas).toEqual([{ field: 'patternOrder', expected: 'una lista de ids' }]);
  });

  it('un id que no es string dentro de la lista, con su posición', () => {
    const data = base();
    data.channelOrder = ['a', 7];
    expect(findProjectProblems(data)).toEqual([
      { field: 'channelOrder[1]', expected: 'un id (string)' },
    ]);
  });

  it('una entidad que no es entidad, nombrando pool y clave', () => {
    const data = base();
    const patterns = data.patterns as Record<string, unknown>;
    patterns['malo'] = null;
    patterns['otro'] = 3;
    expect(findProjectProblems(data)).toEqual([
      { field: 'patterns.malo', expected: 'una entidad (objeto)' },
      { field: 'patterns.otro', expected: 'una entidad (objeto)' },
    ]);
  });

  it('una pista de mezcla que no es pista', () => {
    const data = base();
    (data.mixer as unknown[])[2] = null;
    expect(findProjectProblems(data)).toEqual([
      { field: 'mixer[2]', expected: 'una entidad (objeto)' },
    ]);
  });

  it('meta y timeSig son mapas de datos: sus valores no son entidades', () => {
    const data = base();
    data.meta = { title: 'x', author: '', comments: '' };
    data.timeSig = { num: 4, den: 4 };
    expect(findProjectProblems(data)).toEqual([]);
  });

  it('keepExistingIds deja solo los ids que existen de verdad', () => {
    const pool = { a: 1, b: 2 };
    expect(keepExistingIds(['b', 'fantasma', 'a'], pool)).toEqual(['b', 'a']);
    expect(keepExistingIds([3, 'a'], pool)).toEqual(['a']);
  });
});

describe('017 · parseProject dice qué está mal y por su nombre', () => {
  it('patternOrder numérico: se rechaza nombrando el campo', () => {
    expect(() => parse((p) => (p.patternOrder = 42))).toThrow(/patternOrder.*lista de ids/);
  });

  it('channelOrder con un número dentro: se rechaza con la posición', () => {
    expect(() => parse((p) => (p.channelOrder = [7]))).toThrow(/channelOrder\[0\]/);
  });

  it('un patrón null: se rechaza en vez de compilar en silencio', () => {
    expect(() => parse((p) => ((p.patterns as Record<string, unknown>)['x'] = null))).toThrow(
      /patterns\.x.*entidad/,
    );
  });

  it('channels null: falla aquí y no dentro del compilador', () => {
    expect(() => parse((p) => (p.channels = null))).toThrow(/"channels"/);
  });

  it('con varios problemas, el mensaje cuenta cuántos hay', () => {
    expect(() =>
      parse((p) => {
        p.patternOrder = 42;
        ((p.patterns as Record<string, unknown>)['x'] = null);
        ((p.mixer as unknown[])[0] = 'nada');
      }),
    ).toThrow(/patternOrder.*y 2 problema\(s\) más/);
  });
});

describe('017 · los cuatro casos de la sonda de review', () => {
  // Los cuatro que la sonda de revisión medió como ACEPTADOS en 8a3037e.
  it('samples: 42 — un pool que no es pool (ya no se "adopta" a vacío)', () => {
    expect(() => parse((p) => (p.samples = 42))).toThrow(/samples" un mapa de entidades/);
    // El validador a pelo ve el tipo, que es donde estaba el agujero: adoptar
    // antes de juzgar convertía el 42 en un pool vacío e invisible.
    expect(findProjectProblems({ samples: 42 })).toEqual([
      { field: 'samples', expected: 'un mapa de entidades' },
    ]);
  });

  it('lfos: [] es válido (lista vacía) pero lfos: 42 no', () => {
    expect(() => parse((p) => (p.lfos = []))).not.toThrow();
    expect(() => parse((p) => (p.lfos = 42))).toThrow(/lfos" un mapa de entidades/);
  });

  it("swing: 'wrong' se rechaza: el swing llegaba a swungStart y volvía NaN", () => {
    expect(() => parse((p) => (p.swing = 'wrong'))).toThrow(/swing" un número/);
    // Un NaN escrito a mano, al serializar, llega como null: por el archivo se ve
    // "no es null". El NaN de verdad se comprueba en el validador, sin pasar por JSON.
    expect(() => parse((p) => (p.swing = Number.NaN))).toThrow(/swing" no es null/);
    expect(findProjectProblems({ swing: Number.NaN })).toEqual([
      { field: 'swing', expected: 'un número' },
    ]);
  });

  it('pattern.notes: null se rechaza en vez de reventar al recorrer', () => {
    expect(() =>
      parse((p) => {
        const patron = Object.values(p.patterns as Record<string, unknown>)[0] as Record<
          string,
          unknown
        >;
        patron.notes = null;
      }),
    ).toThrow(/notes" no es null/);
  });
});

describe('017 · los números que van al motor también se miran', () => {
  it('una nota con duración NaN dentro de un patrón por lo demás válido', () => {
    expect(() =>
      parse((p) => {
        const patron = Object.values(p.patterns as Record<string, unknown>)[0] as Record<
          string,
          Record<string, unknown[]>
        >;
        const notas = patron.notes as Record<string, unknown[]>;
        notas[Object.keys(notas)[0]!] = [
          { id: 'n1', start: 0, duration: 'larga', key: 60, velocity: 1, pan: 0, slide: false },
        ];
      }),
    ).toThrow(/duration" un número/);
  });

  it('params de canal con un valor que no es número', () => {
    const channel = createChannel('synth', 0);
    expect(() =>
      parse((p) => {
        p.channels = { [channel.id]: channel };
        (p.channelOrder as string[]).push(channel.id);
        ((p.channels as Record<string, { params: Record<string, unknown> }>)[channel.id]!).params.cutoff = 'lento';
      }),
    ).toThrow(/params\.cutoff" un número/);
  });

  it('un clip con start string: la línea de tiempo no admite NaN', () => {
    expect(() =>
      parse((p) => {
        p.clips = { c1: { id: 'c1', kind: 'pattern', playlistTrackId: 't', start: 'x', length: 4 } };
      }),
    ).toThrow(/clips\.c1\.start" un número/);
  });
});

describe('017 · los casos de la tercera sonda de review', () => {
  // `clip.points = {}` paraba al compilar con 'points is not iterable'; el `routeTo`
  // que yo migraba a null en un INSERT se comia el audio entero; y `Pattern.length`
  // de tipo raro pasaba porque faltaba en la tabla.
  it('un clip de automation con `points` que no es lista', () => {
    expect(() =>
      parse((p) => {
        p.clips = {
          c1: {
            id: 'c1', kind: 'automation', playlistTrackId: 't1', start: 0, length: 4,
            muted: false, target: { kind: 'channel', channelId: 'c1', param: 'volume' },
            points: {},
          },
        };
      }),
    ).toThrow(/points" una lista/);
  });

  it('un punto de automation con `time` de tipo raro, o sin tension', () => {
    const conPoints = (points: unknown) =>
      parse((p) => {
        p.clips = {
          c1: {
            id: 'c1', kind: 'automation', playlistTrackId: 't1', start: 0, length: 4,
            muted: false, target: { kind: 'channel', channelId: 'c1', param: 'volume' },
            points,
          },
        };
      });
    expect(() => conPoints([{ id: 'a1', time: 'x', value: 0, tension: 0 }])).toThrow(
      /points\[0\]\.time" un número/,
    );
    expect(() => conPoints([{ id: 'a1', time: 0, value: 0 }])).toThrow(/tension" está/);
    expect(() =>
      conPoints([{ id: 'a1', time: 0, value: 0, tension: 0 }]),
    ).not.toThrow();
  });

  it('Pattern.length de tipo raro ahora se rechaza (no estaba en la tabla)', () => {
    expect(() =>
      parse((p) => {
        const patrones = p.patterns as Record<string, { length: unknown }>;
        const primero = Object.keys(patrones)[0]!;
        (patrones[primero] as { length: unknown }).length =
          'largo';
      }),
    ).toThrow(/length" un número/);
  });

  it('los slots y los envios de una pista se miran por dentro (mix y params son obligatorios)', () => {
    expect(() =>
      parse((p) => {
        const pista = (p.mixer as Record<string, Record<string, unknown>>)[1]!;
        pista.slots = [{ id: 'fx1', kind: 'reverb', enabled: true, params: {} }];
      }),
    ).toThrow(/mix" está/);
    expect(() =>
      parse((p) => {
        const pista = (p.mixer as Record<string, Record<string, unknown>>)[1]!;
        pista.sends = [{ target: 2 }];
      }),
    ).toThrow(/level" está/);
    expect(() =>
      parse((p) => {
        const pista = (p.mixer as Record<string, Record<string, unknown>>)[1]!;
        pista.sends = [{ target: 2, level: 'mucho' }];
      }),
    ).toThrow(/level" un número/);
  });

  it('routeTo ausente en un INSERT se migra a 0, y en el master a null (el audio se queda)', () => {
    // El default que yo puse (null para todos) mandaba el audio de los inserts a
    // ninguna parte: el master se callaba entero. La migración copia la de
    // `createMixerTrack`: master null, insert 0.
    const p = parse((data) => {
      for (const [i, pista] of (data.mixer as Record<string, unknown>[]).entries()) {
        delete pista.routeTo;
        void i;
      }
    });
    expect(p.mixer[0]?.routeTo).toBeNull();
    expect(p.mixer[1]?.routeTo).toBe(0);
    expect(p.mixer[3]?.routeTo).toBe(0);
  });
});

describe('017 · lo que sí se puede abrir sigue abriéndose', () => {
  it('un proyecto recién creado pasa limpio', () => {
    expect(findProjectProblems(base())).toEqual([]);
  });

  it('los campos aditivos ausentes se siguen rellenando', () => {
    const data = base();
    delete data.samples;
    delete data.lfos;
    delete data.sections;
    delete data.channelGroups;
    delete data.inputRoutes;
    delete data.swing;
    const p = parseProject(JSON.stringify(data));
    expect(p.samples).toEqual({});
    expect(p.lfos).toEqual({});
    expect(p.swing).toBe(0);
    expect(Object.getPrototypeOf(p.samples)).toBe(null);
  });

  it('los campos aditivos vacíos (null) también: se rellenan', () => {
    const p = parse((data) => {
      data.samples = null;
      data.patternOrder = null;
    });
    expect(Object.keys(p.patterns).length).toBeGreaterThan(0);
  });

  it('una lista de orden que apunta a un patrón inexistente: se poda', () => {
    const data = base();
    const real = (data.patternOrder as string[])[0] as string;
    data.patternOrder = [real, 'fantasma', real];
    const p = parseProject(JSON.stringify(data));
    expect(p.patternOrder).toEqual([real, real]);
  });

  it('una lista de orden vacía con el pool lleno se rehace: el patrón no se pierde', () => {
    const p = parse((data) => (data.patternOrder = []));
    expect(Object.keys(p.patterns).length).toBeGreaterThan(0);
    expect(p.patternOrder).toEqual(Object.keys(p.patterns));
  });

  it('el rack vacío se rehace igual (un canal suelto no puede desaparecer)', () => {
    const channel = createChannel('synth', 0);
    const p = parse((data) => {
      data.channels = { [channel.id]: channel };
      data.channelOrder = [];
    });
    expect(p.channelOrder).toEqual([channel.id]);
  });

  it('el orden de carpetas vacío NO se rehace: sin carpetas es un proyecto válido', () => {
    const p = parse((data) => {
      data.channelGroups = {
        g1: { id: 'g1', name: 'G', color: 'rojo', collapsed: false, busTrack: 3 },
      };
      data.channelGroupOrder = [];
    });
    expect(p.channelGroupOrder).toEqual([]);
  });

  it('los huecos (null) de los slots siguen valiendo: eso es un slot vacío', () => {
    const channel = createChannel('synth', 0);
    expect(() =>
      parse((p) => {
        p.channels = { [channel.id]: channel };
        (p.channelOrder as string[]).push(channel.id);
        ((p.channels as Record<string, { fx: unknown[] }>)[channel.id]!).fx = [null, null];
      }),
    ).not.toThrow();
  });

  it('routeTo del master puede ser null: el modelo lo admite', () => {
    expect(() =>
      parse((p) => ((p.mixer as Record<string, unknown>[])[0]!.routeTo = null)),
    ).not.toThrow();
  });

  it('los .orbit antiguos se abren igual: lo que les faltaba se migra con defaults', () => {
    // El legado real: un .orbit de antes de v1.1 no traía `fx` en los canales, ni
    // `eq*`/`routeTo`/`sends` en las pistas, ni los aditivos del proyecto. Eso se
    // RELLENA con defaults explícitos, no se rechaza: son campos que llegaron
    // después y su ausencia significa "sin fx", no "archivo roto".
    const channel = createChannel('synth', 0);
    const p = parse((data) => {
      data.channels = { [channel.id]: channel };
      (data.channelOrder as string[]).push(channel.id);
      delete (data.channels as Record<string, Record<string, unknown>>)[channel.id]!.fx;
      for (const pista of data.mixer as Record<string, unknown>[]) {
        delete pista.eqLow;
        delete pista.eqMid;
        delete pista.eqHigh;
        delete pista.routeTo;
        delete pista.sends;
      }
      for (const aditivo of ['samples', 'lfos', 'sections', 'channelGroups', 'inputRoutes', 'swing']) {
        delete data[aditivo];
      }
    });
    expect(Object.keys(p.channels)).toHaveLength(1);
    expect(p.mixer[0]?.eqLow).toBe(0);
    expect(p.mixer[0]?.routeTo).toBeNull();
    expect(p.mixer[0]?.sends).toEqual([]);
  });

  it('un patrón sin notes, o un canal sin volume: se rechazan (no son campos nuevos)', () => {
    // Antes los daba por "opcionales"; no lo son: el motor recorre `notes` y
    // multiplica por `volume`, así que su ausencia es un TypeError y un NaN.
    expect(() =>
      parse((p) => {
        const patron = Object.values(p.patterns as Record<string, unknown>)[0] as Record<
          string,
          unknown
        >;
        delete patron.notes;
      }),
    ).toThrow(/notes" está/);
    expect(() =>
      parse((p) => {
        const canal = createChannel('synth', 0);
        p.channels = { [canal.id]: canal };
        (p.channelOrder as string[]).push(canal.id);
        delete (p.channels as Record<string, Record<string, unknown>>)[canal.id]!.volume;
      }),
    ).toThrow(/volume" está/);
  });

  it('timeSig con num de string, y un mix de slot de mixer de tipo raro', () => {
    expect(() =>
      parse((p) => ((p.timeSig as Record<string, unknown>).num = 'wrong')),
    ).toThrow(/timeSig\.num" un número/);
    expect(() =>
      parse((p) => {
        const pista = (p.mixer as Record<string, Record<string, unknown>>)[1]!;
        pista.slots = [{ id: 's1', kind: 'reverb', enabled: true, mix: 'wrong', params: {} }];
      }),
    ).toThrow(/slots\[0\]\.mix" un número/);
  });

  it('un volumen de string en un canal: se rechaza (antes pasaba y salía NaN)', () => {
    // Sonda de review: `channel.volume = 'loud'` pasaba el esqueleto, compilaba y
    // `render.left` venía con NaN. El motor NO acota esto, así que la afirmación
    // anterior ("el motor lo acota donde lo usa") era falsa: es estructura.
    const channel = createChannel('synth', 0);
    expect(() =>
      parse((data) => {
        data.channels = { [channel.id]: channel };
        (data.channelOrder as string[]).push(channel.id);
        ((data.channels as Record<string, { volume: unknown }>)[channel.id]!).volume = 'loud';
      }),
    ).toThrow(new RegExp(`channels\\.${channel.id}\\.volume`));
  });
});
