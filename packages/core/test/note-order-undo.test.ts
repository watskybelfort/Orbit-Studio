/**
 * BUG 005 — borrar una nota y deshacer deja el patrón en otro orden.
 *
 * `removeNotes` guardaba la nota quitada pero no su sitio, y el inverso era un
 * `addNotes`, que empuja al final. Con [a,b,c], borrar b y deshacer daba [a,c,b].
 *
 * El orden de las notas no es cosmético: es lo que desempata los eventos que comparten
 * inicio al compilar (y el motor lo conserva a propósito) y lo que sale al serializar,
 * así que deshacer no puede reordenar el patrón.
 *
 * El inverso de `removeNotes` es ahora `restoreNotes`, con la posición de cada nota.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  serializeProject,
  type Note,
} from '../src/index';

function patron(ids: string[]): {
  p: ReturnType<typeof createEmptyProject>;
  patternId: string;
  channelId: string;
} {
  const p = createEmptyProject();
  const canal = createChannel('synth', 0, 'C0');
  applyCommand(p, { type: 'addChannel', channel: canal });
  applyCommand(p, {
    type: 'addPattern',
    pattern: { id: 'pt1', name: 'P', color: '#fff', length: 4, notes: {} },
  });
  const notas: Note[] = ids.map((id, i) => ({
    id,
    start: i,
    duration: 1,
    // TODAS en el MISMO `start`: es lo que hace que el orden de la lista sea el que
    // desempata los eventos al compilar, y por eso deshacer tiene que devolverlo.
    key: 60,
    velocity: 1,
    pan: 0,
    slide: false,
  }));
  for (const nota of notas) nota.start = 0;
  applyCommand(p, { type: 'addNotes', patternId: 'pt1', channelId: canal.id, notes: notas });
  return { p, patternId: 'pt1', channelId: canal.id };
}

function orden(p: ReturnType<typeof createEmptyProject>, channelId: string): string[] {
  return (p.patterns.pt1?.notes[channelId] ?? []).map((n) => n.id);
}

describe('005 · borrar y deshacer devuelve las notas a su sitio', () => {
  it('nota intermedia: el caso de la tarjeta', () => {
    const { p, patternId, channelId } = patron(['a', 'b', 'c']);
    const antes = serializeProject(p);

    const inversa = applyCommand(p, { type: 'removeNotes', patternId, channelId, noteIds: ['b'] });
    expect(orden(p, channelId)).toEqual(['a', 'c']);

    applyCommand(p, inversa);
    expect(orden(p, channelId)).toEqual(['a', 'b', 'c']);
    expect(serializeProject(p)).toBe(antes);
  });

  it('primera, última y varias: la identidad estructural vuelve exacta', () => {
    for (const caso of [
      { nombre: 'la primera', quitas: ['a'] },
      { nombre: 'la última', quitas: ['d'] },
      { nombre: 'varias juntas', quitas: ['b', 'c'] },
      { nombre: 'varias con hueco', quitas: ['a', 'c'] },
      { nombre: 'todas menos una', quitas: ['a', 'b', 'c'] },
      { nombre: 'todas', quitas: ['a', 'b', 'c', 'd'] },
    ]) {
      const { p, patternId, channelId } = patron(['a', 'b', 'c', 'd']);
      const antes = serializeProject(p);
      const inversa = applyCommand(p, { type: 'removeNotes', patternId, channelId, noteIds: caso.quitas });
      expect(orden(p, channelId)).not.toContain(caso.quitas[0]!);
      applyCommand(p, inversa);
      expect(orden(p, channelId), caso.nombre).toEqual(['a', 'b', 'c', 'd']);
      expect(serializeProject(p), caso.nombre).toBe(antes);
    }
  });

  it('notas simultáneas: el orden que desempata los eventos vuelve al de antes', () => {
    // Con todas las notas en el mismo `start`, el orden de la lista es el que decide
    // qué evento suena antes (el motor lo conserva a propósito al compilar). Si el undo
    // reordena, el render cambia de verdad, así que se comprueba el orden exacto.
    const { p, patternId, channelId } = patron(['a', 'b', 'c']);
    const antes = orden(p, channelId);
    expect(antes).toEqual(['a', 'b', 'c']);

    const inversa = applyCommand(p, { type: 'removeNotes', patternId, channelId, noteIds: ['b'] });
    applyCommand(p, inversa);

    expect(orden(p, channelId)).toEqual(antes);
  });

  it('deshacer dos veces (borrar, deshacer, borrar, deshacer) es estable', () => {
    const { p, patternId, channelId } = patron(['a', 'b', 'c', 'd']);
    const antes = serializeProject(p);

    const uno = applyCommand(p, { type: 'removeNotes', patternId, channelId, noteIds: ['b', 'd'] });
    applyCommand(p, uno);
    const dos = applyCommand(p, { type: 'removeNotes', patternId, channelId, noteIds: ['c'] });
    applyCommand(p, dos);

    expect(orden(p, channelId)).toEqual(['a', 'b', 'c', 'd']);
    expect(serializeProject(p)).toBe(antes);
  });

  it('el inverso también viaja por JSON (una sala lo rehace el otro cliente)', () => {
    const { p, patternId, channelId } = patron(['a', 'b', 'c', 'd']);
    const antes = serializeProject(p);
    const inversa = JSON.parse(
      JSON.stringify(applyCommand(p, { type: 'removeNotes', patternId, channelId, noteIds: ['a', 'c'] })),
    );
    applyCommand(p, inversa);
    expect(orden(p, channelId)).toEqual(['a', 'b', 'c', 'd']);
    expect(serializeProject(p)).toBe(antes);
  });

  it('un restoreNotes SIN posiciones (comando a mano) las appendea', () => {
    const { p, patternId, channelId } = patron(['a', 'b']);
    const inversa = applyCommand(p, {
      type: 'removeNotes',
      patternId,
      channelId,
      noteIds: ['a'],
    });
    // Se quita el `at` a propósito: es un comando hecho a mano, no el inverso del bus.
    const sinAt = { ...inversa, at: undefined } as unknown as typeof inversa;
    applyCommand(p, sinAt);
    expect(orden(p, channelId)).toEqual(['b', 'a']);
  });
});