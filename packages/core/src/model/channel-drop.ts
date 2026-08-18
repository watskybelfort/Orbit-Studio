/**
 * Arrastrar un canal del rack: a dónde va y en qué orden queda.
 *
 * El rack pinta las carpetas en `channelGroupOrder` y, dentro de cada una, sus
 * canales en el orden de `channelOrder`; lo que no está en ninguna carpeta va
 * suelto al final. Así que un arrastre son SIEMPRE dos cosas: en qué carpeta
 * acaba el canal (`groupId`, cadena vacía = suelto) y en qué sitio de
 * `channelOrder` se queda.
 *
 * Aquí solo vive esa cuenta —sin React y sin comandos—: el índice que sale es
 * el que espera `moveChannel`, es decir, el sitio del canal DESPUÉS de haberlo
 * sacado de la lista (splice out, splice in).
 */

import type { Id, Project } from './types';

/** Dónde se soltó el canal. */
export type ChannelDropTarget =
  /** Sobre otra fila: `before` decide si cae encima o debajo de ella. */
  | { kind: 'row'; channelId: Id; before: boolean }
  /** Sobre la cabecera (o el cuerpo) de una carpeta: entra al final de ella. */
  | { kind: 'group'; groupId: Id }
  /** Sobre la zona de sueltos: sale de la carpeta y se va al final del rack. */
  | { kind: 'loose' };

export interface ChannelDropPlan {
  /** Carpeta en la que acaba; '' = suelto (ver `Channel.groupId`). */
  groupId: Id | '';
  /** Índice destino en `channelOrder`, en la semántica de `moveChannel`. */
  toIndex: number;
  /** El canal cambia de carpeta. */
  changesGroup: boolean;
  /** El canal cambia de sitio en `channelOrder`. */
  moves: boolean;
}

/**
 * Carpeta REAL de un canal: la cadena vacía si no tiene, y también si apunta a
 * una carpeta que ya no existe (el rack pinta esos canales sueltos, así que
 * arrastrarlos a "suelto" no puede ser un no-op invisible).
 */
export function groupOfChannel(project: Project, channelId: Id): Id | '' {
  const gid = project.channels[channelId]?.groupId;
  return gid && project.channelGroups[gid] ? gid : '';
}

/**
 * Traduce un drop en un plan. Devuelve `null` cuando no hay nada que hacer:
 * el canal no existe, se soltó sobre sí mismo, o el destino ya es su sitio.
 */
export function planChannelDrop(
  project: Project,
  channelId: Id,
  target: ChannelDropTarget,
): ChannelDropPlan | null {
  const from = project.channelOrder.indexOf(channelId);
  if (from < 0 || !project.channels[channelId]) return null;

  // Orden sin el canal arrastrado: es sobre ESTA lista sobre la que se
  // cuentan los índices, porque moveChannel lo saca antes de volver a meterlo.
  const rest = project.channelOrder.filter((id) => id !== channelId);
  // Se compara con lo GUARDADO, no con la carpeta efectiva: si el canal
  // arrastra un groupId colgado (una carpeta borrada por la sala, p. ej.),
  // soltarlo entre los sueltos aprovecha para limpiárselo.
  const current = project.channels[channelId]?.groupId ?? '';

  let groupId: Id | '';
  let toIndex: number;

  switch (target.kind) {
    case 'row': {
      if (target.channelId === channelId) return null;
      const at = rest.indexOf(target.channelId);
      if (at < 0) return null;
      groupId = groupOfChannel(project, target.channelId);
      toIndex = target.before ? at : at + 1;
      break;
    }
    case 'group': {
      if (!project.channelGroups[target.groupId]) return null;
      groupId = target.groupId;
      const members = rest.filter((id) => groupOfChannel(project, id) === groupId);
      const last = members[members.length - 1];
      // Carpeta vacía: el sitio en channelOrder da igual (no hay nada con lo
      // que ordenarse), así que se queda donde estaba y solo cambia de carpeta.
      toIndex = last === undefined ? Math.min(from, rest.length) : rest.indexOf(last) + 1;
      break;
    }
    case 'loose': {
      groupId = '';
      toIndex = rest.length;
      break;
    }
  }

  const changesGroup = groupId !== current;
  const moves = toIndex !== from;
  if (!changesGroup && !moves) return null;
  return { groupId, toIndex, changesGroup, moves };
}
