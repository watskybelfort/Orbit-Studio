/**
 * BUG 010 — `removeArrangement` de un arrangement que no está en el orden expulsa a otro.
 *
 * El pool y el orden pueden desincronizarse sin que nada sea inválido: un merge de
 * colaboración puede dejar la entidad en `arrangements` sin su id en `arrangementOrder`.
 * Entonces `indexOf` da -1 y `splice(-1, 1)` no quita nada de donde toca: expulsa al
 * ÚLTIMO del orden, que no tiene nada que ver con el borrado (medido: pool con
 * base/other/hidden y orden [base, other], al borrar `hidden` quedaba [base] y `other`
 * se caía del selector sin haberlo borrado).
 *
 * Lo mismo ya estaba guarded en canales, patrones, carpetas y entradas; aquí faltaba.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createEmptyProject,
  serializeProject,
  type Arrangement,
  type PlaylistTrack,
} from '../src/index';

function arreglo(id: string, nombre: string): Arrangement {
  return { id, name: nombre };
}

function pista(id: string, arrangementId: string, order: number): PlaylistTrack {
  return { id, arrangementId, name: `Pista ${id}`, color: '#fff', height: 56, muted: false, order };
}

/** base/other/hidden en el pool, pero solo base y other en el orden (estado de merge). */
function desincronizado(): ReturnType<typeof createEmptyProject> {
  const p = createEmptyProject();
  p.arrangements.base = arreglo('base', 'Base');
  p.arrangements.other = arreglo('other', 'Other');
  p.arrangements.hidden = arreglo('hidden', 'Hidden');
  p.arrangementOrder = ['base', 'other'];
  p.activeArrangementId = 'base';
  return p;
}

describe('010 · borrar un arrangement no expulsa a otro del orden', () => {
  it('el caso de la tarjeta: el orden queda como estaba', () => {
    const p = desincronizado();
    const antes = serializeProject(p);

    applyCommand(p, { type: 'removeArrangement', arrangementId: 'hidden' });

    // Se borra el que se pidió...
    expect(p.arrangements.hidden).toBeUndefined();
    // ...y NO se expulsa a `other`, que sigue en el pool y en el orden.
    expect(p.arrangements.other).toBeDefined();
    expect(p.arrangementOrder).toEqual(['base', 'other']);
    // El activo sigue siendo válido.
    expect(p.activeArrangementId).toBe('base');
  });

  it('el inverso no mete el arrangement en una posición negativa', () => {
    const p = desincronizado();
    const inverse = applyCommand(p, { type: 'removeArrangement', arrangementId: 'hidden' });
    expect(inverse.type).toBe('restoreArrangement');
    applyCommand(p, inverse);

    // Vuelve al pool y a un sitio del orden que existe. Como no estaba en el orden al
    // borrarlo (index -1), se reengancha al final, como en restorePattern: lo que no
    // estaba no puede volver a un sitio inventado por delante del primero.
    expect(p.arrangements.hidden).toBeDefined();
    expect(p.arrangementOrder).toEqual(['base', 'other', 'hidden']);
  });

  it('con el estado normal, el borrado y el undo son exactos', () => {
    const p = createEmptyProject();
    const primero = p.arrangementOrder[0]!;
    applyCommand(p, { type: 'addArrangement', arrangement: arreglo('extra', 'Extra') });
    applyCommand(p, { type: 'addArrangement', arrangement: arreglo('extra2', 'Extra 2') });
    const antes = serializeProject(p);
    const orden = [...p.arrangementOrder];

    const inverse = applyCommand(p, { type: 'removeArrangement', arrangementId: 'extra' });
    expect(p.arrangementOrder).toEqual(orden.filter((id) => id !== 'extra'));

    applyCommand(p, inverse);
    // Y el orden vuelve a ser el de antes, con el arrangement en SU sitio.
    expect(p.arrangementOrder).toEqual(orden);
    expect(p.arrangementOrder[0]).toBe(primero);
    // El proyecto es el mismo. Se compara OBJETO a objeto y no el texto: al borrar y
    // volver a insertar, la clave del pool se reordena (eso no lo cambia este arreglo,
    // es de cómo funciona un pool), pero ninguna entidad pierde ni gana nada.
    expect(JSON.parse(serializeProject(p))).toEqual(JSON.parse(antes));
    expect(p.arrangements.extra).toEqual({ id: 'extra', name: 'Extra' });
  });

  it('borrar el ACTIVO que no está en el orden deja un activo válido', () => {
    const p = desincronizado();
    p.activeArrangementId = 'hidden';
    applyCommand(p, { type: 'removeArrangement', arrangementId: 'hidden' });
    // El activo no puede ser el que se acaba de borrar: cae al primero que quede.
    expect(p.activeArrangementId).not.toBe('hidden');
    expect(p.arrangements[p.activeArrangementId]).toBeDefined();
    expect(p.arrangementOrder).toContain(p.activeArrangementId);
  });

  it('las pistas y secciones del arrangement borrado se van con él, y las de otros no', () => {
    const p = desincronizado();
    p.playlistTracks.t1 = pista('t1', 'hidden', 0);
    p.playlistTracks.t2 = pista('t2', 'other', 1);
    p.sections.s1 = { id: 's1', arrangementId: 'hidden', name: 'A', start: 0, length: 4 };
    p.sections.s2 = { id: 's2', arrangementId: 'other', name: 'B', start: 0, length: 4 };

    const inverse = applyCommand(p, { type: 'removeArrangement', arrangementId: 'hidden' });

    expect(p.playlistTracks.t1).toBeUndefined();
    expect(p.sections.s1).toBeUndefined();
    // Las del otro arrangement siguen ahí (y en su sitio).
    expect(p.playlistTracks.t2).toBeDefined();
    expect(p.sections.s2).toBeDefined();

    // Y el undo las repone exactamente.
    applyCommand(p, inverse);
    expect(p.playlistTracks.t1).toMatchObject({ id: 't1', arrangementId: 'hidden' });
    expect(p.sections.s1).toBeDefined();
  });

  it('el último arrangement sigue protegido', () => {
    const p = createEmptyProject();
    const unico = p.arrangementOrder[0]!;
    expect(() => applyCommand(p, { type: 'removeArrangement', arrangementId: unico })).toThrow(
      /último/,
    );
  });
});