/**
 * @orbit/server — servidor de colaboración (rooms + presencia).
 *
 * Relay del protocolo y-websocket implementado a mano con `ws` + y-protocols
 * (la build actual de y-websocket ya no publica `bin/utils`, así que el
 * setupWSConnection es nuestro):
 *
 * - Un Y.Doc + Awareness por room; rooms por path: ws://host:7900/<código>
 *   (código de 6 chars A-Z2-9 sin ambiguos; se aceptan guiones/minúsculas).
 * - messageType 0 → y-sync (step1/step2/update), messageType 1 → awareness.
 * - Persistencia: al cerrar el último socket de un room se guarda
 *   Y.encodeStateAsUpdate en <roomsDir>/<código>.bin; al abrirlo, se recarga.
 *   Ahí dentro van también los BYTES de los samples de la sala, así que el que
 *   vuelva mañana sigue oyendo los sonidos que subió el otro.
 * - GET /health → {rooms, conns, roomCapacity}.
 * - Cuánta gente cabe en una sala: ORBIT_ROOM_CAPACITY (o `roomCapacity` al
 *   arrancar la librería); 16 por defecto, entre 2 y 64.
 *
 * Este módulo es una LIBRERÍA: `startServer()` arranca una instancia y devuelve
 * un handle para cerrarla. La app de escritorio lo arranca en proceso (botón del
 * panel de colaboración) y el CLI (`src/cli.ts`) lo corre suelto con `tsx`.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer, WebSocket as WsSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  AUDIO_MAX_SAMPLES,
  INVITE_MAX_PER_ROOM,
  MESSAGE_AUDIO,
  MESSAGE_CONTROL,
  authMessage,
  consumeInvite,
  encodeControl,
  makeInviteRecord,
  newInviteToken,
  parseControl,
  publicInvite,
  randomNonce,
  verifyProof,
  type CollabRole,
  type RoomAuthRecord,
  type RoomInviteRecord,
} from '@orbit/collab';
import { RoomAuthStore } from './auth-store';
import { normalizeRoomCode } from './room-path';
import { RoomRoles, checkEntry, strictestRole, type RawLogEntry } from './room-roles';

// Dónde escuchar (localhost, una IP concreta, todas) vive aparte y se
// reexporta: la app de escritorio lo necesita para su desplegable.
export {
  HOST_ALL,
  HOST_LOCAL,
  describeAddress,
  hostWasHonored,
  isOpenToNetwork,
  resolveHost,
  sortAddresses,
  type HostAddress,
} from './host';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// MESSAGE_CONTROL (2) lo define @orbit/collab: es el canal por el que el
// servidor reparte los roles y retira lo que un rol no permite.

// 7900 evita los rangos que Hyper-V reserva en Windows (p. ej. 7698-7797,
// donde caía el 7777 clásico): netsh interface ipv4 show excludedportrange
const DEFAULT_PORT = Number(process.env.PORT ?? 7900);
// Por defecto SOLO localhost: la colaboración es entre pestañas/máquina propia y
// el server no tiene autenticación. Para colaborar entre máquinas hay que abrirlo
// a la red a conciencia con HOST=0.0.0.0 (idealmente detrás de un túnel/VPN).
const DEFAULT_HOST = process.env.HOST ?? '127.0.0.1';
// Carpeta de persistencia de salas; startServer puede cambiarla (p. ej. a
// userData cuando la arranca la app empaquetada, donde ./rooms sería de solo lectura).
let roomsDir = resolve('./rooms');
const PING_INTERVAL_MS = 30000;

// Cotas para que un cliente hostil no agote memoria/disco abriendo salas y
// conexiones sin fin (el server crea una Room por cada código válido).
const MAX_ROOMS = 200;
/**
 * Cuánta gente cabe en una sala. Era una constante de 16; ahora es solo el
 * valor POR DEFECTO y se puede mover por opción (`startServer`) o por entorno
 * (`ORBIT_ROOM_CAPACITY`): el tope existe para acotar memoria, no para decidir
 * con cuánta gente se puede trabajar.
 */
export const DEFAULT_ROOM_CAPACITY = 16;
/** Rango admitido: con menos de 2 no hay sala, y más de 64 no lo aguanta el sync. */
export const MIN_ROOM_CAPACITY = 2;
export const MAX_ROOM_CAPACITY = 64;

/** Capacidad válida a partir de un valor cualquiera (undefined y NaN incluidos). */
export function clampRoomCapacity(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ROOM_CAPACITY;
  return Math.min(MAX_ROOM_CAPACITY, Math.max(MIN_ROOM_CAPACITY, Math.round(value)));
}
const MAX_CONNS_TOTAL = 512;

/** Origen de las transacciones del guardia de roles (para no re-juzgarlas). */
const ROLE_ENFORCER = 'orbit:roles';

// El doc de una sala ya no lleva solo comandos: lleva los BYTES de los samples
// (Y.Map 'assets', ver packages/collab/src/assets.ts). El primer sync manda el
// estado ENTERO en un solo mensaje, así que el tope de payload tiene que quedar
// por encima del presupuesto de assets (64 MB) MÁS el proyecto, el log y el
// chat. Los 100 MiB por defecto de `ws` dan poco margen para una sala llena.
const MAX_PAYLOAD_BYTES = 192 * 1024 * 1024;

function roomFile(code: string): string {
  return join(roomsDir, `${code}.bin`);
}

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// ── Room ─────────────────────────────────────────────────────────────────────

/**
 * Lo que la sala necesita del servidor para la puerta. La sala sabe QUIÉN puede
 * cambiar la contraseña (el rol es suyo); dónde se guarda, no es asunto suyo.
 */
interface RoomHooks {
  isProtected(): boolean;
  setPassword(record: RoomAuthRecord | null): void;
  /** Invitaciones vivas de esta sala. */
  invites(): RoomInviteRecord[];
  /** Guarda la lista; false si no hay dónde (sala sin contraseña). */
  setInvites(list: RoomInviteRecord[]): boolean;
}

class Room {
  readonly code: string;
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  /** Socket → clientIDs de awareness que controla (para limpiar al cerrar). */
  readonly conns = new Map<WsSocket, Set<number>>();
  /** Roles de la sala: los decide el servidor, no el cliente (room-roles.ts). */
  private readonly roles = new RoomRoles();
  /** Socket → su identificador interno en la tabla de roles. */
  private readonly connKeys = new Map<WsSocket, number>();
  private nextConnKey = 1;
  /** clientID de Yjs → socket que lo controla (para saber quién firma qué). */
  private readonly clientOwner = new Map<number, WsSocket>();

  constructor(
    code: string,
    private readonly hooks: RoomHooks,
  ) {
    this.code = code;
    this.awareness.setLocalState(null); // el server no tiene presencia propia

    const file = roomFile(code);
    if (existsSync(file)) {
      try {
        Y.applyUpdate(this.doc, new Uint8Array(readFileSync(file)));
        console.log(`[room ${code}] abierto (cargado de ${file})`);
      } catch (err) {
        // Un .bin truncado o corrupto NO puede dejar la sala imposible de abrir
        // para siempre: se aparta a .corrupt y la sala arranca vacía.
        const corrupt = `${file}.corrupt`;
        try {
          renameSync(file, corrupt);
        } catch {
          // si tampoco se puede apartar, al menos no propagamos
        }
        console.error(`[room ${code}] .bin ilegible, apartado a ${corrupt}; sala vacía:`, err);
      }
    } else {
      console.log(`[room ${code}] abierto (nuevo)`);
    }

    // Lo que ya estaba guardado se da por bueno: se validó cuando se escribió y
    // sus emisores hace tiempo que no están. Se carga ANTES de poner el
    // observador, así que no pasa por el guardia.

    // El log es el proyecto: cada entrada nueva se juzga con el rol que ESTE
    // servidor le da a su emisor. Y el emisor es el SOCKET por el que entra, no
    // el `client` que la entrada dice traer: ese campo lo escribe el cliente, y
    // creerlo era dejar que un invitado firmara con el clientID del productor.
    this.doc.getArray<RawLogEntry>('commands').observe((event, transaction) => {
      if (transaction.origin === ROLE_ENFORCER) return;
      const from = transaction.origin instanceof WsSocket ? transaction.origin : undefined;
      this.enforceRoles(event, from);
    });

    // El log no es lo único que es el proyecto: en `meta` vive el SNAPSHOT, la
    // base que carga todo el que entra. Sin vigilarlo, un invitado reescribía
    // el proyecto entero sin tocar ni una entrada del log.
    this.doc.getMap<string | number>('meta').observe((event, transaction) => {
      if (transaction.origin === ROLE_ENFORCER) return;
      const from = transaction.origin instanceof WsSocket ? transaction.origin : undefined;
      this.enforceMeta(event, from);
    });

    // Cualquier update del doc (venga del socket que venga) → a todos.
    this.doc.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });

    // Cambios de presencia → a todos; además registra qué clientIDs
    // controla cada socket.
    this.awareness.on(
      'update',
      (
        changes: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const controlled = this.conns.get(origin as WsSocket);
        if (controlled) {
          for (const id of changes.added) {
            controlled.add(id);
            this.clientOwner.set(id, origin as WsSocket);
          }
          for (const id of changes.updated) {
            controlled.add(id);
            this.clientOwner.set(id, origin as WsSocket);
          }
          for (const id of changes.removed) {
            controlled.delete(id);
            this.clientOwner.delete(id);
          }
          // Con la presencia ya sabemos quién firma qué: la tabla de roles se
          // reparte otra vez para que la UI pueda pintarla.
          if (changes.added.length > 0) this.broadcastRoles();
        }
        const changed = changes.added.concat(changes.updated, changes.removed);
        if (changed.length === 0) return;
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
        );
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  addConn(conn: WsSocket): void {
    this.conns.set(conn, new Set());
    const key = this.nextConnKey++;
    this.connKeys.set(conn, key);
    const { role } = this.roles.join(key);
    this.sendControl(conn, { type: 'role', role });
    // Si la sala tiene contraseña, el que entra ya la ha pasado; se le dice de
    // todas formas para que el panel pinte el candado y el productor sepa si
    // hay que ponerla.
    this.sendControl(conn, { type: 'roomAuth', protected: this.hooks.isProtected() });
    this.broadcastRoles();
    // El server también inicia el sync (modelo cliente-servidor de y-sync).
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    conn.send(encoding.toUint8Array(encoder));
    // Presencia actual del room para el que entra.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aEncoder = encoding.createEncoder();
      encoding.writeVarUint(aEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        aEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      conn.send(encoding.toUint8Array(aEncoder));
    }
  }

  handleMessage(conn: WsSocket, data: Uint8Array): void {
    try {
      const decoder = decoding.createDecoder(data);
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, conn);
          // step1 del cliente → respondemos step2 solo a él.
          if (encoding.length(encoder) > 1) {
            conn.send(encoding.toUint8Array(encoder));
          }
          break;
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            this.awareness,
            decoding.readVarUint8Array(decoder),
            conn,
          );
          break;
        }
        case MESSAGE_CONTROL: {
          this.handleControl(conn, decoding.readVarString(decoder));
          break;
        }
        case MESSAGE_AUDIO: {
          // Streaming del master: se reparte tal cual y NO se guarda (no es
          // parte del proyecto). Solo se mira el tamaño, para que un cliente
          // roto —o listo— no llene la sala con un trozo de diez minutos.
          if (data.byteLength <= AUDIO_MAX_SAMPLES * 2 + 64) {
            this.broadcastExcept(conn, data);
          }
          break;
        }
        default:
          break; // tipos desconocidos: se ignoran
      }
    } catch (err) {
      console.error(`[room ${this.code}] mensaje inválido:`, err);
    }
  }

  removeConn(conn: WsSocket): void {
    const controlled = this.conns.get(conn);
    if (!controlled) return;
    this.conns.delete(conn);
    for (const client of controlled) this.clientOwner.delete(client);
    if (controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
    }
    const key = this.connKeys.get(conn);
    this.connKeys.delete(conn);
    if (key === undefined) return;
    const { promoted } = this.roles.leave(key);
    if (promoted !== null) {
      for (const [socket, other] of this.connKeys) {
        if (other === promoted) this.sendControl(socket, { type: 'role', role: 'productor' });
      }
      console.log(`[room ${this.code}] el mando pasa a la conexión ${promoted}`);
    }
    if (this.conns.size > 0) this.broadcastRoles();
  }

  get empty(): boolean {
    return this.conns.size === 0;
  }

  persist(): void {
    mkdirSync(roomsDir, { recursive: true });
    // Escritura atómica: a un temporal y rename. Un crash a mitad de escritura
    // no deja un .bin truncado que luego brickee la sala.
    const file = roomFile(this.code);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc));
    renameSync(tmp, file);
  }

  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }

  /** Un mensaje de control a una conexión concreta. */
  private sendControl(conn: WsSocket, message: Parameters<typeof encodeControl>[0]): void {
    if (conn.readyState === WsSocket.OPEN) conn.send(encodeControl(message));
  }

  /** La tabla de roles por clientID de Yjs (lo que la UI sabe pintar). */
  private broadcastRoles(): void {
    const table: Record<string, CollabRole> = {};
    for (const [conn, key] of this.connKeys) {
      const role = this.roles.get(key);
      if (!role) continue;
      for (const client of this.conns.get(conn) ?? []) table[String(client)] = role;
    }
    this.broadcast(encodeControl({ type: 'roles', roles: table }));
  }

  /** Petición de control de un cliente: reparto de roles y puerta de la sala. */
  private handleControl(conn: WsSocket, json: string): void {
    const message = parseControl(json);
    if (!message) return;
    if (message.type === 'setPassword') {
      this.handleSetPassword(conn, message.auth);
      return;
    }
    if (message.type === 'createInvite') {
      void this.handleCreateInvite(conn, message.ttlMs, message.uses);
      return;
    }
    if (message.type === 'revokeInvite') {
      this.handleRevokeInvite(conn, message.id);
      return;
    }
    if (message.type !== 'setRole') return;
    const by = this.connKeys.get(conn);
    if (by === undefined) return;
    // El destino viaja como clientID de Yjs (es lo que la UI conoce).
    const target = this.clientOwner.get(message.client);
    const targetKey = target === undefined ? undefined : this.connKeys.get(target);
    if (targetKey === undefined) return;
    if (!this.roles.setRole(by, targetKey, message.role)) {
      this.sendControl(conn, {
        type: 'denied',
        reason: 'No puedes cambiar ese rol (o dejarías la sala sin productor).',
      });
      return;
    }
    if (target) this.sendControl(target, { type: 'role', role: message.role });
    this.broadcastRoles();
    console.log(`[room ${this.code}] rol de ${message.client} → ${message.role}`);
  }

  /**
   * Poner o quitar la contraseña de la sala. Es cosa del PRODUCTOR y lo juzga
   * el servidor con el rol que él reparte, igual que el resto: un invitado que
   * mande este mensaje a mano no cambia la puerta de nadie.
   */
  private handleSetPassword(conn: WsSocket, record: RoomAuthRecord | null): void {
    const by = this.connKeys.get(conn);
    if (by === undefined || !this.roles.isProducer(by)) {
      this.sendControl(conn, {
        type: 'denied',
        reason: 'Solo el productor cambia la contraseña de la sala.',
      });
      return;
    }
    this.hooks.setPassword(record);
    // Los que ya están dentro NO se echan: cambiar la cerradura vale para el
    // que llame a partir de ahora (echar a la sala entera por cambiar la
    // contraseña sería una forma rara de perder el trabajo de todos).
    this.broadcast(encodeControl({ type: 'roomAuth', protected: record !== null }));
    console.log(
      `[room ${this.code}] contraseña ${record === null ? 'quitada' : 'puesta'} por el productor`,
    );
  }

  /** Solo el productor toca las llaves de la sala. Devuelve si puede seguir. */
  private guardProducer(conn: WsSocket, what: string): boolean {
    const by = this.connKeys.get(conn);
    if (by !== undefined && this.roles.isProducer(by)) return true;
    this.sendControl(conn, { type: 'denied', reason: `Solo el productor ${what}.` });
    return false;
  }

  /** Manda al que pregunta la lista de invitaciones vivas (sin nada con que entrar). */
  private sendInvites(conn: WsSocket): void {
    this.sendControl(conn, { type: 'invites', list: this.hooks.invites().map(publicInvite) });
  }

  /**
   * Crea una invitación y devuelve el token UNA vez.
   *
   * El servidor guarda el hash, así que este es el único momento en el que el
   * secreto existe fuera de quien lo va a usar: si se pierde, se revoca y se
   * hace otra. Va solo al que la pidió, no a la sala.
   */
  private async handleCreateInvite(conn: WsSocket, ttlMs: number, uses: number): Promise<void> {
    if (!this.guardProducer(conn, 'crea invitaciones')) return;
    if (!this.hooks.isProtected()) {
      this.sendControl(conn, {
        type: 'denied',
        reason: 'Ponle contraseña a la sala primero: sin puerta, entra quien sepa el código.',
      });
      return;
    }
    const live = this.hooks.invites();
    if (live.length >= INVITE_MAX_PER_ROOM) {
      this.sendControl(conn, {
        type: 'denied',
        reason: `Ya hay ${live.length} invitaciones vivas: revoca alguna antes.`,
      });
      return;
    }
    try {
      const fresh = newInviteToken();
      const by = this.connKeys.get(conn);
      const record = await makeInviteRecord(
        fresh,
        ttlMs,
        uses,
        by === undefined ? 'productor' : String(by),
        Date.now(),
      );
      if (!this.hooks.setInvites([...live, record])) {
        this.sendControl(conn, { type: 'denied', reason: 'No se pudo guardar la invitación.' });
        return;
      }
      this.sendControl(conn, {
        type: 'inviteCreated',
        token: fresh.token,
        expiresAt: record.expiresAt,
        uses: record.uses,
      });
      this.sendInvites(conn);
      console.log(
        `[room ${this.code}] invitación creada (${record.uses} uso(s), caduca en ` +
          `${Math.round((record.expiresAt - Date.now()) / 60000)} min)`,
      );
    } catch (err) {
      console.error(`[room ${this.code}] no se pudo crear la invitación:`, err);
      this.sendControl(conn, { type: 'denied', reason: 'No se pudo crear la invitación.' });
    }
  }

  private handleRevokeInvite(conn: WsSocket, id: string): void {
    if (!this.guardProducer(conn, 'revoca invitaciones')) return;
    const live = this.hooks.invites();
    this.hooks.setInvites(live.filter((r) => r.id !== id));
    this.sendInvites(conn);
    console.log(`[room ${this.code}] invitación ${id} revocada`);
  }

  /**
   * Juzga las entradas nuevas del log y RETIRA las que el rol de su emisor no
   * permite. Borrarlas es una operación normal del CRDT: converge en todos los
   * clientes, y el que las mandó re-deriva su estado y se queda como la sala.
   */
  private enforceRoles(event: Y.YArrayEvent<RawLogEntry>, from: WsSocket | undefined): void {
    const log = this.doc.getArray<RawLogEntry>('commands');
    const senderRole = this.roles.roleOf(from === undefined ? undefined : this.connKeys.get(from));
    const offenders: { index: number; reason: string; type: string }[] = [];

    // Solo se juzga lo que ENTRA en esta transacción, recorriendo el delta. Lo
    // que ya estaba no se vuelve a mirar, y esto sustituye a la lista de
    // "entradas ya vistas" que había antes: aquella se indexaba por
    // `client:seq`, dos campos que escribe el cliente, así que repetir una
    // clave ya usada saltaba la validación entera.
    let index = 0;
    for (const part of event.changes.delta) {
      if (part.retain !== undefined) {
        index += part.retain;
        continue;
      }
      // Un borrado no ocupa sitio en el estado nuevo: no mueve el índice.
      if (part.insert === undefined) continue;
      const inserted = Array.isArray(part.insert) ? (part.insert as RawLogEntry[]) : [];
      for (const entry of inserted) {
        const verdict = checkEntry(entry, this.roleForEntry(entry, from, senderRole));
        if (!verdict.allowed) {
          const cmd = entry.cmd as { type?: unknown } | undefined;
          offenders.push({
            index,
            reason: verdict.reason ?? 'Tu rol no permite ese cambio.',
            type: typeof cmd?.type === 'string' ? cmd.type : '?',
          });
        }
        index++;
      }
    }

    if (offenders.length === 0) return;
    // De atrás hacia delante: borrar por índice mueve lo que viene después.
    this.doc.transact(() => {
      for (const offender of [...offenders].reverse()) log.delete(offender.index, 1);
    }, ROLE_ENFORCER);
    for (const offender of offenders) {
      console.warn(`[room ${this.code}] retirado del log: ${offender.type} (${offender.reason})`);
      if (from) {
        this.sendControl(from, {
          type: 'denied',
          reason: offender.reason,
          command: offender.type,
        });
      }
    }
  }

  /**
   * Con qué rol se juzga una entrada concreta.
   *
   * Manda el socket por el que ENTRA. Si además dice venir de otro cliente que
   * está en la sala —Yjs reenvía lo que a uno le llegó, así que pasa de
   * verdad—, se aplica el más restringido de los dos: el reenvío legítimo
   * sigue funcionando y "firmo con el clientID del productor" deja de servir.
   */
  private roleForEntry(
    entry: RawLogEntry,
    from: WsSocket | undefined,
    senderRole: CollabRole,
  ): CollabRole {
    const client = typeof entry.client === 'number' ? entry.client : undefined;
    const owner = client === undefined ? undefined : this.clientOwner.get(client);
    if (owner === undefined || owner === from) return senderRole;
    return strictestRole(senderRole, this.roles.roleOf(this.connKeys.get(owner)));
  }

  /**
   * El snapshot de `meta` es el proyecto que carga todo el que entra: solo lo
   * toca un productor. Lo que escriba otro se REVIERTE al valor anterior (o se
   * borra, si la clave no existía), que es lo mismo que se hace con el log.
   *
   * Quién compacta es cosa del cliente, pero desde aquí queda dicho: el que
   * escriba el snapshot sin ser productor, no lo escribe.
   */
  private enforceMeta(
    event: Y.YMapEvent<string | number>,
    from: WsSocket | undefined,
  ): void {
    const role = this.roles.roleOf(from === undefined ? undefined : this.connKeys.get(from));
    if (role === 'productor') return;
    const meta = this.doc.getMap<string | number>('meta');
    const keys = [...event.changes.keys.entries()];
    if (keys.length === 0) return;
    this.doc.transact(() => {
      for (const [key, change] of keys) {
        if (change.action === 'add') meta.delete(key);
        else if (change.oldValue !== undefined) meta.set(key, change.oldValue as string | number);
      }
    }, ROLE_ENFORCER);
    console.warn(`[room ${this.code}] revertido en meta: ${keys.map(([k]) => k).join(', ')}`);
    if (from) {
      this.sendControl(from, {
        type: 'denied',
        reason: 'Solo el productor puede reescribir la base del proyecto.',
        command: 'snapshot',
      });
    }
  }

  /** A todos menos al que lo mandó (el audio propio ya suena en su máquina). */
  private broadcastExcept(from: WsSocket, message: Uint8Array): void {
    for (const conn of this.conns.keys()) {
      if (conn !== from && conn.readyState === WsSocket.OPEN) conn.send(message);
    }
  }

  private broadcast(message: Uint8Array): void {
    for (const conn of this.conns.keys()) {
      if (conn.readyState === WsSocket.OPEN) conn.send(message);
    }
  }
}

// ── Servidor ─────────────────────────────────────────────────────────────────

const rooms = new Map<string, Room>();

/** Las contraseñas viven en disco, junto a las salas, y NUNCA en el Y.Doc. */
const authStore = new RoomAuthStore(() => roomsDir);

function getRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code, {
      isProtected: () => authStore.isProtected(code),
      setPassword: (record) => authStore.set(code, record),
      invites: () => authStore.getInvites(code),
      setInvites: (list) => authStore.setInvites(code, list),
    });
    rooms.set(code, room);
  }
  return room;
}

/**
 * Cuánto se espera a que el que llama a la puerta enseñe su prueba. Lo suyo
 * tarda lo que tarde el PBKDF2 en su máquina (~150 ms); 20 s es de sobra y
 * evita que dejar sockets a medias sea gratis.
 */
const AUTH_TIMEOUT_MS = 20_000;

/** Cierres del protocolo: 1008 "no entras", 1013 "ahora no". */
const CLOSE_POLICY = 1008;
const CLOSE_TRY_LATER = 1013;

/** Un mensaje de control suelto (o null si no lo es). */
function readControl(data: Uint8Array): ReturnType<typeof parseControl> {
  try {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== MESSAGE_CONTROL) return null;
    return parseControl(decoding.readVarString(decoder));
  } catch {
    return null;
  }
}

/** Una conexión que ya recibió su desafío y todavía no ha entrado a la sala. */
interface PendingAuth {
  code: string;
  /** El mensaje que hay que firmar: sala + nonce de esta conexión. */
  message: string;
  timer: ReturnType<typeof setTimeout>;
  /** Ya se está comprobando una prueba: las demás se ignoran. */
  checking: boolean;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /**
   * Cuánta gente cabe por sala. Por defecto ORBIT_ROOM_CAPACITY o 16; el valor
   * se ajusta al rango admitido, así que un número absurdo no rompe el arranque.
   */
  roomCapacity?: number;
  /** Carpeta donde persistir las salas (.bin). Por defecto ./rooms. */
  roomsDir?: string;
}

export interface ServerHandle {
  readonly port: number;
  readonly host: string;
  /** Cuánta gente cabe en cada sala de esta instancia. */
  readonly roomCapacity: number;
  /** Guarda las salas, cierra sockets y libera el puerto. */
  close(): Promise<void>;
}

/**
 * Arranca una instancia del servidor de colaboración. Resuelve cuando está
 * escuchando; rechaza si el puerto está ocupado o no se puede enlazar.
 */
export function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  // Una variable de entorno DEFINIDA Y VACÍA no es "no la han puesto": es ''.
  // Y `Number('')` es 0, que el clamp sube a 2 — justo el límite de dos
  // personas que la capacidad configurable vino a quitar.
  const rawCapacity = process.env.ORBIT_ROOM_CAPACITY;
  const roomCapacity = clampRoomCapacity(
    opts.roomCapacity ??
      (rawCapacity === undefined || rawCapacity.trim() === '' ? undefined : Number(rawCapacity)),
  );
  if (opts.roomsDir) roomsDir = resolve(opts.roomsDir);
  // La caché de puertas es de una instancia: si el servidor se rearranca (otra
  // carpeta de salas, o el mismo proceso levantándolo de nuevo), lo que valga
  // es lo que haya AHORA en disco, no lo que se leyó la vez anterior.
  authStore.forget();

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rooms: rooms.size, conns: alive.size, roomCapacity }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });

  // ws re-emite los errores de listen del http server por aquí; sin handler
  // tirarían el proceso con un stack crudo.
  wss.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EACCES' && err.code !== 'EADDRINUSE') throw err;
  });

  /** Los que están en la puerta: conectados, con desafío, todavía fuera. */
  const pending = new Map<WsSocket, PendingAuth>();

  /** Keepalive: sockets que no responden al ping se terminan. */
  const alive = new Map<WsSocket, boolean>();
  const keepalive = setInterval(() => {
    for (const [conn, ok] of alive) {
      if (!ok) {
        conn.terminate();
        continue;
      }
      alive.set(conn, false);
      conn.ping();
    }
  }, PING_INTERVAL_MS);

  wss.on('connection', (conn, req) => {
    // PRIMERO el handler de errores, antes de cualquier validación. `close()`
    // solo INICIA el cierre: `ws` sigue parseando lo que llegue, y un frame mal
    // formado emite 'error' sobre un EventEmitter sin listener, lo que en Node
    // es una excepción no capturada — es decir, el proceso entero se cae por
    // una conexión que ni siquiera hemos aceptado.
    conn.on('error', (err) => console.error('[server] error de socket:', err.message));

    const rawPath = (req.url ?? '').split('?')[0] ?? '';
    const code = normalizeRoomCode(rawPath);
    if (!code) {
      console.warn(`[server] room inválido rechazado: "${rawPath}"`);
      conn.close(1008, 'Código de room inválido');
      return;
    }

    // Cotas antes de crear/entrar: sala nueva que superaría el máximo de salas,
    // conexiones totales, o sala ya llena → se rechaza sin reservar recursos.
    const existing = rooms.get(code);
    if (!existing && rooms.size >= MAX_ROOMS) {
      conn.close(1013, 'El servidor está lleno');
      return;
    }
    if (alive.size >= MAX_CONNS_TOTAL) {
      conn.close(1013, 'Demasiadas conexiones');
      return;
    }
    if (existing && existing.conns.size >= roomCapacity) {
      conn.close(1013, `La sala está llena (caben ${roomCapacity})`);
      return;
    }

    alive.set(conn, true);
    conn.on('pong', () => alive.set(conn, true));
    conn.on('message', (data: RawData) => onMessage(conn, code, toUint8(data)));
    conn.on('close', () => {
      alive.delete(conn);
      const waiting = pending.get(conn);
      if (waiting) {
        clearTimeout(waiting.timer);
        pending.delete(conn);
        return; // nunca llegó a entrar: no hay sala de la que sacarlo
      }
      const room = rooms.get(code);
      if (!room) return;
      room.removeConn(conn);
      console.log(`[room ${code}] peer desconectado (${room.conns.size} en el room)`);
      if (room.empty) {
        // Guardar puede fallar (disco lleno, carpeta de solo lectura, el .bin
        // bloqueado por un antivirus a mitad del rename). Si eso escapa de un
        // handler de evento, se lleva el proceso por delante Y deja la sala
        // vacía en el mapa para siempre: memoria que no vuelve y un hueco menos
        // en MAX_ROOMS. Perder el guardado es malo; perder el servidor, peor.
        try {
          room.persist();
          console.log(`[room ${code}] cerrado y guardado en ${roomFile(code)}`);
        } catch (err) {
          console.error(`[room ${code}] no se pudo guardar:`, err);
        } finally {
          room.destroy();
          rooms.delete(code);
        }
      }
    });

    // La puerta va ANTES de crear la sala: un desconocido no debería poder
    // hacer que el servidor abra un .bin de 60 MB solo por conectarse.
    const record = authStore.get(code);
    if (record) {
      const nonce = randomNonce();
      const timer = setTimeout(() => {
        if (!pending.delete(conn)) return;
        conn.close(CLOSE_POLICY, 'Se acabó el tiempo para la contraseña');
      }, AUTH_TIMEOUT_MS);
      pending.set(conn, { code, message: authMessage(code, nonce), timer, checking: false });
      conn.send(
        encodeControl({
          type: 'challenge',
          salt: record.salt,
          iterations: record.iterations,
          nonce,
        }),
      );
      console.log(`[room ${code}] alguien llama a la puerta (sala con contraseña)`);
      return;
    }

    admit(conn, code);
  });

  /** Entra de verdad: crea o abre la sala y empieza el sync. */
  function admit(conn: WsSocket, code: string): void {
    const room = getRoom(code);
    room.addConn(conn);
    console.log(`[room ${code}] peer conectado (${room.conns.size} en el room)`);
  }

  /**
   * Todo lo que llega por el socket. Mientras la conexión está en la puerta
   * SOLO se mira su prueba: ni sync, ni presencia, ni audio. Sin esto, "pedir
   * contraseña" sería un cartel en la puerta con la casa abierta.
   */
  function onMessage(conn: WsSocket, code: string, data: Uint8Array): void {
    const waiting = pending.get(conn);
    if (!waiting) {
      // La pertenencia se comprueba EXPLÍCITAMENTE. No basta con "no está en la
      // puerta": al que se le acaba el tiempo, al que falla la contraseña y al
      // que se rechaza por sala llena se les saca de `pending` y se les cierra,
      // pero `close()` no corta la entrega — sus mensajes seguirían llegando y
      // caerían aquí como si fueran de alguien de dentro.
      const room = rooms.get(code);
      if (room?.conns.has(conn)) room.handleMessage(conn, data);
      return;
    }
    if (waiting.checking) return;
    const message = readControl(data);
    if (!message) return;

    /*
     * En la puerta valen DOS respuestas al mismo desafío: la prueba de la
     * contraseña o una invitación. La invitación es la forma de dejar entrar a
     * alguien sin darle la contraseña, así que se comprueba aquí mismo y con
     * las mismas reglas: una por conexión, y fallar cierra.
     */
    if (message.type === 'joinInvite') {
      waiting.checking = true;
      const live = authStore.getInvites(code);
      void consumeInvite(live, message.token, Date.now())
        .then((result) => {
          if (!pending.has(conn)) return;
          clearTimeout(waiting.timer);
          pending.delete(conn);
          authStore.setInvites(code, result.next);
          if (!result.ok) {
            // El motivo se distingue en el LOG pero no en lo que se le dice a
            // quien llama: un mensaje por caso sería un oráculo de qué
            // invitaciones existen.
            console.warn(`[room ${code}] invitación rechazada (${result.reason})`);
            conn.close(CLOSE_POLICY, 'Esa invitación ya no vale');
            return;
          }
          const room = rooms.get(code);
          if (room && room.conns.size >= roomCapacity) {
            conn.close(CLOSE_TRY_LATER, `La sala está llena (caben ${roomCapacity})`);
            return;
          }
          console.log(`[room ${code}] alguien entra con invitación`);
          conn.send(encodeControl({ type: 'authOk' }));
          admit(conn, code);
        })
        .catch((err) => {
          console.error(`[room ${code}] fallo comprobando la invitación:`, err);
          clearTimeout(waiting.timer);
          pending.delete(conn);
          conn.close(CLOSE_POLICY, 'No se pudo comprobar la invitación');
        });
      return;
    }

    if (message.type !== 'auth') return;
    const record = authStore.get(code);
    if (!record) {
      // La contraseña se quitó mientras este llamaba a la puerta: pasa.
      clearTimeout(waiting.timer);
      pending.delete(conn);
      admit(conn, code);
      return;
    }
    waiting.checking = true;
    void verifyProof(record, waiting.message, message.proof)
      .then((ok) => {
        if (!pending.has(conn)) return; // se cerró mientras se comprobaba
        clearTimeout(waiting.timer);
        pending.delete(conn);
        if (!ok) {
          console.warn(`[room ${code}] contraseña incorrecta`);
          conn.close(CLOSE_POLICY, 'Contraseña incorrecta');
          return;
        }
        // La sala pudo llenarse mientras este derivaba su clave.
        const room = rooms.get(code);
        if (room && room.conns.size >= roomCapacity) {
          conn.close(CLOSE_TRY_LATER, `La sala está llena (caben ${roomCapacity})`);
          return;
        }
        conn.send(encodeControl({ type: 'authOk' }));
        admit(conn, code);
      })
      .catch((err) => {
        console.error(`[room ${code}] fallo comprobando la contraseña:`, err);
        clearTimeout(waiting.timer);
        pending.delete(conn);
        conn.close(CLOSE_POLICY, 'No se pudo comprobar la contraseña');
      });
  }

  return new Promise((resolveP, rejectP) => {
    const onListenError = (err: NodeJS.ErrnoException) => {
      clearInterval(keepalive);
      if (err.code === 'EACCES' || err.code === 'EADDRINUSE') {
        rejectP(
          new Error(
            `No se pudo escuchar en el puerto ${port} (${err.code}): puede estar ocupado o ` +
              'en un rango reservado de Windows. Prueba otro puerto.',
          ),
        );
      } else {
        rejectP(err);
      }
    };
    httpServer.once('error', onListenError);
    // `listen` con un puerto imposible (NaN, negativo, > 65535) lanza SÍNCRONO
    // y no pasa por 'error': sin esto, el keepalive y el servidor a medio
    // montar quedan vivos por cada intento fallido, y ese puerto sale de
    // `Number(process.env.PORT)` y del campo del panel.
    try {
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', onListenError);
        // Puerto REAL: con port 0 lo elige el sistema, y quien arranca el server
        // necesita saber cuál le tocó (la app lo enseña, los tests se conectan).
        const addr = httpServer.address();
        const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        const shown = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
        console.log(
          `Orbit Studio collab server en ws://${shown}:${boundPort}/<room> — hasta ${roomCapacity} por sala (health: http://${shown}:${boundPort}/health)`,
        );
        if (host !== '127.0.0.1' && host !== '::1') {
          console.warn(
            `[server] ATENCIÓN: escuchando en ${host} (accesible desde la red) y SIN autenticación.`,
          );
        }
        resolveP({
          port: boundPort,
          roomCapacity,
          host,
          close: () =>
            new Promise<void>((res) => {
              clearInterval(keepalive);
              for (const waiting of pending.values()) clearTimeout(waiting.timer);
              pending.clear();
              for (const room of rooms.values()) {
                try {
                  room.persist();
                } catch (err) {
                  console.error(`[room ${room.code}] no se pudo guardar al cerrar:`, err);
                }
                room.destroy();
              }
              rooms.clear();
              for (const conn of alive.keys()) {
                try {
                  conn.terminate();
                } catch {
                  // best-effort
                }
              }
              alive.clear();
              wss.close(() => httpServer.close(() => res()));
            }),
        });
      });
    } catch (err) {
      clearInterval(keepalive);
      httpServer.removeListener('error', onListenError);
      wss.close();
      httpServer.close();
      rejectP(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
