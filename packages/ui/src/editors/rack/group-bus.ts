/**
 * El bus de una carpeta del rack, visto desde la UI: qué comandos hay que
 * mandar para estrenarlo, moverlo o quitarlo.
 *
 * Vive fuera del componente por lo de siempre —así se puede probar sin montar
 * React— y porque la operación NO es un solo comando: estrenar un bus es
 * apuntarlo en la carpeta y, si la pista está virgen, ponerle el nombre y el
 * color de la carpeta para que el mixer no enseñe un "Insert 7" anónimo donde
 * suena la batería. Las dos cosas tienen que ser UN paso de undo.
 *
 * La elección de qué pista se estrena no se decide aquí: sale de `freeBusTrack`
 * en @orbit/core, para que el rack, la paleta y Claude por MCP estrenen la misma.
 */

import {
  freeBusTrack,
  groupBusTrack,
  type ChannelGroup,
  type Command,
  type Project,
} from '@orbit/core';

export interface GroupBusChange {
  commands: Command[];
  label: string;
  /** Pista que queda como bus (null = la carpeta se queda sin bus). */
  busTrack: number | null;
}

/** ¿La pista sigue como la creó el proyecto? (nombre y color de fábrica). */
function isVirginTrack(project: Project, index: number): boolean {
  const track = project.mixer[index];
  if (!track || index === 0) return false;
  return track.name === `Insert ${index}` && track.slots.every((s) => s === null);
}

/**
 * Comandos para dejar el bus de `group` en `busTrack` (null o 0 = sin bus).
 * Devuelve null si no hay nada que hacer o la pista no sirve.
 */
export function setGroupBusCommands(
  project: Project,
  group: ChannelGroup,
  busTrack: number | null,
): GroupBusChange | null {
  const current = groupBusTrack(project, group);
  const next =
    busTrack !== null && Number.isInteger(busTrack) && busTrack > 0 && busTrack < project.mixer.length
      ? busTrack
      : null;
  if (next === current) return null;

  if (next === null) {
    return {
      // El 0 y no un `undefined`: el inverso de este comando viaja por la sala
      // serializado, y un undefined se pierde por el camino (ver ChannelGroup).
      commands: [{ type: 'patchChannelGroup', groupId: group.id, patch: { busTrack: 0 } }],
      label: `Quitar el bus de "${group.name}"`,
      busTrack: null,
    };
  }

  const commands: Command[] = [
    { type: 'patchChannelGroup', groupId: group.id, patch: { busTrack: next } },
  ];
  if (isVirginTrack(project, next)) {
    commands.push({
      type: 'patchMixerTrack',
      trackIndex: next,
      patch: { name: group.name, color: group.color },
    });
  }
  return {
    commands,
    label: `Bus de "${group.name}" → pista ${next}`,
    busTrack: next,
  };
}

/**
 * Comandos para estrenar un bus en la primera pista libre. Null si el mixer
 * está lleno (mejor decirlo que robarle a alguien una pista con cosas dentro).
 */
export function createGroupBusCommands(
  project: Project,
  group: ChannelGroup,
): GroupBusChange | null {
  const free = freeBusTrack(project);
  if (free === null) return null;
  return setGroupBusCommands(project, group, free);
}

/** Un comando suelto, o el lote entero si son varios. */
export function asSingleCommand(commands: Command[], label: string): Command | null {
  if (commands.length === 0) return null;
  if (commands.length === 1) return commands[0]!;
  return { type: 'batch', label, commands };
}
