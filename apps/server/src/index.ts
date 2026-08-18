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
  MESSAGE_AUDIO,
  MESSAGE_CONTROL,
  encodeControl,
  parseControl,
  type CollabRole,
} from '@orbit/collab';
import { normalizeRoomCode } from './room-path';
import { RoomRoles, checkEntry, entryKey, type RawLogEntry } from './room-roles';

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
  /** Entradas del log ya juzgadas (se re-siembra con lo que queda en el log). */
  private validated = new Set<string>();

  constructor(code: string) {
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

    // Lo que ya estaba guardado se da por bueno: se validó cuando se escribió
    // y sus emisores hace tiempo que no están (juzgarlo ahora con el rol de un
    // desconocido borraría trabajo legítimo).
    this.validated = new Set(
      this.doc.getArray<RawLogEntry>('commands').toArray().map((entry) => entryKey(entry)),
    );

    // El log es el proyecto: cada entrada nueva se juzga con el rol que ESTE
    // servidor le da a su emisor, no con el que la entrada dice traer.
    this.doc.getArray<RawLogEntry>('commands').observe((_event, transaction) => {
      if (transaction.origin === ROLE_ENFORCER) return;
      this.enforceRoles();
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

  /** Petición de control de un cliente (hoy solo el reparto de roles). */
  private handleControl(conn: WsSocket, json: string): void {
    const message = parseControl(json);
    if (!message || message.type !== 'setRole') return;
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
   * Juzga las entradas nuevas del log y RETIRA las que el rol de su emisor no
   * permite. Borrarlas es una operación normal del CRDT: converge en todos los
   * clientes, y el que las mandó re-deriva su estado y se queda como la sala.
   */
  private enforceRoles(): void {
    const log = this.doc.getArray<RawLogEntry>('commands');
    const entries = log.toArray();
    const offenders: { index: number; conn: WsSocket | undefined; reason: string; type: string }[] =
      [];

    entries.forEach((entry, index) => {
      const key = entryKey(entry);
      if (this.validated.has(key)) return;
      const client = typeof entry.client === 'number' ? entry.client : undefined;
      const conn = client === undefined ? undefined : this.clientOwner.get(client);
      const role = this.roles.roleOf(conn === undefined ? undefined : this.connKeys.get(conn));
      const verdict = checkEntry(entry, role);
      if (!verdict.allowed) {
        const cmd = entry.cmd as { type?: unknown } | undefined;
        offenders.push({
          index,
          conn,
          reason: verdict.reason ?? 'Tu rol no permite ese cambio.',
          type: typeof cmd?.type === 'string' ? cmd.type : '?',
        });
      }
    });

    if (offenders.length > 0) {
      // De atrás hacia delante: borrar por índice mueve lo que viene después.
      this.doc.transact(() => {
        for (const offender of [...offenders].reverse()) log.delete(offender.index, 1);
      }, ROLE_ENFORCER);
      for (const offender of offenders) {
        console.warn(`[room ${this.code}] retirado del log: ${offender.type} (${offender.reason})`);
        if (offender.conn) {
          this.sendControl(offender.conn, {
            type: 'denied',
            reason: offender.reason,
            command: offender.type,
          });
        }
      }
    }

    // Se re-siembra con lo que queda: así la lista no crece sin fin y lo que
    // se lleve una compactación deja de ocupar sitio.
    this.validated = new Set(log.toArray().map((entry) => entryKey(entry)));
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

function getRoom(code: string): Room {
  let room = rooms.get(code);
  if (!room) {
    room = new Room(code);
    rooms.set(code, room);
  }
  return room;
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
  const roomCapacity = clampRoomCapacity(
    opts.roomCapacity ??
      (process.env.ORBIT_ROOM_CAPACITY === undefined
        ? undefined
        : Number(process.env.ORBIT_ROOM_CAPACITY)),
  );
  if (opts.roomsDir) roomsDir = resolve(opts.roomsDir);

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

    const room = getRoom(code);
    room.addConn(conn);
    alive.set(conn, true);
    console.log(`[room ${code}] peer conectado (${room.conns.size} en el room)`);

    conn.on('pong', () => alive.set(conn, true));
    conn.on('message', (data: RawData) => room.handleMessage(conn, toUint8(data)));
    conn.on('error', (err) => console.error(`[room ${code}] error de socket:`, err.message));
    conn.on('close', () => {
      alive.delete(conn);
      room.removeConn(conn);
      console.log(`[room ${code}] peer desconectado (${room.conns.size} en el room)`);
      if (room.empty) {
        room.persist();
        room.destroy();
        rooms.delete(code);
        console.log(`[room ${code}] cerrado y guardado en ${roomFile(code)}`);
      }
    });
  });

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
        console.warn(`[server] ATENCIÓN: escuchando en ${host} (accesible desde la red) y SIN autenticación.`);
      }
      resolveP({
        port: boundPort,
        roomCapacity,
        host,
        close: () =>
          new Promise<void>((res) => {
            clearInterval(keepalive);
            for (const room of rooms.values()) {
              room.persist();
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
  });
}
