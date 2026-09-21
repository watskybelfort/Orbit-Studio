/**
 * `parseProject` es la puerta del .orbit: si deja pasar un esqueleto incompleto
 * o con tipos cambiados, el fallo aparece después y lejos — un TypeError al
 * añadir un arrangement, o una canción MUDA porque `activeArrangementId` no
 * apunta a nada y el compilador filtra todas las pistas.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createEmptyProject,
  newId,
  parseProject,
  serializeProject,
  type Project,
} from '../src/index';

describe('parseProject: valida el esqueleto que el compilador necesita', () => {
  const raw = (p: Project): Record<string, unknown> =>
    JSON.parse(serializeProject(p)) as Record<string, unknown>;
  const abrir = (o: Record<string, unknown>): Project => parseProject(JSON.stringify(o));

  it('rechaza .orbit sin arrangements, arrangementOrder o activeArrangementId', () => {
    for (const key of ['arrangements', 'arrangementOrder', 'activeArrangementId']) {
      const o = raw(createEmptyProject());
      delete o[key];
      expect(() => abrir(o)).toThrow(new RegExp(`"${key}"`));
    }
  });

  it('rechaza campos presentes con el tipo equivocado (null, number, string)', () => {
    const casos: [string, unknown][] = [
      ['arrangements', null],
      ['arrangementOrder', 42],
      ['activeArrangementId', null],
      ['channelOrder', 'nope'],
      ['channels', []],
      ['mixer', {}],
      ['patterns', 7],
    ];
    for (const [key, bad] of casos) {
      const o = raw(createEmptyProject());
      o[key] = bad;
      expect(() => abrir(o)).toThrow(new RegExp(`"${key}"`));
    }
  });

  it('sanea activeArrangementId contra arrangements (fallback al primero del orden)', () => {
    const p = createEmptyProject();
    const b = { id: newId(), name: 'B' };
    applyCommand(p, { type: 'addArrangement', arrangement: b });
    const o = raw(p);
    o['activeArrangementId'] = 'no-existe';
    const parsed = abrir(o);
    expect(parsed.arrangements[parsed.activeArrangementId]).toBeDefined();
    expect(parsed.activeArrangementId).toBe(parsed.arrangementOrder[0]);
  });

  it('si el orden tampoco tiene ninguno válido, cae al primer arrangement del pool', () => {
    const o = raw(createEmptyProject());
    const real = Object.keys(o['arrangements'] as Record<string, unknown>)[0]!;
    o['activeArrangementId'] = 'no-existe';
    o['arrangementOrder'] = ['tampoco-existe'];
    const parsed = abrir(o);
    expect(parsed.activeArrangementId).toBe(real);
    expect(parsed.arrangements[parsed.activeArrangementId]).toBeDefined();
  });
});
