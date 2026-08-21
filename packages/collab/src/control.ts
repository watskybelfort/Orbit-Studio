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
import {
  AUTH_MAX_ITERATIONS,
  AUTH_MIN_ITERATIONS,
  parseRoomAuth,
  type RoomAuthRecord,
} from './room-auth';
import {
  INVITE_MAX_TTL_MS,
  INVITE_MAX_USES,
  INVITE_MIN_TTL_MS,
  parseInviteToken,
  type RoomInvitePublic,
} from './room-invite';

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
  | { type: 'denied'; reason: string; command?: string }
  /**
   * Servidor → el que llama a la puerta: esta sala tiene contraseña. Con la
   * sal y las iteraciones el cliente deriva su clave, y con el nonce (de un
   * solo uso) firma la prueba. Ver room-auth.ts.
   */
  | { type: 'challenge'; salt: string; iterations: number; nonce: string }
  /** Cliente → servidor: la prueba de que sabe la contraseña (no la contraseña). */
  | { type: 'auth'; proof: string }
  /** Servidor → el que acertó: pasa; el sync empieza AHORA. */
  | { type: 'authOk' }
  /** Productor → servidor: pon (o quita, con null) la contraseña de la sala. */
  | { type: 'setPassword'; auth: RoomAuthRecord | null }
  /** Servidor → todos: si la sala está protegida (para pintar el candado). */
  | { type: 'roomAuth'; protected: boolean }
  /** Productor → servidor: crea una invitación que caduca y se gasta. */
  | { type: 'createInvite'; ttlMs: number; uses: number }
  /**
   * Servidor → el productor que la pidió: el token, UNA vez.
   *
   * El servidor guarda el hash, así que este mensaje es la única oportunidad de
   * ver el secreto. Si se pierde, se revoca y se hace otra.
   */
  | { type: 'inviteCreated'; token: string; expiresAt: number; uses: number }
  /** Productor → servidor: revoca una invitación por su id. */
  | { type: 'revokeInvite'; id: string }
  /** Servidor → el productor: las invitaciones vivas (sin nada con que entrar). */
  | { type: 'invites'; list: RoomInvitePublic[] }
  /**
   * Cliente → servidor, EN LA PUERTA: entro con esta invitación en vez de con
   * la contraseña. Es la alternativa a `auth`, no un añadido: se responde al
   * mismo `challenge`.
   */
  | { type: 'joinInvite'; token: string };

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
    case 'challenge': {
      const salt = o['salt'];
      const nonce = o['nonce'];
      const iterations = o['iterations'];
      if (typeof salt !== 'string' || typeof nonce !== 'string') return null;
      if (typeof iterations !== 'number' || !Number.isInteger(iterations)) return null;
      // Las iteraciones las manda el OTRO lado: si se aceptara un 1, cualquiera
      // que se ponga en medio convertiría el PBKDF2 en un hash de un vistazo.
      if (iterations < AUTH_MIN_ITERATIONS || iterations > AUTH_MAX_ITERATIONS) return null;
      return { type: 'challenge', salt, iterations, nonce };
    }
    case 'auth': {
      const proof = o['proof'];
      // Una prueba es SHA-256 en base64: 44 caracteres. Un megabyte de "prueba"
      // no se mira siquiera.
      if (typeof proof !== 'string' || proof.length > 128) return null;
      return { type: 'auth', proof };
    }
    case 'authOk':
      return { type: 'authOk' };
    case 'setPassword': {
      const auth = o['auth'];
      if (auth === null) return { type: 'setPassword', auth: null };
      const record = parseRoomAuth(auth);
      return record ? { type: 'setPassword', auth: record } : null;
    }
    case 'createInvite': {
      const ttlMs = o['ttlMs'];
      const uses = o['uses'];
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) return null;
      if (typeof uses !== 'number' || !Number.isFinite(uses)) return null;
      // Se acota AQUÍ además de al crear el registro: lo que llega por el
      // socket no decide cuánto dura una llave de esta sala.
      return {
        type: 'createInvite',
        ttlMs: Math.min(INVITE_MAX_TTL_MS, Math.max(INVITE_MIN_TTL_MS, Math.floor(ttlMs))),
        uses: Math.min(INVITE_MAX_USES, Math.max(1, Math.floor(uses))),
      };
    }
    case 'inviteCreated': {
      const token = o['token'];
      const expiresAt = o['expiresAt'];
      const uses = o['uses'];
      if (parseInviteToken(token) === null) return null;
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;
      if (typeof uses !== 'number' || !Number.isFinite(uses)) return null;
      return { type: 'inviteCreated', token: token as string, expiresAt, uses };
    }
    case 'revokeInvite': {
      const id = o['id'];
      if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
      return { type: 'revokeInvite', id };
    }
    case 'invites': {
      const list = o['list'];
      if (!Array.isArray(list)) return null;
      const clean: RoomInvitePublic[] = [];
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        const x = item as Record<string, unknown>;
        if (typeof x['id'] !== 'string') continue;
        if (typeof x['expiresAt'] !== 'number' || typeof x['uses'] !== 'number') continue;
        if (typeof x['createdAt'] !== 'number' || typeof x['by'] !== 'string') continue;
        clean.push({
          id: x['id'],
          expiresAt: x['expiresAt'],
          uses: x['uses'],
          createdAt: x['createdAt'],
          by: x['by'].slice(0, 40),
        });
      }
      return { type: 'invites', list: clean };
    }
    case 'joinInvite': {
      const token = o['token'];
      return parseInviteToken(token) === null
        ? null
        : { type: 'joinInvite', token: token as string };
    }
    case 'roomAuth': {
      const isProtected = o['protected'];
      return typeof isProtected === 'boolean'
        ? { type: 'roomAuth', protected: isProtected }
        : null;
    }
    default:
      return null;
  }
}
