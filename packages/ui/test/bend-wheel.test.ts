/**
 * De la rueda física al parámetro del canal.
 *
 * Son dos piezas que se escribieron con años de por medio y que hablan de lo
 * mismo en unidades que TIENEN que coincidir: `bendSemitones` traduce la
 * posición de la rueda a semitonos, y el parámetro `bend` los guarda. Si una
 * de las dos cambiara de escala, no saltaría ningún tipo ni ningún test de las
 * dos por separado — simplemente la curva grabada quedaría a otra altura que
 * el gesto que la grabó, y eso se descubre al reproducir.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  BEND_MAX,
  createChannel,
  createEmptyProject,
  paramRefCommand,
  paramRefNorm,
  paramValueNorm,
  paramRefValue,
  type ParamRef,
  type Project,
} from '@orbit/core';
import { bendSemitones, BEND_DEADZONE, BEND_RANGES } from '../src/state/midi-message';

function conCanal(): { project: Project; ref: ParamRef } {
  const project = createEmptyProject();
  const channel = createChannel('synth', 0, 'Lead');
  applyCommand(project, { type: 'addChannel', channel });
  return { project, ref: { kind: 'channelMix', channelId: channel.id, param: 'bend' } };
}

/** El camino entero: rueda → semitonos → 0..1 → comando → proyecto. */
function mover(project: Project, ref: ParamRef, rueda: number, rango: number): number {
  const semitonos = bendSemitones(rueda, rango);
  const cmd = paramRefCommand(ref, paramValueNorm(semitonos, ref, project), project);
  expect(cmd).not.toBeNull();
  applyCommand(project, cmd!);
  return paramRefValue(paramRefNorm(ref, project)!, ref, project);
}

describe('la rueda escribe el parámetro en sus mismas unidades', () => {
  it('lo que dobla el gesto es lo que queda guardado', () => {
    const { project, ref } = conCanal();
    for (const rango of BEND_RANGES) {
      for (const rueda of [-1, -0.5, 0.5, 1]) {
        expect(mover(project, ref, rueda, rango), `rueda ${rueda} a rango ${rango}`).toBeCloseTo(
          bendSemitones(rueda, rango),
          6,
        );
      }
    }
  });

  it('el rango más ancho del teclado cabe entero en el parámetro', () => {
    // Si el parámetro se quedara corto, la rueda a tope se recortaría al
    // guardarse: el gesto sonaría a 24 y la curva grabada a menos.
    const maximo = Math.max(...BEND_RANGES);
    expect(maximo).toBeLessThanOrEqual(BEND_MAX);
    const { project, ref } = conCanal();
    expect(mover(project, ref, 1, maximo)).toBeCloseTo(maximo, 6);
    expect(mover(project, ref, -1, maximo)).toBeCloseTo(-maximo, 6);
  });

  it('soltar la rueda deja el canal en el centro EXACTO', () => {
    // La zona muerta de la rueda da 0 semitonos, y 0 semitonos tiene que ser
    // el centro exacto del parámetro: medio cent de resto se oye en cada nota
    // que nazca después.
    const { project, ref } = conCanal();
    expect(mover(project, ref, 1, 12)).toBeCloseTo(12, 6);
    expect(bendSemitones(BEND_DEADZONE / 2, 12)).toBe(0);
    expect(mover(project, ref, BEND_DEADZONE / 2, 12)).toBe(0);
  });

  it('el canal borrado con la rueda sujeta no revienta', () => {
    const { project } = conCanal();
    const perdido: ParamRef = { kind: 'channelMix', channelId: 'ya-no-esta', param: 'bend' };
    expect(paramRefCommand(perdido, 0.9, project)).toBeNull();
  });
});
