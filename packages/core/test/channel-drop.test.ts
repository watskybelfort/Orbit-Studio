/**
 * Arrastrar canales entre carpetas del rack.
 *
 * Lo que se comprueba es la cuenta de siempre y sus trampas: el índice que
 * pide `moveChannel` es el de la lista YA sin el canal (por eso soltar un
 * canal justo debajo del que tiene encima no es ningún movimiento), y una
 * carpeta que ya no existe cuenta como "suelto" porque es como se pinta.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands';
import { createChannel, createEmptyProject } from '../src/model/defaults';
import { planChannelDrop, groupOfChannel } from '../src/model/channel-drop';
import { newId } from '../src/ids';
import type { ChannelGroup, Id, Project } from '../src/model/types';

function group(name: string): ChannelGroup {
  return { id: newId(), name, color: '#5aa9e6', collapsed: false };
}

/** Rack con cuatro canales sueltos (A, B, C, D) y una carpeta "Drums" vacía. */
function base(): { project: Project; ids: Record<string, Id>; drums: ChannelGroup } {
  const project = createEmptyProject('Arrastre');
  const ids: Record<string, Id> = {};
  ['A', 'B', 'C', 'D'].forEach((name, i) => {
    const ch = createChannel('synth', i, name);
    applyCommand(project, { type: 'addChannel', channel: ch });
    ids[name] = ch.id;
  });
  const drums = group('Drums');
  applyCommand(project, { type: 'addChannelGroup', group: drums });
  return { project, ids, drums };
}

/** Ejecuta el plan como lo hace el rack: patchChannel + moveChannel. */
function applyPlan(project: Project, channelId: Id, target: Parameters<typeof planChannelDrop>[2]): void {
  const plan = planChannelDrop(project, channelId, target);
  if (!plan) return;
  if (plan.changesGroup) {
    applyCommand(project, { type: 'patchChannel', channelId, patch: { groupId: plan.groupId } });
  }
  if (plan.moves) applyCommand(project, { type: 'moveChannel', channelId, toIndex: plan.toIndex });
}

/** Nombres en el orden del rack, para leer los tests de un vistazo. */
const names = (project: Project): string[] =>
  project.channelOrder.map((id) => project.channels[id]?.name ?? '?');

describe('arrastrar un canal', () => {
  it('soltarlo sobre sí mismo no es nada', () => {
    const { project, ids } = base();
    expect(planChannelDrop(project, ids['A']!, { kind: 'row', channelId: ids['A']!, before: true })).toBeNull();
  });

  it('soltarlo justo debajo del que ya tiene encima tampoco', () => {
    const { project, ids } = base();
    expect(planChannelDrop(project, ids['B']!, { kind: 'row', channelId: ids['A']!, before: false })).toBeNull();
  });

  it('sobre una fila: queda encima o debajo de ella', () => {
    const { project, ids } = base();
    applyPlan(project, ids['D']!, { kind: 'row', channelId: ids['A']!, before: true });
    expect(names(project)).toEqual(['D', 'A', 'B', 'C']);

    applyPlan(project, ids['D']!, { kind: 'row', channelId: ids['B']!, before: false });
    expect(names(project)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('sobre una fila de una carpeta: el canal se mete en ESA carpeta', () => {
    const { project, ids, drums } = base();
    applyCommand(project, { type: 'patchChannel', channelId: ids['A']!, patch: { groupId: drums.id } });

    applyPlan(project, ids['C']!, { kind: 'row', channelId: ids['A']!, before: false });
    expect(groupOfChannel(project, ids['C']!)).toBe(drums.id);
    expect(names(project)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('sobre la cabecera de una carpeta: entra al final de sus canales', () => {
    const { project, ids, drums } = base();
    applyCommand(project, { type: 'patchChannel', channelId: ids['A']!, patch: { groupId: drums.id } });
    applyCommand(project, { type: 'patchChannel', channelId: ids['B']!, patch: { groupId: drums.id } });

    applyPlan(project, ids['D']!, { kind: 'group', groupId: drums.id });
    expect(groupOfChannel(project, ids['D']!)).toBe(drums.id);
    expect(names(project)).toEqual(['A', 'B', 'D', 'C']);
  });

  it('sobre una carpeta vacía: cambia de carpeta y se queda donde estaba', () => {
    const { project, ids, drums } = base();
    const plan = planChannelDrop(project, ids['B']!, { kind: 'group', groupId: drums.id });
    expect(plan).toEqual({ groupId: drums.id, toIndex: 1, changesGroup: true, moves: false });

    applyPlan(project, ids['B']!, { kind: 'group', groupId: drums.id });
    expect(names(project)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('a la zona de sueltos: sale de la carpeta y se va al final', () => {
    const { project, ids, drums } = base();
    applyCommand(project, { type: 'patchChannel', channelId: ids['A']!, patch: { groupId: drums.id } });

    applyPlan(project, ids['A']!, { kind: 'loose' });
    expect(groupOfChannel(project, ids['A']!)).toBe('');
    expect(project.channels[ids['A']!]!.groupId).toBe('');
    expect(names(project)).toEqual(['B', 'C', 'D', 'A']);
  });

  it('un canal ya suelto y ya el último no se mueve al soltarlo abajo', () => {
    const { project, ids } = base();
    expect(planChannelDrop(project, ids['D']!, { kind: 'loose' })).toBeNull();
  });

  it('una carpeta que ya no existe cuenta como suelto, y el arrastre la limpia', () => {
    const { project, ids } = base();
    applyCommand(project, { type: 'patchChannel', channelId: ids['A']!, patch: { groupId: 'fantasma' } });
    expect(groupOfChannel(project, ids['A']!)).toBe('');

    const plan = planChannelDrop(project, ids['A']!, { kind: 'loose' });
    expect(plan).toEqual({ groupId: '', toIndex: 3, changesGroup: true, moves: true });

    applyPlan(project, ids['A']!, { kind: 'loose' });
    expect(project.channels[ids['A']!]!.groupId).toBe('');
    expect(names(project)).toEqual(['B', 'C', 'D', 'A']);
  });

  it('una carpeta que no existe no es destino', () => {
    const { project, ids } = base();
    expect(planChannelDrop(project, ids['A']!, { kind: 'group', groupId: 'fantasma' })).toBeNull();
  });

  it('un canal que no existe no se arrastra', () => {
    const { project, ids } = base();
    expect(planChannelDrop(project, 'fantasma', { kind: 'row', channelId: ids['A']!, before: true })).toBeNull();
  });
});
