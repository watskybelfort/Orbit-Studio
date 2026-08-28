/**
 * Carpetas del rack que SUMAN a un bus.
 *
 * Lo que se comprueba aquí es la traducción: una carpeta con `busTrack` tiene
 * que quedarse en enrutado normal —canales en una pista, pistas que desembocan
 * en otra— y nada más. Y las tres cosas que se rompen sin querer: que un cable
 * puesto a mano no se lo pise la carpeta, que dos carpetas no monten un bucle
 * entre las dos, y que el mute de la carpeta no se coma el de sus canales.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands';
import { createChannel, createEmptyProject } from '../src/model/defaults';
import { newId } from '../src/ids';
import {
  anyChannelSoloOn,
  busOfChannel,
  busTracks,
  channelAudible,
  channelMuteOn,
  channelSoloOn,
  freeBusTrack,
  groupBusTrack,
  resolveGroupBuses,
} from '../src/model/groups';
import { channelsByTrack, routingEdges, trackOfChannel, usedTracks } from '../src/model/routing';
import { parseProject, serializeProject } from '../src/format';
import type { ChannelGroup, Project } from '../src/model/types';

function group(name: string, patch: Partial<ChannelGroup> = {}): ChannelGroup {
  return { id: newId(), name, color: '#5aa9e6', collapsed: false, ...patch };
}

/** Proyecto con `n` canales sueltos, todos en el Master. */
function base(n = 3): { project: Project; ids: string[] } {
  const project = createEmptyProject('Buses');
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const ch = createChannel('synth', i, `C${i}`);
    applyCommand(project, { type: 'addChannel', channel: ch });
    ids.push(ch.id);
  }
  return { project, ids };
}

/** Mete los canales dados en la carpeta (que se añade si hace falta). */
function putInGroup(project: Project, g: ChannelGroup, ids: string[]): void {
  if (!project.channelGroups[g.id]) applyCommand(project, { type: 'addChannelGroup', group: g });
  for (const channelId of ids) {
    applyCommand(project, { type: 'patchChannel', channelId, patch: { groupId: g.id } });
  }
}

describe('bus de carpeta — el modelo', () => {
  it('una carpeta sin busTrack no cambia absolutamente nada', () => {
    const { project, ids } = base();
    putInGroup(project, group('Drums'), ids);
    const routing = resolveGroupBuses(project);
    expect(routing.channels.size).toBe(0);
    expect(routing.routes.size).toBe(0);
    expect(ids.map((id) => trackOfChannel(project, id))).toEqual([0, 0, 0]);
  });

  it('el Master no vale como bus: no agrupa nada y sería el fader general', () => {
    const { project, ids } = base(1);
    const g = group('Drums', { busTrack: 0 });
    putInGroup(project, g, ids);
    expect(groupBusTrack(project, g)).toBeNull();
    expect(resolveGroupBuses(project).channels.size).toBe(0);
  });

  it('un bus fuera del mixer se ignora en vez de compilar una pista que no existe', () => {
    const { project, ids } = base(1);
    const g = group('Drums', { busTrack: 999 });
    putInGroup(project, g, ids);
    expect(groupBusTrack(project, g)).toBeNull();
    expect(busOfChannel(project, ids[0]!)).toBeNull();
  });

  it('los canales sin pista propia entran DIRECTOS en el bus', () => {
    const { project, ids } = base();
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);

    const routing = resolveGroupBuses(project);
    expect([...routing.channels.values()]).toEqual([5, 5, 5]);
    expect(routing.routes.size).toBe(0); // ninguna pista se reencamina
    expect(ids.map((id) => trackOfChannel(project, id))).toEqual([5, 5, 5]);
    expect(channelsByTrack(project).get(5)).toEqual(ids);
  });

  it('un canal con pista propia conserva su cadena: lo que cambia es la SALIDA', () => {
    const { project, ids } = base(2);
    applyCommand(project, {
      type: 'patchChannel',
      channelId: ids[0]!,
      patch: { mixerTrack: 3 },
    });
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);

    const routing = resolveGroupBuses(project);
    // El de la pista 3 se queda en la 3 (con su EQ) y la 3 desemboca en el bus.
    expect(routing.channels.get(ids[0]!)).toBeUndefined();
    expect(routing.routes.get(3)).toBe(5);
    // El otro, que no tenía pista, entra directo.
    expect(routing.channels.get(ids[1]!)).toBe(5);
    expect(trackOfChannel(project, ids[0]!)).toBe(3);
  });

  it('un canal que YA estaba en la pista del bus se queda como está', () => {
    const { project, ids } = base(1);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 5 } });
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);
    const routing = resolveGroupBuses(project);
    expect(routing.channels.size).toBe(0);
    expect(routing.routes.size).toBe(0);
  });

  it('una pista enrutada A MANO a otro sitio no se la queda la carpeta', () => {
    const { project, ids } = base(1);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 3 } });
    project.mixer[3]!.routeTo = 7; // decisión tomada con la mano
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);

    expect(resolveGroupBuses(project).routes.has(3)).toBe(false);
    expect(project.mixer[3]!.routeTo).toBe(7);
  });

  it('dos carpetas que comparten pista: gana la primera de channelGroupOrder', () => {
    const { project, ids } = base(2);
    for (const id of ids) {
      applyCommand(project, { type: 'patchChannel', channelId: id, patch: { mixerTrack: 3 } });
    }
    const drums = group('Drums', { busTrack: 5 });
    const bass = group('Bass', { busTrack: 6 });
    applyCommand(project, { type: 'addChannelGroup', group: drums });
    applyCommand(project, { type: 'addChannelGroup', group: bass });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: ids[0]!,
      patch: { groupId: drums.id },
    });
    applyCommand(project, {
      type: 'patchChannel',
      channelId: ids[1]!,
      patch: { groupId: bass.id },
    });

    expect(project.channelGroupOrder).toEqual([drums.id, bass.id]);
    expect(resolveGroupBuses(project).routes.get(3)).toBe(5);
  });

  it('el bus no cierra un bucle aunque el usuario haya cableado hacia atrás', () => {
    const { project, ids } = base(1);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 3 } });
    // El bus 5 ya desemboca en la 3: reencaminar 3 → 5 se mordería la cola.
    project.mixer[5]!.routeTo = 3;
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);
    expect(resolveGroupBuses(project).routes.has(3)).toBe(false);
  });

  it('tampoco por un envío: el bucle se busca por routeTo Y por sends', () => {
    const { project, ids } = base(1);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 3 } });
    project.mixer[5]!.sends = [{ target: 3, level: 0.5 }];
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);
    expect(resolveGroupBuses(project).routes.has(3)).toBe(false);
  });

  it('ni entre dos carpetas encadenadas (el bucle se mira sobre lo ya resuelto)', () => {
    const { project, ids } = base(2);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 3 } });
    applyCommand(project, { type: 'patchChannel', channelId: ids[1]!, patch: { mixerTrack: 5 } });
    const a = group('A', { busTrack: 5 }); // 3 → 5
    const b = group('B', { busTrack: 3 }); // 5 → 3 cerraría el círculo
    applyCommand(project, { type: 'addChannelGroup', group: a });
    applyCommand(project, { type: 'addChannelGroup', group: b });
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { groupId: a.id } });
    applyCommand(project, { type: 'patchChannel', channelId: ids[1]!, patch: { groupId: b.id } });

    const routes = resolveGroupBuses(project).routes;
    expect(routes.get(3)).toBe(5);
    expect(routes.has(5)).toBe(false);
  });

  it('un canal NUEVO en la carpeta va al bus sin que nadie lo enrute a mano', () => {
    // Es el motivo entero de la función: agrupar la batería no puede ser
    // acordarse de mandar seis canales a la misma pista, ni mantenerlo cuando
    // entra el séptimo.
    const { project, ids } = base(2);
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);

    const nuevo = createChannel('drums', 2, 'Clap');
    applyCommand(project, { type: 'addChannel', channel: nuevo });
    expect(trackOfChannel(project, nuevo.id)).toBe(0); // suelto: al Master
    applyCommand(project, {
      type: 'patchChannel',
      channelId: nuevo.id,
      patch: { groupId: g.id },
    });
    expect(trackOfChannel(project, nuevo.id)).toBe(5); // dentro: al bus, solo
  });

  it('un canal que sale de la carpeta vuelve a su pista sin tocar nada más', () => {
    const { project, ids } = base(1);
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);
    expect(trackOfChannel(project, ids[0]!)).toBe(5);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { groupId: '' } });
    expect(trackOfChannel(project, ids[0]!)).toBe(0);
  });

  it('quitar la carpeta suelta el bus: los canales vuelven a donde estaban', () => {
    const { project, ids } = base(2);
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);
    const inverse = applyCommand(project, { type: 'removeChannelGroup', groupId: g.id });
    expect(resolveGroupBuses(project).channels.size).toBe(0);
    // Y el undo devuelve la carpeta CON su bus y con sus canales dentro.
    applyCommand(project, inverse);
    expect(project.channelGroups[g.id]!.busTrack).toBe(5);
    expect(resolveGroupBuses(project).channels.get(ids[0]!)).toBe(5);
  });
});

describe('bus de carpeta — por el bus de comandos, con su inverso', () => {
  it('poner el bus se deshace dejando la carpeta sin bus', () => {
    const { project, ids } = base(1);
    const g = group('Drums');
    putInGroup(project, g, ids);

    const inverse = applyCommand(project, {
      type: 'patchChannelGroup',
      groupId: g.id,
      patch: { busTrack: 5 },
    });
    expect(trackOfChannel(project, ids[0]!)).toBe(5);

    applyCommand(project, inverse);
    expect(groupBusTrack(project, project.channelGroups[g.id])).toBeNull();
    expect(trackOfChannel(project, ids[0]!)).toBe(0);
  });

  it('el inverso viaja por la sala: quitar el bus se guarda como 0, no como undefined', () => {
    const { project, ids } = base(1);
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);

    const inverse = applyCommand(project, {
      type: 'patchChannelGroup',
      groupId: g.id,
      patch: { busTrack: 0 },
    });
    // Un `undefined` se pierde al serializar y el inverso llegaría sin nada que
    // devolver; el 0 sobrevive al viaje.
    expect(JSON.parse(JSON.stringify(inverse))).toEqual(inverse);
    applyCommand(project, inverse);
    expect(project.channelGroups[g.id]!.busTrack).toBe(5);
  });

  it('el inverso de estrenar un bus SOBREVIVE al viaje a la sala', () => {
    const { project, ids } = base(1);
    const g = group('Drums'); // nace sin busTrack: el inverso sería `undefined`
    putInGroup(project, g, ids);

    const inverse = applyCommand(project, {
      type: 'patchChannelGroup',
      groupId: g.id,
      patch: { busTrack: 5 },
    });
    // JSON.stringify borra las claves que valen undefined: si el inverso
    // llevara `busTrack: undefined`, en los demás clientes el undo llegaría con
    // el patch VACÍO y el bus se quedaría puesto. El valor neutro es el 0.
    const overTheWire = JSON.parse(JSON.stringify(inverse)) as typeof inverse;
    expect(overTheWire).toEqual(inverse);
    applyCommand(project, overTheWire);
    expect(groupBusTrack(project, project.channelGroups[g.id])).toBeNull();
    expect(trackOfChannel(project, ids[0]!)).toBe(0);
  });

  it('el inverso de mutear una carpeta también viaja entero', () => {
    const { project, ids } = base(1);
    const g = group('Drums');
    putInGroup(project, g, ids);
    const inverse = applyCommand(project, {
      type: 'patchChannelGroup',
      groupId: g.id,
      patch: { mute: true, solo: true },
    });
    expect(JSON.parse(JSON.stringify(inverse))).toEqual(inverse);
    expect(inverse).toMatchObject({ patch: { mute: false, solo: false } });
  });

  it('mute y solo de la carpeta también tienen inverso', () => {
    const { project, ids } = base(1);
    const g = group('Drums');
    putInGroup(project, g, ids);
    const inverse = applyCommand(project, {
      type: 'patchChannelGroup',
      groupId: g.id,
      patch: { mute: true },
    });
    expect(channelMuteOn(project, project.channels[ids[0]!]!)).toBe(true);
    applyCommand(project, inverse);
    expect(channelMuteOn(project, project.channels[ids[0]!]!)).toBe(false);
  });
});

describe('mute/solo de carpeta', () => {
  it('el mute de la carpeta apaga sus canales sin tocar el mute de cada uno', () => {
    const { project, ids } = base(2);
    const g = group('Drums');
    putInGroup(project, g, ids);
    // Uno de ellos ya estaba muteado a mano.
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mute: true } });
    applyCommand(project, { type: 'patchChannelGroup', groupId: g.id, patch: { mute: true } });

    const anySolo = anyChannelSoloOn(project);
    expect(ids.map((id) => channelAudible(project, project.channels[id]!, anySolo))).toEqual([
      false,
      false,
    ]);
    // Y al quitar el mute de la carpeta, el canal que estaba muteado SIGUE muteado.
    applyCommand(project, { type: 'patchChannelGroup', groupId: g.id, patch: { mute: false } });
    expect(channelMuteOn(project, project.channels[ids[0]!]!)).toBe(true);
    expect(channelMuteOn(project, project.channels[ids[1]!]!)).toBe(false);
  });

  it('el solo de la carpeta enmudece lo de fuera y el solo gana al mute', () => {
    const { project, ids } = base(3);
    const g = group('Drums');
    putInGroup(project, g, [ids[0]!, ids[1]!]);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mute: true } });
    applyCommand(project, { type: 'patchChannelGroup', groupId: g.id, patch: { solo: true } });

    const anySolo = anyChannelSoloOn(project);
    expect(anySolo).toBe(true);
    expect(ids.map((id) => channelAudible(project, project.channels[id]!, anySolo))).toEqual([
      true, // muteado a mano, pero el solo de la carpeta manda
      true,
      false, // fuera de la carpeta
    ]);
  });

  it('una carpeta VACÍA en solo no enmudece el proyecto entero', () => {
    const { project, ids } = base(2);
    const g = group('Vacía', { solo: true });
    applyCommand(project, { type: 'addChannelGroup', group: g });

    const anySolo = anyChannelSoloOn(project);
    expect(anySolo).toBe(false);
    expect(ids.every((id) => channelAudible(project, project.channels[id]!, anySolo))).toBe(true);
  });

  it('un canal en solo dentro de una carpeta muteada suena (el solo manda)', () => {
    const { project, ids } = base(2);
    const g = group('Drums', { mute: true });
    putInGroup(project, g, ids);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { solo: true } });

    const anySolo = anyChannelSoloOn(project);
    expect(channelSoloOn(project, project.channels[ids[0]!]!)).toBe(true);
    expect(channelAudible(project, project.channels[ids[0]!]!, anySolo)).toBe(true);
    expect(channelAudible(project, project.channels[ids[1]!]!, anySolo)).toBe(false);
  });
});

describe('el bus en el grafo y en el mixer', () => {
  it('el cable del canal se pinta hacia el bus, no hacia el Master', () => {
    const { project, ids } = base(1);
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);
    const edge = routingEdges(project).find((e) => e.kind === 'channel' && e.from === ids[0]);
    expect(edge?.to).toBe(5);
  });

  it('el cable de la pista propia se pinta hacia el bus', () => {
    const { project, ids } = base(1);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 3 } });
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);
    const edge = routingEdges(project).find((e) => e.kind === 'route' && e.from === 3);
    expect(edge?.to).toBe(5);
  });

  it('el bus se enseña en el mixer aunque esté recién estrenado y vacío', () => {
    const { project, ids } = base(1);
    putInGroup(project, group('Drums', { busTrack: 7 }), ids);
    expect(usedTracks(project)).toContain(7);
  });

  it('busTracks dice de qué carpeta es cada bus, y la primera gana el empate', () => {
    const { project } = base(0);
    const a = group('A', { busTrack: 5 });
    const b = group('B', { busTrack: 5 });
    applyCommand(project, { type: 'addChannelGroup', group: a });
    applyCommand(project, { type: 'addChannelGroup', group: b });
    expect(busTracks(project).get(5)?.id).toBe(a.id);
  });

  it('freeBusTrack no estrena una pista ocupada ni el bus de otra carpeta', () => {
    const { project, ids } = base(1);
    applyCommand(project, { type: 'patchChannel', channelId: ids[0]!, patch: { mixerTrack: 1 } });
    applyCommand(project, { type: 'addChannelGroup', group: group('A', { busTrack: 2 }) });
    project.mixer[3]!.sends = [{ target: 4, level: 0.5 }];
    // 1 tiene canal, 2 es bus, 3 manda un envío y 4 lo recibe → la primera libre es la 5.
    expect(freeBusTrack(project)).toBe(5);
  });
});

describe('serialización .orbit', () => {
  it('un .orbit sin carpetas abre igual que siempre', () => {
    const { project } = base(2);
    const raw = JSON.parse(serializeProject(project)) as Record<string, unknown>;
    delete raw['channelGroups'];
    delete raw['channelGroupOrder'];
    const back = parseProject(JSON.stringify(raw));
    expect(back.channelGroups).toEqual({});
    expect(back.channelGroupOrder).toEqual([]);
    expect(resolveGroupBuses(back).channels.size).toBe(0);
  });

  it('una carpeta de antes del bus (sin busTrack) abre y suena igual', () => {
    const { project, ids } = base(1);
    const g = group('Drums');
    putInGroup(project, g, ids);
    const back = parseProject(serializeProject(project));
    expect(back.channelGroups[g.id]!.busTrack).toBeUndefined();
    expect(trackOfChannel(back, ids[0]!)).toBe(0);
  });

  it('el bus sobrevive a guardar y abrir', () => {
    const { project, ids } = base(1);
    putInGroup(project, group('Drums', { busTrack: 5, mute: true }), ids);
    const back = parseProject(serializeProject(project));
    expect(trackOfChannel(back, ids[0]!)).toBe(5);
    expect(anyChannelSoloOn(back)).toBe(false);
    expect(channelMuteOn(back, back.channels[ids[0]!]!)).toBe(true);
  });

  it('un busTrack corrupto del disco no llega al motor', () => {
    const { project, ids } = base(1);
    const g = group('Drums', { busTrack: 5 });
    putInGroup(project, g, ids);
    const raw = JSON.parse(serializeProject(project)) as {
      channelGroups: Record<string, Record<string, unknown>>;
    };
    raw.channelGroups[g.id]!['busTrack'] = 4.5;
    const back = parseProject(JSON.stringify(raw));
    expect(back.channelGroups[g.id]!.busTrack).toBeUndefined();
    expect(trackOfChannel(back, ids[0]!)).toBe(0);
  });

  it('el formato NO sube de versión: es aditivo, y una versión vieja lo abre', () => {
    const { project, ids } = base(1);
    putInGroup(project, group('Drums', { busTrack: 5 }), ids);
    const raw = JSON.parse(serializeProject(project)) as { formatVersion: number };
    expect(raw.formatVersion).toBe(1);
    // Lo que hace una versión sin buses: ignora el campo que no conoce. El canal
    // conserva su `mixerTrack`, así que pierde el agrupamiento pero NO el audio.
    expect(project.channels[ids[0]!]!.mixerTrack).toBe(0);
  });
});
