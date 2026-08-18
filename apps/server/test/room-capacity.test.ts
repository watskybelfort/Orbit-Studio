/**
 * Capacidad de sala: cuánta gente cabe dentro.
 *
 * La sala nunca estuvo limitada a dos personas, pero el tope era una constante
 * escondida en el código. Aquí se prueba lo que ahora sí se puede tocar: el
 * ajuste (opción o ORBIT_ROOM_CAPACITY, siempre dentro de rango) y que el
 * servidor deje entrar a TODA la gente que quepa y rechace solo a la de más,
 * con un motivo legible y sin echar a los que ya estaban.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  DEFAULT_ROOM_CAPACITY,
  MAX_ROOM_CAPACITY,
  MIN_ROOM_CAPACITY,
  clampRoomCapacity,
  startServer,
  type ServerHandle,
} from '../src/index';

const ROOM = 'K3P9QF';

let handle: ServerHandle | null = null;
let dir: string | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

/** Servidor en un puerto libre (0 = el que dé el sistema) y salas en un temporal. */
async function serve(roomCapacity?: number): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-rooms-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomCapacity, roomsDir: dir });
  return handle;
}

/**
 * Abre un socket y dice si el servidor lo aceptó o lo echó.
 *
 * Ojo: el rechazo por cota llega DESPUÉS del handshake (el server acepta la
 * conexión y la cierra con su motivo), así que ver 'open' no basta — hay que
 * darle un margen y comprobar que sigue vivo.
 */
function connect(
  port: number,
): Promise<{ ws: WebSocket; result: 'open' } | { result: 'closed'; code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/${ROOM}`);
    let settled = false;
    const done = (value: { ws: WebSocket; result: 'open' } | { result: 'closed'; code: number; reason: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('sin respuesta del servidor'));
    }, 5000);
    ws.on('open', () => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) done({ ws, result: 'open' });
      }, 250);
    });
    ws.on('close', (code, reason) => done({ result: 'closed', code, reason: reason.toString() }));
    ws.on('error', () => {
      // El rechazo puede llegar también como error; el motivo viene en 'close'.
    });
  });
}

async function health(port: number): Promise<{ rooms: number; conns: number; roomCapacity: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return (await res.json()) as { rooms: number; conns: number; roomCapacity: number };
}

describe('clampRoomCapacity', () => {
  it('sin valor cae al de por defecto', () => {
    expect(clampRoomCapacity(undefined)).toBe(DEFAULT_ROOM_CAPACITY);
    expect(clampRoomCapacity(Number.NaN)).toBe(DEFAULT_ROOM_CAPACITY);
  });

  it('recorta a los límites y redondea', () => {
    expect(clampRoomCapacity(0)).toBe(MIN_ROOM_CAPACITY);
    expect(clampRoomCapacity(1000)).toBe(MAX_ROOM_CAPACITY);
    expect(clampRoomCapacity(5.4)).toBe(5);
  });

  it('deja pasar un valor normal (más de dos personas)', () => {
    expect(clampRoomCapacity(8)).toBe(8);
  });
});

describe('servidor: cuánta gente cabe en una sala', () => {
  it('entran los que caben y el de más se va con un motivo legible', async () => {
    const server = await serve(3);
    expect(server.roomCapacity).toBe(3);

    const a = await connect(server.port);
    const b = await connect(server.port);
    const c = await connect(server.port);
    expect([a.result, b.result, c.result]).toEqual(['open', 'open', 'open']);

    const d = await connect(server.port);
    expect(d.result).toBe('closed');
    if (d.result === 'closed') {
      expect(d.code).toBe(1013);
      expect(d.reason).toContain('llena');
    }

    // Los tres de dentro siguen dentro.
    const info = await health(server.port);
    expect(info.roomCapacity).toBe(3);
    expect(info.conns).toBe(3);

    for (const conn of [a, b, c]) if (conn.result === 'open') conn.ws.close();
  });

  it('la capacidad por defecto deja sitio a bastante más de dos', async () => {
    const server = await serve();
    expect(server.roomCapacity).toBe(DEFAULT_ROOM_CAPACITY);
    expect(server.roomCapacity).toBeGreaterThan(2);
    expect((await health(server.port)).roomCapacity).toBe(DEFAULT_ROOM_CAPACITY);
  });

  it('una capacidad absurda se ajusta en vez de romper el arranque', async () => {
    const server = await serve(999);
    expect(server.roomCapacity).toBe(MAX_ROOM_CAPACITY);
  });
});
