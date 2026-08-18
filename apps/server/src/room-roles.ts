/**
 * Los roles de una sala, decididos por el SERVIDOR.
 *
 * El rol era autodeclarado: el cliente decía el suyo en su presencia y lo
 * sellaba en cada entrada del log. Servía para repartir trabajo entre gente
 * que se conoce, no para impedir nada — cambiar un campo bastaba para
 * "ascender". Aquí vive la parte que sí decide:
 *
 * - quién es productor (el primero que entra; si se va, hereda el siguiente
 *   más antiguo, para que la sala no se quede sin nadie que reparta);
 * - qué rol tiene cada conexión y quién puede cambiárselo a otro;
 * - y si una entrada del log la puede firmar quien la firma.
 *
 * Es un módulo puro sobre identificadores: ni sockets ni Yjs, para poder
 * probarlo entero sin levantar nada.
 */

import { checkRole, type CollabRole } from '@orbit/collab';
import type { Command } from '@orbit/core';

/** Rol de quien entra en una sala que ya tiene productor. */
export const JOIN_ROLE: CollabRole = 'invitado';

/** Identificador interno de una conexión (el orden de llegada). */
export type ConnKey = number;

export interface RoleAssignment {
  /** Rol que le toca. */
  role: CollabRole;
  /** true si es el productor por ser el primero (o por herencia). */
  host: boolean;
}

/**
 * Roles de una sala. Guarda el orden de llegada porque de ahí sale quién
 * hereda el mando cuando el productor se va.
 */
export class RoomRoles {
  private readonly roles = new Map<ConnKey, CollabRole>();
  /** Orden de llegada (el primero de la lista es el más antiguo). */
  private readonly order: ConnKey[] = [];

  /** Entra una conexión: productor si no hay ninguno, invitado si ya lo hay. */
  join(key: ConnKey): RoleAssignment {
    if (this.roles.has(key)) {
      return { role: this.roles.get(key)!, host: this.roles.get(key) === 'productor' };
    }
    const hasProducer = [...this.roles.values()].includes('productor');
    const role: CollabRole = hasProducer ? JOIN_ROLE : 'productor';
    this.roles.set(key, role);
    this.order.push(key);
    return { role, host: role === 'productor' };
  }

  /**
   * Se va una conexión. Si era la única productora y queda gente, el mando
   * pasa a la más antigua: una sala sin productor no se puede administrar (y
   * nadie podría volver a repartir roles).
   */
  leave(key: ConnKey): { promoted: ConnKey | null } {
    const wasProducer = this.roles.get(key) === 'productor';
    this.roles.delete(key);
    const at = this.order.indexOf(key);
    if (at >= 0) this.order.splice(at, 1);
    if (!wasProducer) return { promoted: null };
    if ([...this.roles.values()].includes('productor')) return { promoted: null };
    const heir = this.order[0];
    if (heir === undefined) return { promoted: null };
    this.roles.set(heir, 'productor');
    return { promoted: heir };
  }

  get(key: ConnKey): CollabRole | undefined {
    return this.roles.get(key);
  }

  /** Rol con el que se juzga a un desconocido: el más restringido que edita. */
  roleOf(key: ConnKey | undefined): CollabRole {
    if (key === undefined) return JOIN_ROLE;
    return this.roles.get(key) ?? JOIN_ROLE;
  }

  isProducer(key: ConnKey): boolean {
    return this.roles.get(key) === 'productor';
  }

  /**
   * Un productor cambia el rol de otro. Devuelve false si quien lo pide no es
   * productor, si el destino no existe, o si sería el último productor
   * degradándose a sí mismo (la sala se quedaría sin quien reparta).
   */
  setRole(by: ConnKey, target: ConnKey, role: CollabRole): boolean {
    if (!this.isProducer(by)) return false;
    if (!this.roles.has(target)) return false;
    if (this.roles.get(target) === role) return false;
    if (
      role !== 'productor' &&
      this.roles.get(target) === 'productor' &&
      [...this.roles.values()].filter((r) => r === 'productor').length === 1
    ) {
      return false;
    }
    this.roles.set(target, role);
    return true;
  }

  /** Tabla completa (para el mensaje que ve todo el mundo). */
  entries(): [ConnKey, CollabRole][] {
    return this.order
      .filter((key) => this.roles.has(key))
      .map((key) => [key, this.roles.get(key)!] as [ConnKey, CollabRole]);
  }

  get size(): number {
    return this.roles.size;
  }
}

/** Entrada del log tal y como la ve el servidor (no confía en su forma). */
export interface RawLogEntry {
  cmd?: unknown;
  client?: unknown;
  seq?: unknown;
  user?: unknown;
  role?: unknown;
  own?: unknown;
}

export interface EntryVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * ¿Puede esta entrada estar en el log, con el rol que el SERVIDOR le da a su
 * emisor? Una entrada sin comando reconocible se rechaza igual: el log es el
 * proyecto, y ahí no entra lo que no se entiende.
 */
export function checkEntry(entry: RawLogEntry, role: CollabRole): EntryVerdict {
  const cmd = entry.cmd;
  if (typeof cmd !== 'object' || cmd === null || typeof (cmd as Command).type !== 'string') {
    return { allowed: false, reason: 'Entrada sin comando válido.' };
  }
  // `own` (borrar algo propio) es del emisor y no se puede verificar aquí sin
  // reconstruir la sesión entera; se acepta tal cual, igual que hacen los
  // clientes. Lo que ya no se acepta es el ROL: ese lo pone el servidor.
  return checkRole(role, cmd as Command, { ownCreation: entry.own === true });
}

/** Clave estable de una entrada (para no revalidar lo ya visto). */
export function entryKey(entry: RawLogEntry): string {
  return `${String(entry.client)}:${String(entry.seq)}`;
}
