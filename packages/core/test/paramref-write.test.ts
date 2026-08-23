/**
 * Escribir cualquier destino (`ParamRef`) por el bus de comandos.
 *
 * La propiedad que importa es que sea la INVERSA exacta de la lectura: lo que
 * escribes con un 0..1 tiene que volver a leerse como ese mismo 0..1. Si las
 * dos mitades se separan, un mando físico aprendido salta al tocarlo (escribe
 * un valor y la perilla enseña otro).
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  paramRefCommand,
  paramRefNorm,
  type EffectSlot,
  type ParamRef,
  type Project,
} from '../src/index';

/** Aplica el comando de escribir `ref` a `norm` y devuelve lo que se lee luego. */
function roundTrip(project: Project, ref: ParamRef, norm: number): number | null {
  const cmd = paramRefCommand(ref, norm, project);
  expect(cmd).not.toBeNull();
  applyCommand(project, cmd!);
  return paramRefNorm(ref, project);
}

function projectWithChannel(): { project: Project; channelId: string } {
  const project = createEmptyProject();
  const channel = createChannel('sub808', 0, 'Bajo');
  applyCommand(project, { type: 'addChannel', channel });
  return { project, channelId: channel.id };
}

describe('paramRefCommand', () => {
  it('escribe un parámetro de instrumento y se lee igual', () => {
    const { project, channelId } = projectWithChannel();
    const param = Object.keys(project.channels[channelId]!.params)[0]!;
    const ref: ParamRef = { kind: 'channel', channelId, param };
    for (const norm of [0, 0.25, 0.5, 1]) {
      expect(roundTrip(project, ref, norm)).toBeCloseTo(norm, 5);
    }
  });

  it('escribe volumen y pan del canal', () => {
    const { project, channelId } = projectWithChannel();
    expect(roundTrip(project, { kind: 'channelMix', channelId, param: 'volume' }, 0.4)).toBeCloseTo(
      0.4,
      5,
    );
    // Pan centrado = 0,5 normalizado.
    expect(roundTrip(project, { kind: 'channelMix', channelId, param: 'pan' }, 0.5)).toBeCloseTo(
      0.5,
      5,
    );
    expect(project.channels[channelId]!.pan).toBeCloseTo(0, 5);
  });

  it('escribe la pista de mixer: volumen, pan, ancho y las tres bandas', () => {
    const project = createEmptyProject();
    const params = ['volume', 'pan', 'stereoWidth', 'eqLow', 'eqMid', 'eqHigh'] as const;
    for (const param of params) {
      const ref: ParamRef = { kind: 'mixer', trackIndex: 1, param };
      expect(roundTrip(project, ref, 0.75)).toBeCloseTo(0.75, 5);
    }
  });

  it('escribe un parámetro de un efecto del mixer', () => {
    const project = createEmptyProject();
    const slot: EffectSlot = {
      id: 'fx-1',
      kind: 'delay',
      enabled: true,
      mix: 1,
      params: { time: 0.3, feedback: 0.4 },
    };
    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    const ref: ParamRef = { kind: 'effect', trackIndex: 1, slotIndex: 0, param: 'feedback' };
    expect(roundTrip(project, ref, 0.6)).toBeCloseTo(0.6, 5);
  });

  it('escribe el tempo y el swing del transporte', () => {
    const project = createEmptyProject();
    const tempo: ParamRef = { kind: 'transport', param: 'tempo' };
    expect(roundTrip(project, tempo, 0.2)).toBeCloseTo(0.2, 5);
    const swing: ParamRef = { kind: 'transport', param: 'swing' };
    expect(roundTrip(project, swing, 0.3)).toBeCloseTo(0.3, 5);
  });

  it('acota lo que se salga de 0..1 en vez de escribirlo tal cual', () => {
    const project = createEmptyProject();
    const ref: ParamRef = { kind: 'mixer', trackIndex: 1, param: 'volume' };
    applyCommand(project, paramRefCommand(ref, 5, project)!);
    expect(project.mixer[1]!.volume).toBeCloseTo(2, 5);
    applyCommand(project, paramRefCommand(ref, -3, project)!);
    expect(project.mixer[1]!.volume).toBeCloseTo(0, 5);
  });

  it('un destino que ya no existe devuelve null en vez de reventar', () => {
    const project = createEmptyProject();
    // Un mando aprendido sobrevive al efecto que apuntaba: moverlo después no
    // puede tirar la app.
    expect(paramRefCommand({ kind: 'channel', channelId: 'no-existe', param: 'x' }, 0.5, project)).toBeNull();
    expect(paramRefCommand({ kind: 'channelMix', channelId: 'no-existe', param: 'volume' }, 0.5, project)).toBeNull();
    expect(paramRefCommand({ kind: 'mixer', trackIndex: 999, param: 'volume' }, 0.5, project)).toBeNull();
    expect(
      paramRefCommand({ kind: 'effect', trackIndex: 1, slotIndex: 0, param: 'feedback' }, 0.5, project),
    ).toBeNull();
    expect(
      paramRefCommand({ kind: 'channelFx', channelId: 'no-existe', slotIndex: 0, param: 'x' }, 0.5, project),
    ).toBeNull();
  });

  it('un parámetro que ese efecto no tiene devuelve null', () => {
    const project = createEmptyProject();
    const slot: EffectSlot = {
      id: 'fx-1',
      kind: 'delay',
      enabled: true,
      mix: 1,
      params: { time: 0.3 },
    };
    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    expect(
      paramRefCommand({ kind: 'effect', trackIndex: 1, slotIndex: 0, param: 'inventado' }, 0.5, project),
    ).toBeNull();
  });

  it('el comando es serializable: nada de funciones ni referencias vivas', () => {
    const project = createEmptyProject();
    const cmd = paramRefCommand({ kind: 'mixer', trackIndex: 1, param: 'pan' }, 0.25, project);
    expect(JSON.parse(JSON.stringify(cmd))).toEqual(cmd);
  });
});
