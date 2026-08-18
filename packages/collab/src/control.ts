/**
 * Canal de control de la sala (mensajes de tipo 2, junto a sync y awareness).
 *
 * Existe por una razón: hasta ahora el ROL era autodeclarado. Cada cliente
 * decía "soy productor" en su presencia y sellaba ese rol en cada entrada del
 * log; los demás lo creían porque el modelo de confianza era el código de
 * sala. Bastaba con tocar un campo para tener permisos que nadie te dio.
 *
 * Con este canal el rol lo asigna el SERVIDOR (el primero que entra manda, y
 * él reparte), viaja por aquí y el servidor retira del log lo que el rol del
 * emisor no permite. El cliente sigue validando en local —el aviso instantáneo
 * y el rollback optimista son suyos—, pero ya no es la última palabra.
 *
 * El formato es JSON dentro de un mensaje binario para que conviva con los
 * otros dos tipos del protocolo. Aquí solo vive el contrato: encodificar,
 * decodificar y VALIDAR lo que llega (nada de confiar en la forma).
 */

import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { isCollabRole, type CollabRole } from './roles';

/** Tipo de mensaje del protocolo de sala (0 sync · 1 awareness · 2 control). */
export const MESSAGE_CONTROL = 2;

export type ControlMessage =
  /** Servidor → un cliente: el rol que le ha tocado en esta sala. */
  | { type: 'role'; role: CollabRole }
  /** Servidor → todos: qué rol tiene cada clientID (para pintarlo). */
  | { type: 'roles'; roles: Record<string, CollabRole> }
  /** Productor → servidor: cambia el rol de otro. */
  | { type: 'setRole'; client: number; role: CollabRole }
  /** Servidor → el que se pasó: su comando no entró al log. */
  | { type: 'denied'; reason: string; command?: string };

export function encodeControl(message: ControlMessage): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_CONTROL);
  encoding.writeVarString(encoder, JSON.stringify(message));
  return encoding.toUint8Array(encoder);
}

/** Cuerpo de un mensaje de control ya identificado (el tipo ya se leyó). */
export function readControlBody(decoder: decoding.Decoder): ControlMessage | null {
  try {
    return parseControl(decoding.readVarString(decoder));
  } catch {
    return null;
  }
}

/**
 * JSON → mensaje válido, o null. Todo lo que no encaje EXACTAMENTE con una de
 * las formas se descarta: esto lo escribe la red, no nosotros.
 */
export function parseControl(json: string): ControlMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  switch (o['type']) {
    case 'role':
      return isCollabRole(o['role']) ? { type: 'role', role: o['role'] } : null;
    case 'roles': {
      const table = o['roles'];
      if (typeof table !== 'object' || table === null) return null;
      const roles: Record<string, CollabRole> = {};
      for (const [client, role] of Object.entries(table as Record<string, unknown>)) {
        if (/^\d+$/.test(client) && isCollabRole(role)) roles[client] = role;
      }
      return { type: 'roles', roles };
    }
    case 'setRole': {
      const client = o['client'];
      if (typeof client !== 'number' || !Number.isFinite(client) || !isCollabRole(o['role'])) {
        return null;
      }
      return { type: 'setRole', client: Math.floor(client), role: o['role'] };
    }
    case 'denied': {
      const reason = o['reason'];
      if (typeof reason !== 'string') return null;
      const command = o['command'];
      return typeof command === 'string'
        ? { type: 'denied', reason, command }
        : { type: 'denied', reason };
    }
    default:
      return null;
  }
}
