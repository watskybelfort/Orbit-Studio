/**
 * Los comandos que el rack manda para estrenar/mover/quitar el bus de una
 * carpeta. Se prueban aquí, sin React, porque lo que puede salir mal no es el
 * pintado: es que la operación se parta en dos pasos de undo (deshaces y te
 * queda el bus puesto con la pista renombrada, o al revés), que el "sin bus" se
 * mande como `undefined` y se pierda al cruzar la sala, o que estrenar un bus
 * le robe a alguien una pista que ya tenía cosas dentro.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultEffectParams,
  newId,
  type ChannelGroup,
  type Project,
} from '@orbit/core';
import {
  asSingleCommand,
  createGroupBusCommands,
  setGroupBusCommands,
} from '../src/editors/rack/group-bus';

function group(name: string, patch: Partial<ChannelGroup> = {}): ChannelGroup {
  return { id: newId(), name, color: '#5aa9e6', collapsed: false, ...patch };
}

/** Proyecto con una carpeta y `n` canales dentro. */
function base(n = 2, patch: Partial<ChannelGroup> = {}): { project: Project; g: ChannelGroup } {
  const project = createEmptyProject('Buses');
  const g = group('Drums', patch);
  applyCommand(project, { type: 'addChannelGroup', group: g });
  for (let i = 0; i < n; i++) {
    const ch = createChannel('synth', i, `C${i}`);
    applyCommand(project, { type: 'addChannel', channel: ch });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: ch.id,
      patch: { groupId: g.id },
    });
  }
  return { project, g: project.channelGroups[g.id]! };
}

describe('estrenar el bus de una carpeta', () => {
  it('apunta la pista en la carpeta Y la bautiza, en un solo paso de undo', () => {
    const { project, g } = base();
    const change = createGroupBusCommands(project, g)!;
    expect(change.busTrack).toBe(1);
    expect(change.commands).toEqual([
      { type: 'patchChannelGroup', groupId: g.id, patch: { busTrack: 1 } },
      { type: 'patchMixerTrack', trackIndex: 1, patch: { name: 'Drums', color: g.color } },
    ]);
    // Y sale como UN comando (batch), no como dos sueltos.
    expect(asSingleCommand(change.commands, change.label)).toMatchObject({ type: 'batch' });
  });

  it('el lote se aplica y se deshace entero', () => {
    const { project, g } = base();
    const change = createGroupBusCommands(project, g)!;
    const command = asSingleCommand(change.commands, change.label)!;
    const inverse = applyCommand(project, command);

    expect(project.channelGroups[g.id]!.busTrack).toBe(1);
    expect(project.mixer[1]!.name).toBe('Drums');

    applyCommand(project, inverse);
    expect(project.channelGroups[g.id]!.busTrack).toBe(0);
    expect(project.mixer[1]!.name).toBe('Insert 1');
  });

  it('no renombra una pista que ya tiene nombre o efectos puestos', () => {
    const { project, g } = base();
    project.mixer[1]!.name = 'Voces';
    const change = createGroupBusCommands(project, g)!;
    expect(change.commands).toHaveLength(1);
    expect(change.busTrack).toBe(1);
  });

  it('no estrena una pista ocupada: se salta la que tiene un canal dentro', () => {
    const { project, g } = base();
    const ch = createChannel('synth', 9, 'Voz');
    ch.mixerTrack = 1;
    applyCommand(project, { type: 'addChannel', channel: ch });
    expect(createGroupBusCommands(project, g)!.busTrack).toBe(2);
  });

  it('ni la que tiene un efecto insertado', () => {
    const { project, g } = base();
    project.mixer[1]!.slots[0] = {
      id: newId(),
      kind: 'compressor',
      enabled: true,
      mix: 1,
      params: { ...defaultEffectParams('compressor') },
    };
    expect(createGroupBusCommands(project, g)!.busTrack).toBe(2);
  });

  it('con el mixer lleno devuelve null en vez de robarle la pista a nadie', () => {
    const { project, g } = base();
    for (let i = 1; i < project.mixer.length; i++) project.mixer[i]!.name = `Usada ${i}`;
    // Nombre cambiado no basta: lo que ocupa es tener algo dentro.
    for (let i = 1; i < project.mixer.length; i++) {
      project.mixer[i]!.sends = [{ target: 0, level: 0.5 }];
    }
    expect(createGroupBusCommands(project, g)).toBeNull();
  });
});

describe('mover y quitar el bus', () => {
  it('quitar el bus se manda como 0, que sí sobrevive a serializarse', () => {
    const { project, g } = base(2, { busTrack: 5 });
    const change = setGroupBusCommands(project, g, null)!;
    expect(change.commands).toEqual([
      { type: 'patchChannelGroup', groupId: g.id, patch: { busTrack: 0 } },
    ]);
    expect(JSON.parse(JSON.stringify(change.commands))).toEqual(change.commands);
  });

  it('poner el mismo bus que ya tiene no manda nada', () => {
    const { project, g } = base(2, { busTrack: 5 });
    expect(setGroupBusCommands(project, g, 5)).toBeNull();
  });

  it('quitarle el bus a una carpeta que no lo tiene tampoco manda nada', () => {
    const { project, g } = base();
    expect(setGroupBusCommands(project, g, null)).toBeNull();
    expect(setGroupBusCommands(project, g, 0)).toBeNull();
  });

  it('el Master no vale como bus (sería el fader general)', () => {
    const { project, g } = base(2, { busTrack: 5 });
    const change = setGroupBusCommands(project, g, 0)!;
    // Pedir el Master es pedir "sin bus", no "bus en el Master".
    expect(change.busTrack).toBeNull();
  });

  it('una pista fuera del mixer se trata como "sin bus", no se manda tal cual', () => {
    const { project, g } = base(2, { busTrack: 5 });
    expect(setGroupBusCommands(project, g, 999)!.busTrack).toBeNull();
  });

  it('mover el bus a otra pista deja la anterior donde estaba', () => {
    const { project, g } = base();
    const first = createGroupBusCommands(project, g)!;
    applyCommand(project, asSingleCommand(first.commands, first.label)!);
    const moved = setGroupBusCommands(project, project.channelGroups[g.id]!, 4)!;
    applyCommand(project, asSingleCommand(moved.commands, moved.label)!);

    expect(project.channelGroups[g.id]!.busTrack).toBe(4);
    expect(project.mixer[1]!.name).toBe('Drums'); // la vieja no se desbautiza sola
    expect(project.mixer[4]!.name).toBe('Drums');
  });
});

describe('asSingleCommand', () => {
  it('un comando suelto no se envuelve en un lote', () => {
    const { project, g } = base(2, { busTrack: 5 });
    const change = setGroupBusCommands(project, g, null)!;
    expect(asSingleCommand(change.commands, change.label)).toEqual(change.commands[0]);
  });

  it('sin comandos no hay nada que mandar', () => {
    expect(asSingleCommand([], 'nada')).toBeNull();
  });
});
