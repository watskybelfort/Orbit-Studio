/**
 * @orbit/server — servidor de colaboración (rooms + presencia).
 *
 * Relay del protocolo y-websocket implementado a mano con `ws` + y-protocols
 * (la build actual de y-websocket ya no publica `bin/utils`, así que el
 * setupWSConnection es nuestro):
 *
 * - Un Y.Doc + Awareness por room; rooms por path: ws://host:7777/<código>
 *   (código de 6 chars A-Z2-9 sin ambiguos; se aceptan guiones/minúsculas).
 * - messageType 0 → y-sync (step1/step2/update), messageType 1 → awareness.
 * - Persistencia: al cerrar el último socket de un room se guarda
 *   Y.encodeStateAsUpdate en ./rooms/<código>.bin; al abrirlo, se recarga.
 * - GET /health → {rooms: n}.
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer, WebSocket as WsSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const PORT = Number(process.env.PORT ?? 7777);
const ROOMS_DIR = resolve('./rooms');
const PING_INTERVAL_MS = 30000;

/** 6 chars del alfabeto sin ambiguos (sin O/0 ni I/1). */
const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

function roomFile(code: string): string {
  return join(ROOMS_DIR, `${code}.bin`);
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
      Y.applyUpdate(this.doc, new Uint8Array(readFileSync(file)));
      console.log(`[room ${code}] abierto (cargado de ${file})`);
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
    mkdirSync(ROOMS_DIR, { recursive: true });
    writeFileSync(roomFile(this.code), Y.encodeStateAsUpdate(this.doc));
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

const httpServer = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rooms: rooms.size }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

const wss = new WebSocketServer({ server: httpServer });

/** Keepalive: sockets que no responden al ping se terminan. */
const alive = new Map<WsSocket, boolean>();
setInterval(() => {
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
  // Normaliza: sin barras, sin guiones, en mayúsculas ("k3p-9qf" → "K3P9QF").
  const code = rawPath.replace(/\//g, '').replace(/-/g, '').toUpperCase();
  if (!ROOM_CODE_RE.test(code)) {
    console.warn(`[server] room inválido rechazado: "${rawPath}"`);
    conn.close(1008, 'Código de room inválido');
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

httpServer.listen(PORT, () => {
  console.log(`Orbit Studio collab server en ws://localhost:${PORT}/<room> (health: http://localhost:${PORT}/health)`);
});

// Cierre limpio: guarda todos los rooms abiertos antes de salir.
process.on('SIGINT', () => {
  console.log('\n[server] cerrando: guardando rooms…');
  for (const room of rooms.values()) {
    room.persist();
    room.destroy();
  }
  process.exit(0);
});
