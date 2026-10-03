/**
 * BUG 016 — contaminación de `Object.prototype` por ids heredados.
 *
 * Los ids de entidad son CLAVES de pools que son objetos planos. Con el pool
 * normal, `project.clips['__proto__']` devuelve el PROTOTIPO en vez de
 * `undefined`, así que un `patchClips` con ese id pasaba el `if (!clip) continue`
 * y `Object.assign` escribía encima de `Object.prototype` para todo el proceso:
 * lo que se veía era `({}).start === 9` en objetos ajenos al proyecto, con solo
 * un comando remoto (invitado incluido). Estos tests fijan las DOS capas:
 * rechazo con nombre en el bus y pools sin prototipo debajo.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createPattern,
  nullPool,
  parseProject,
  serializeProject,
} from '../src/index';

/** Nombres de las propiedades del prototipo global, para afirmar que no cambian. */
function protoFingerprint(): string {
  return Object.getOwnPropertyNames(Object.prototype).sort().join(',');
}

/** ¿El `Object.prototype` tiene esta propiedad propia? */
function protoOwn(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

describe('016 · el bus rechaza ids reservados antes de mutar', () => {
  it('patchClips con id "__proto__" no contamina el prototipo', () => {
    const p = createEmptyProject();
    const antes = serializeProject(p);
    const huella = protoFingerprint();

    expect(() =>
      applyCommand(p, { type: 'patchClips', patches: [{ id: '__proto__', start: 9 } as never] }),
    ).toThrow(/__proto__/);

    expect(({} as Record<string, unknown>).start).toBeUndefined();
    expect(protoFingerprint()).toBe(huella);
    // El proyecto tampoco se movió: el rechazo es antes de mutar, no después.
    expect(serializeProject(p)).toBe(antes);
  });

  it('ningún id heredado colado llega a un pool: TODOS, no solo los cinco', () => {
    // La lista sale de `Object.getOwnPropertyNames(Object.prototype)`, así que
    // aquí se prueba contra lo que el runtime tiene de verdad —incluidos los
    // accesores `__defineGetter__` y compañía— más `prototype`.
    const heredados = [...Object.getOwnPropertyNames(Object.prototype), 'prototype'];
    expect(heredados).toContain('__proto__');
    for (const id of heredados) {
      const p = createEmptyProject();
      const antes = serializeProject(p);
      expect(() => applyCommand(p, { type: 'patchClips', patches: [{ id, start: 9 } as never] })).toThrow(
        new RegExp(id),
      );
      expect(serializeProject(p)).toBe(antes);
      expect(protoOwn('start')).toBe(false);
    }
  });

  it('un alta colada se rechaza en el pool, no se cuela como entidad', () => {
    const p = createEmptyProject();
    const channel = { ...createChannel('synth', 0), id: '__proto__' } as never;
    expect(() => applyCommand(p, { type: 'addChannel', channel })).toThrow(/__proto__/);
    expect(Object.keys(p.channels)).toHaveLength(0);
    expect(Object.prototype.hasOwnProperty.call(p.channels, '__proto__')).toBe(false);
  });

  it('también las listas de ids (removeClips y compañía)', () => {
    const p = createEmptyProject();
    const antes = serializeProject(p);
    expect(() => applyCommand(p, { type: 'removeClips', clipIds: ['__proto__'] as never })).toThrow(
      /__proto__/,
    );
    expect(serializeProject(p)).toBe(antes);
  });

  it('también las CLAVES de mapas anidados, no solo los campos de id', () => {
    // `notesByPattern` es un mapa de id de patrón -> notas: el nombre del campo no
    // dice "id", pero sus claves SÍ son ids y se leen como `patterns[clave]`.
    // Antes de este cierre una clave heredada ahí pasaba el chequeo de campos.
    const p = createEmptyProject();
    const channel = createChannel('synth', 0);
    const channelId = channel.id;
    // El comando llega de la red, o sea que es JSON.parse: ahí `'__proto__'` sí
    // es una clave PROPIA (en un literal de JS sería el prototipo, que es otro
    // bug entero y no el que se está cerrando).
    const notesByPattern = JSON.parse('{"__proto__":[]}') as Record<string, unknown>;
    const cmd = JSON.parse(JSON.stringify({ type: 'addChannel', channel, notesByPattern })) as never;
    expect(Object.prototype.hasOwnProperty.call(notesByPattern, '__proto__')).toBe(true);
    expect(() => applyCommand(p, cmd)).toThrow(/__proto__/);
    expect(p.channels[channelId]).toBeUndefined();
    expect(({} as Record<string, unknown>).length).toBeUndefined();
  });

  it('un payload anidado de verdad se recorre entero', () => {
    // clip -> pattern -> notes -> note: cuatro niveles. El rechazo tiene que
    // ver el id de la nota del fondo, no solo el del comando.
    const p = createEmptyProject();
    const cmd = {
      type: 'addClips',
      clips: [
        {
          id: 'clip1',
          trackId: 't1',
          start: 0,
          pattern: {
            id: 'pat1',
            notes: [{ id: '__proto__', key: 60, start: 0, length: 1, velocity: 100 }],
          },
        },
      ],
    } as never;
    expect(() => applyCommand(p, cmd)).toThrow(/__proto__/);
    expect(Object.keys(p.clips)).toHaveLength(0);
  });

  it('texto libre con "__proto__" se permite: es dato, no clave', () => {
    // Falso positivo que hay que evitar: un título o un nombre de canal no
    // indexan ningún pool, así que '__proto__' ahí es un nombre legitimo.
    const p = createEmptyProject();
    const channel = { ...createChannel('synth', 0), name: '__proto__' };
    expect(() => applyCommand(p, { type: 'addChannel', channel })).not.toThrow();
    expect(p.channels[channel.id]?.name).toBe('__proto__');

    const q = createEmptyProject();
    expect(() => applyCommand(q, { type: 'setMeta', patch: { title: '__proto__' } })).not.toThrow();
    expect(q.meta.title).toBe('__proto__');

    const r = createEmptyProject();
    const grupo = { id: 'g1', name: 'constructor', color: 'rojo', collapsed: false };
    expect(() => applyCommand(r, { type: 'addChannelGroup', group: grupo })).not.toThrow();
    expect(r.channelGroups.g1?.name).toBe('constructor');
  });

  it('un id reservado bajo batches anidados también se rechaza', () => {
    // El control de review: con el recorrido por niveles, un id metido cuatro
    // batches dentro se quedaba SIN MIRAR y pasaba entero. El recorrido ahora es
    // iterativo y no tiene fondo: se rechaza a la profundidad que venga.
    const p = createEmptyProject();
    const antes = serializeProject(p);
    const cmd = {
      type: 'patchClips',
      batches: [[[[{ id: '__proto__', start: 9 }]]]],
    } as never;
    expect(() => applyCommand(p, cmd)).toThrow(/__proto__/);
    expect(serializeProject(p)).toBe(antes);
  });

  it('pasarse del presupuesto RECHAZA: nunca se deja de validar a medias', () => {
    // El otro control: si el recorrido se rinde cuando es grande, lo que venga
    // después es justo lo que nadie revisa. Uno enorme tiene que FALLAR.
    const p = createEmptyProject();
    const cmd = { type: 'addClips', clips: new Array(30_000).fill({ id: 'c', start: 0 }) } as never;
    expect(() => applyCommand(p, cmd)).toThrow(/demasiado grande para validar/);
  });

  it('un id "__defineGetter__" (accesor heredado) también se rechaza', () => {
    const p = createEmptyProject();
    expect(() =>
      applyCommand(p, { type: 'patchClips', patches: [{ id: '__defineGetter__', start: 9 } as never] }),
    ).toThrow(/__defineGetter__/);
    expect(protoOwn('start')).toBe(false);
  });

  it('un id normal sigue funcionando y su inverso sigue siendo válido', () => {
    const p = createEmptyProject();
    const pattern = createPattern(0);
    applyCommand(p, { type: 'addPattern', pattern });
    const channel = createChannel('synth', 0);
    applyCommand(p, { type: 'addChannel', channel });
    const inverse = applyCommand(p, {
      type: 'patchChannel',
      channelId: channel.id,
      patch: { volume: 0.5 },
    });
    applyCommand(p, inverse);
    expect(p.channels[channel.id]?.volume).toBe(channel.volume);
    expect(Object.keys(p.patterns)).toContain(pattern.id);
  });
});

describe('016 · los pools nacen y se adoptan sin prototipo', () => {
  it('createEmptyProject: los pools no heredan nada', () => {
    const p = createEmptyProject();
    for (const pool of [
      p.channels, p.patterns, p.arrangements, p.playlistTracks, p.clips,
      p.markers, p.sections, p.lfos, p.inputRoutes, p.samples, p.channelGroups,
    ] as object[]) {
      expect(Object.getPrototypeOf(pool)).toBe(null);
    }
    expect((p.clips as Record<string, unknown>)['__proto__']).toBeUndefined();
  });

  it('un .orbit con la clave "__proto__" en un pool abre sin ella', () => {
    const data = JSON.parse(serializeProject(createEmptyProject())) as Record<string, unknown>;
    // En `JSON.parse` la clave "__proto__" es un DATO propio, no el prototipo: el
    // archivo sigue siendo válido y es justo el caso que había que cerrar.
    (data.clips as Record<string, unknown>)['__proto__'] = { id: 'x', start: 4 };
    (data.patterns as Record<string, unknown>)['__proto__'] = { id: 'y', name: 'malo' };
    const p = parseProject(JSON.stringify(data));

    expect(Object.getPrototypeOf(p.clips)).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(p.clips, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(p.patterns, '__proto__')).toBe(false);
    expect(protoOwn('id')).toBe(false);
    expect(({} as Record<string, unknown>).start).toBeUndefined();
  });

  it('un arrangement activo "__proto__" cae al primero de verdad, no al prototipo', () => {
    const data = JSON.parse(serializeProject(createEmptyProject())) as Record<string, unknown>;
    data.activeArrangementId = '__proto__';
    const p = parseProject(JSON.stringify(data));
    expect(p.activeArrangementId).toBe(p.arrangementOrder[0]);
    expect(Object.prototype.hasOwnProperty.call(p.arrangements, p.activeArrangementId)).toBe(true);
  });

  it('nullPool sirve para pools propios y tampoco hereda', () => {
    const pool = nullPool<{ n: number }>();
    pool.a = { n: 1 };
    expect(pool['toString']).toBeUndefined();
    expect(pool['__proto__']).toBeUndefined();
    expect(Object.keys(pool)).toEqual(['a']);
  });
});

describe('016 · ida y vuelta a disco', () => {
  it('serializar y volver a parsear deja el proyecto igual', () => {
    const p = createEmptyProject();
    applyCommand(p, { type: 'addChannel', channel: createChannel('synth', 0) });
    const vuelta = parseProject(serializeProject(p));
    expect(JSON.stringify(vuelta)).toBe(JSON.stringify(p));
    expect(Object.getPrototypeOf(vuelta.channels)).toBe(null);
  });
});