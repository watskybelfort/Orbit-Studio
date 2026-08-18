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
 * - GET /health → {rooms: n}.
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
import { normalizeRoomCode } from './room-path';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

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
const MAX_CONNS_PER_ROOM = 16;
const MAX_CONNS_TOTAL = 512;

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
          for (const id of changes.added) controlled.add(id);
          for (const id of changes.updated) controlled.add(id);
          for (const id of changes.removed) controlled.delete(id);
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
    if (controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...controlled], null);
    }
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
  /** Carpeta donde persistir las salas (.bin). Por defecto ./rooms. */
  roomsDir?: string;
}

export interface ServerHandle {
  readonly port: number;
  readonly host: string;
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
  if (opts.roomsDir) roomsDir = resolve(opts.roomsDir);

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ rooms: rooms.size }));
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
    if (existing && existing.conns.size >= MAX_CONNS_PER_ROOM) {
      conn.close(1013, 'La sala está llena');
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
      const shown = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
      console.log(
        `Orbit Studio collab server en ws://${shown}:${port}/<room> (health: http://${shown}:${port}/health)`,
      );
      if (host !== '127.0.0.1' && host !== '::1') {
        console.warn(`[server] ATENCIÓN: escuchando en ${host} (accesible desde la red) y SIN autenticación.`);
      }
      resolveP({
        port,
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
