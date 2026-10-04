/**
 * BUG 004 — un lote de parches con el MISMO id deja el undo en un estado que no es el
 * de antes.
 *
 * Con la nota en key 60 y un `patchNotes` de `[{id:'n', key:61}, {id:'n', key:62}]`,
 * la última mutación gana (key 62, que es lo correcto), pero el inverso guardaba los
 * dos valores viejos en orden: al deshacer se aplicaba 60 y luego 61, y la nota se
 * quedaba en key 61. Es decir, después de Ctrl+Z seguía habiendo un cambio musical
 * puesto, y en una sala el otro cliente deshacía lo mismo con otro resultado.
 *
 * El inverso se guarda ahora por entidad: conserva el valor de ANTES de la primera
 * vez que se ve el id. Los lotes que tocan dos veces la misma entidad (arrastrar dos
 * notas superpuestas) siguen siendo válidos, que es lo que no se quiere romper.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  serializeProject,
  type Note,
  type NotePatch,
} from '../src/index';

function conNota(key = 60): { p: ReturnType<typeof createEmptyProject>; patternId: string; channelId: string } {
  const p = createEmptyProject();
  const canal = createChannel('synth', 0, 'C0');
  applyCommand(p, { type: 'addChannel', channel: canal });
  applyCommand(p, {
    type: 'addPattern',
    pattern: { id: 'pt1', name: 'P', color: '#fff', length: 4, notes: {} },
  });
  const nota: Note = { id: 'n1', start: 0, duration: 1, key, velocity: 1, pan: 0, slide: false };
  applyCommand(p, {
    type: 'addNotes',
    patternId: 'pt1',
    channelId: canal.id,
    notes: [nota],
  });
  return { p, patternId: 'pt1', channelId: canal.id };
}

function notas(p: ReturnType<typeof createEmptyProject>, channelId: string): Note[] {
  return p.patterns.pt1?.notes[channelId] ?? [];
}

/** Como viaja por el cable: JSON de ida y vuelta, sin undefined. */
function porJSON<T>(valor: T): T {
  return JSON.parse(JSON.stringify(valor)) as T;
}

describe('004 · un lote con el mismo id se deshace al estado de antes', () => {
  it('notas: dos parches del mismo id, apply + inverse identity', () => {
    const { p, patternId, channelId } = conNota(60);
    const antes = serializeProject(p);

    const inverse = applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 61 },
        { id: 'n1', key: 62 },
      ] as NotePatch[],
    });
    // La última escritura gana: eso no se toca.
    expect(notas(p, channelId)[0]!.key).toBe(62);

    // Y el inverso devuelve al estado de ANTES, no al intermedio.
    applyCommand(p, inverse);
    expect(notas(p, channelId)[0]!.key).toBe(60);
    expect(serializeProject(p)).toBe(antes);
  });

  it('notas: el mismo campo y campos DISTINTOS con el mismo id', () => {
    const { p, patternId, channelId } = conNota(60);
    const antes = serializeProject(p);

    // El id repetido aparece con `key` en el primero y con `velocity` y `key` en el
    // segundo: el inverso tiene que guardar lo de antes de los DOS campos.
    const inverse = applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 61 },
        { id: 'n1', velocity: 0.25, key: 62 },
      ] as NotePatch[],
    });
    expect(notas(p, channelId)[0]).toMatchObject({ key: 62, velocity: 0.25 });

    // Se aplica EL INVERSO QUE DEVOLVIÓ EL BUS. Nada de una restitución escrita a
    // mano: eso no probaría el undo, probaría el bus otra vez con otro parche.
    applyCommand(p, inverse);
    expect(notas(p, channelId)[0]).toMatchObject({ key: 60, velocity: 1 });
    expect(serializeProject(p)).toBe(antes);
  });
  it('notas: tres veces el mismo id, y el inverso también viaja por JSON', () => {
    const { p, patternId, channelId } = conNota(60);
    const antes = serializeProject(p);

    const inverse = porJSON(
      applyCommand(p, {
        type: 'patchNotes',
        patternId,
        channelId,
        patches: [
          { id: 'n1', key: 61 },
          { id: 'n1', key: 62 },
          { id: 'n1', key: 63 },
        ] as NotePatch[],
      }),
    );
    expect(notas(p, channelId)[0]!.key).toBe(63);

    // El inverso es el MISMO comando en local que por el cable: aquí se comprueba que
    // el estado al que vuelve es el de antes y no el intermedio.
    applyCommand(p, inverse);
    expect(notas(p, channelId)[0]!.key).toBe(60);
    expect(serializeProject(p)).toBe(antes);
  });

  it('clips: mismo id repetido en un lote, con el inverso real', () => {
    const p = createEmptyProject();
    applyCommand(p, {
      type: 'addPlaylistTrack',
      track: { id: 't1', arrangementId: p.activeArrangementId, name: 'Pista', color: '#fff', height: 56, muted: false, order: 0 },
    });
    applyCommand(p, {
      type: 'addClips',
      clips: [{ id: 'c1', kind: 'audio', playlistTrackId: 't1', start: 0, length: 4, muted: false, audioOffset: 0 }],
    });
    const antes = serializeProject(p);

    const inverse = applyCommand(p, {
      type: 'patchClips',
      patches: [
        { id: 'c1', start: 2 },
        { id: 'c1', length: 8 },
      ],
    });
    expect(p.clips.c1).toMatchObject({ start: 2, length: 8 });

    applyCommand(p, inverse);
    expect(p.clips.c1).toMatchObject({ start: 0, length: 4 });
    expect(serializeProject(p)).toBe(antes);
  });
  it('secciones: mismo id repetido en un lote, con el inverso real', () => {
    const p = createEmptyProject();
    applyCommand(p, {
      type: 'addSections',
      sections: [{ id: 's1', arrangementId: 'ar1', name: 'Intro', start: 0, length: 8 }],
    });
    const antes = serializeProject(p);

    const inverse = applyCommand(p, {
      type: 'patchSections',
      patches: [
        { id: 's1', start: 4 },
        { id: 's1', length: 16, name: 'B' },
      ],
    });
    expect(p.sections.s1).toMatchObject({ start: 4, length: 16, name: 'B' });

    applyCommand(p, inverse);
    expect(p.sections.s1).toMatchObject({ start: 0, length: 8, name: 'Intro' });
    expect(serializeProject(p)).toBe(antes);
  });
  it('un lote con el mismo id dentro de un batch también deshace bien', () => {
    const { p, patternId, channelId } = conNota(60);
    const antes = serializeProject(p);

    const inverse = applyCommand(p, {
      type: 'batch',
      label: 'mover la nota dos veces',
      commands: [
        { type: 'patchNotes', patternId, channelId, patches: [{ id: 'n1', key: 61 }] as NotePatch[] },
        { type: 'patchNotes', patternId, channelId, patches: [{ id: 'n1', key: 62 }] as NotePatch[] },
      ],
    });
    expect(notas(p, channelId)[0]!.key).toBe(62);
    applyCommand(p, inverse);
    expect(notas(p, channelId)[0]!.key).toBe(60);
    expect(serializeProject(p)).toBe(antes);
  });

  it('sin repetir el id, el inverso conserva TODOS los parches', () => {
    const { p, patternId, channelId } = conNota(60);
    applyCommand(p, {
      type: 'addNotes',
      patternId,
      channelId,
      notes: [{ id: 'n2', start: 2, duration: 1, key: 70, velocity: 1, pan: 0, slide: false }],
    });
    const inverse = applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 61 },
        { id: 'n2', key: 71 },
      ] as NotePatch[],
    });
    // Dos entidades distintas: los dos parches tienen que estar en el inverso.
    expect((inverse as { patches: unknown[] }).patches).toHaveLength(2);
    applyCommand(p, inverse);
    expect(notas(p, channelId).map((n) => n.key).sort()).toEqual([60, 70]);
  });

  it('el segundo parche del mismo id con OTRO campo también queda en el inverso', () => {
    // Lo que faltaba: guardar solo las claves del PRIMER parche perdía el campo que
    // el segundo tocaba. Nota key 60 / velocity 1, parches [{key 61}, {velocity 0.2}]:
    // tras deshacer, key volvía a 60 pero velocity se quedaba en 0.2.
    const { p, patternId, channelId } = conNota(60);
    const antes = serializeProject(p);

    applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 61 },
        { id: 'n1', velocity: 0.2 },
      ] as NotePatch[],
    });
    expect(notas(p, channelId)[0]).toMatchObject({ key: 61, velocity: 0.2 });

    applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 60, velocity: 1 },
      ] as NotePatch[],
    });
    // Los dos campos vuelven a su valor de antes, no solo el del primer parche.
    expect(notas(p, channelId)[0]).toMatchObject({ key: 60, velocity: 1 });
    expect(serializeProject(p)).toBe(antes);
  });

  it('y con el campo repetido en los dos parches, gana el valor del primero', () => {
    const { p, patternId, channelId } = conNota(60);
    applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 61 },
        { id: 'n1', key: 62, velocity: 0.2 },
      ] as NotePatch[],
    });
    applyCommand(p, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: 'n1', key: 60, velocity: 1 },
      ] as NotePatch[],
    });
    expect(notas(p, channelId)[0]).toMatchObject({ key: 60, velocity: 1 });
  });
});
