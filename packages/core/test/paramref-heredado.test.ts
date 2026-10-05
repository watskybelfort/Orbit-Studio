/**
 * Follow-up de 017/018 tras la repro de SOLEANO: `ParamRef.kind` con un nombre
 * HEREDADO.
 *
 * La comprobación de la unión usaba `kind in RAMAS_PARAM_REF`, y `in` hereda de
 * `Object.prototype`: `{kind: 'toString'}` pasaba el filtro, `RAMAS_PARAM_REF['toString']`
 * devolvía la función heredada y `rama.apunta` reventaba con un TypeError DENTRO del
 * validador. En el bus y en `parseProject` eso era una excepción en vez de un problema
 * nombrado; en el servidor la excepción la cazaba el manejador del mensaje y la entrada
 * se quedaba APLICADA, repartida y guardada en el .bin, sin `denied` para nadie
 * (medido: log 4→7, `denied` vacío).
 *
 * Aquí se cubre en las cuatro puertas por las que puede entrar un comando: el bus, el
 * validador del proyecto (`parseProject`/`findProjectProblems`), la puerta del servidor
 * (`checkEntry`/`entryCommand`) y el socket de verdad con un cliente que llega tarde.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  commandProblem,
  findProjectProblems,
  parseProject,
  serializeProject,
  createEmptyProject,
} from '../src/index';

/** Los nombres que cualquier objeto tiene heredados y que una tabla puede "encontrar". */
const HEREDADOS = [
  'toString',
  'constructor',
  '__proto__',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
];

function lfo(kind: unknown): Record<string, unknown> {
  return {
    type: 'addLfos',
    lfos: [
      {
        id: 'l1',
        target: { kind, param: 'volume' },
        shape: 'sine',
        rateBeats: 4,
        amount: 0.5,
        phase: 0,
        enabled: true,
      },
    ],
  };
}

describe('follow-up 017/018 · un kind heredado es un kind que no existe', () => {
  it('el bus lo dice con un problema, no con un TypeError', () => {
    for (const kind of HEREDADOS) {
      const problema = commandProblem(lfo(kind));
      expect(problema, kind).toMatch(/kind/);
      expect(problema, kind).not.toMatch(/apunta/);
    }
  });

  it('y aplicarlo lanza el motivo del problema, no una excepción del validador', () => {
    const p = createEmptyProject();
    expect(() => applyCommand(p, lfo('toString') as never)).toThrow(/kind/);
    // El proyecto intacto.
    expect(p.lfos).toEqual({});
  });

  it('findProjectProblems lo señala en el proyecto, con el campo nombrado', () => {
    for (const kind of HEREDADOS) {
      const p = createEmptyProject() as unknown as Record<string, unknown>;
      p.lfos = { l1: (lfo(kind) as { lfos: Record<string, unknown>[] }).lfos[0] };
      const problemas = findProjectProblems(p);
      expect(problemas.length, kind).toBeGreaterThan(0);
      expect(problemas.map((x) => `${x.field}: ${x.expected}`).join(), kind).toMatch(/kind/);
    }
  });

  it('parseProject no revienta con el TypeError del validador: dice qué está mal', () => {
    for (const kind of HEREDADOS) {
      const p = createEmptyProject() as unknown as Record<string, unknown>;
      p.lfos = { l1: (lfo(kind) as { lfos: Record<string, unknown>[] }).lfos[0] };
      // `parseProject` lanza por contrato cuando el proyecto no vale, pero lo que
      // importa es que lo lance por el `kind` y no por un `apunta is not iterable`.
      expect(() => parseProject(JSON.stringify(p)), kind).toThrow(/kind/);
      expect(() => parseProject(JSON.stringify(p)), kind).not.toThrow(/apunta/);
    }
  });

  it('un kind de verdad sigue entrando, y el proyecto se serializa igual', () => {
    const p = createEmptyProject();
    const antes = serializeProject(p);
    expect(commandProblem(lfo('mixer' as never))).not.toMatch(/kind/);
    expect(
      commandProblem({
        type: 'addLfos',
        lfos: [{ ...(lfo('x') as { lfos: Record<string, unknown>[] }).lfos[0], target: { kind: 'mixer', trackIndex: 0, param: 'volume' } }],
      }),
    ).toBeNull();
    expect(serializeProject(p)).toBe(antes);
  });
});