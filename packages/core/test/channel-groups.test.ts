/**
 * Carpetas del Channel Rack: organizar sin tocar el audio.
 *
 * Lo que importa aquí es que una carpeta NUNCA se lleve canales por delante
 * (deshacerla los deja sueltos) y que el undo devuelva las cosas a su sitio,
 * carpeta y miembros incluidos.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands';
import { createChannel, createEmptyProject } from '../src/model/defaults';
import { newId } from '../src/ids';
import type { ChannelGroup, Project } from '../src/model/types';

function group(name: string): ChannelGroup {
  return { id: newId(), name, color: '#5aa9e6', collapsed: false };
}

/** Proyecto con dos canales sueltos. */
function base(): { project: Project; a: string; b: string } {
  const project = createEmptyProject('Carpetas');
  const chA = createChannel('synth', 0, 'A');
  const chB = createChannel('synth', 1, 'B');
  applyCommand(project, { type: 'addChannel', channel: chA });
  applyCommand(project, { type: 'addChannel', channel: chB });
  return { project, a: chA.id, b: chB.id };
}

describe('carpetas de canales', () => {
  it('un proyecto nuevo no trae carpetas', () => {
    const p = createEmptyProject('Nuevo');
    expect(p.channelGroups).toEqual({});
    expect(p.channelGroupOrder).toEqual([]);
  });

  it('crear una carpeta y meter un canal', () => {
    const { project, a } = base();
    const g = group('Drums');
    applyCommand(project, { type: 'addChannelGroup', group: g });
    applyCommand(project, { type: 'patchChannel', channelId: a, patch: { groupId: g.id } });

    expect(project.channelGroupOrder).toEqual([g.id]);
    expect(project.channels[a]!.groupId).toBe(g.id);
  });

  it('deshacer la carpeta deja los canales SUELTOS, no los borra', () => {
    const { project, a, b } = base();
    const g = group('Drums');
    applyCommand(project, { type: 'addChannelGroup', group: g });
    applyCommand(project, { type: 'patchChannel', channelId: a, patch: { groupId: g.id } });
    applyCommand(project, { type: 'patchChannel', channelId: b, patch: { groupId: g.id } });

    applyCommand(project, { type: 'removeChannelGroup', groupId: g.id });

    expect(project.channelGroups[g.id]).toBeUndefined();
    expect(project.channelOrder).toEqual([a, b]); // los canales siguen ahí
    expect(project.channels[a]!.groupId).toBeUndefined();
    expect(project.channels[b]!.groupId).toBeUndefined();
  });

  it('el inverso de borrar devuelve la carpeta CON sus canales dentro', () => {
    const { project, a, b } = base();
    const g = group('Drums');
    applyCommand(project, { type: 'addChannelGroup', group: g });
    applyCommand(project, { type: 'patchChannel', channelId: a, patch: { groupId: g.id } });

    const inverse = applyCommand(project, { type: 'removeChannelGroup', groupId: g.id });
    applyCommand(project, inverse);

    expect(project.channelGroups[g.id]?.name).toBe('Drums');
    expect(project.channels[a]!.groupId).toBe(g.id);
    expect(project.channels[b]!.groupId).toBeUndefined();
  });

  it('la carpeta vuelve a su posición al deshacer', () => {
    const { project } = base();
    const g1 = group('Uno');
    const g2 = group('Dos');
    const g3 = group('Tres');
    for (const g of [g1, g2, g3]) applyCommand(project, { type: 'addChannelGroup', group: g });

    const inverse = applyCommand(project, { type: 'removeChannelGroup', groupId: g2.id });
    expect(project.channelGroupOrder).toEqual([g1.id, g3.id]);
    applyCommand(project, inverse);
    expect(project.channelGroupOrder).toEqual([g1.id, g2.id, g3.id]);
  });

  it('plegar y renombrar son reversibles', () => {
    const { project } = base();
    const g = group('Drums');
    applyCommand(project, { type: 'addChannelGroup', group: g });

    const inverse = applyCommand(project, {
      type: 'patchChannelGroup',
      groupId: g.id,
      patch: { collapsed: true, name: 'Percusión' },
    });
    expect(project.channelGroups[g.id]).toMatchObject({ collapsed: true, name: 'Percusión' });

    applyCommand(project, inverse);
    expect(project.channelGroups[g.id]).toMatchObject({ collapsed: false, name: 'Drums' });
  });

  it('borrar un canal de una carpeta no toca la carpeta', () => {
    const { project, a } = base();
    const g = group('Drums');
    applyCommand(project, { type: 'addChannelGroup', group: g });
    applyCommand(project, { type: 'patchChannel', channelId: a, patch: { groupId: g.id } });

    applyCommand(project, { type: 'removeChannel', channelId: a });
    expect(project.channelGroups[g.id]).toBeDefined();
    expect(project.channelGroupOrder).toEqual([g.id]);
  });
});
