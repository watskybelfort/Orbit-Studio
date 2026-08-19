/**
 * La puerta vista desde el cliente de verdad (CollabSession contra el servidor
 * de verdad, sin mocks: Node trae WebSocket global).
 *
 * Lo que se prueba aquí y no en room-password.test.ts es el baile del cliente:
 * el saludo del `onopen` se lo come la puerta, así que tras el `authOk` hay que
 * repetirlo. Si eso se olvidara, entrar con la contraseña correcta dejaría la
 * sesión colgada en "Conectando…" para siempre — que es un fallo mucho peor que
 * no dejar entrar.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollabSession } from '@orbit/collab';
import { ProjectStore, createChannel, newId } from '@orbit/core';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'K3P9QF';
const PASSWORD = 'jazz a las tres';

let handle: ServerHandle | null = null;
let dir: string | null = null;
const open: CollabSession[] = [];

afterEach(async () => {
  for (const session of open.splice(0)) session.destroy();
  if (handle) await handle.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function serve(): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-rooms-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

interface Made {
  session: CollabSession;
  store: ProjectStore;
  asked: { wrong: boolean }[];
}

function make(name: string, password?: string): Made {
  const store = new ProjectStore();
  const asked: { wrong: boolean }[] = [];
  const session = new CollabSession(store, {
    user: { name, color: '#5aa9e6' },
    ...(password !== undefined ? { password } : null),
    onPasswordRequired: (wrong) => asked.push({ wrong }),
  });
  open.push(session);
  return { session, store, asked };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('CollabSession y la contraseña de sala', () => {
  it('entrar, poner contraseña y que la sala quede protegida', async () => {
    const server = await serve();
    const { session } = make('Orbit');
    await session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    expect(session.roomHasPassword).toBe(false);

    await session.setRoomPassword(PASSWORD);
    // El servidor confirma por el canal de control.
    for (let i = 0; i < 40 && !session.roomHasPassword; i++) await sleep(25);
    expect(session.roomHasPassword).toBe(true);
  });

  it('sin contraseña no se entra, y lo dice en vez de reintentar en bucle', async () => {
    const server = await serve();
    const dueno = make('Orbit');
    await dueno.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    await dueno.session.setRoomPassword(PASSWORD);
    await sleep(200);

    const visita = make('Invitado');
    await expect(
      visita.session.connect(`ws://127.0.0.1:${server.port}`, ROOM),
    ).rejects.toThrow(/contraseña/i);
    expect(visita.asked).toEqual([{ wrong: false }]);
    expect(visita.session.connected).toBe(false);
  });

  it('con la contraseña equivocada, el aviso distingue que era esa y no otra cosa', async () => {
    const server = await serve();
    const dueno = make('Orbit');
    await dueno.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    await dueno.session.setRoomPassword(PASSWORD);
    await sleep(200);

    const visita = make('Invitado', 'jazz a las cuatro');
    await expect(
      visita.session.connect(`ws://127.0.0.1:${server.port}`, ROOM),
    ).rejects.toThrow(/contraseña/i);
    expect(visita.asked).toEqual([{ wrong: true }]);
  });

  it('con la contraseña buena se entra Y se sincroniza (el saludo se repite tras el authOk)', async () => {
    const server = await serve();
    const dueno = make('Orbit');
    await dueno.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    dueno.store.dispatch(
      { type: 'addChannel', channel: { ...createChannel('sampler', 0, 'Bombo'), id: newId() } },
      { origin: 'local' },
    );
    await dueno.session.setRoomPassword(PASSWORD);
    await sleep(200);

    const visita = make('Invitado', PASSWORD);
    await visita.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    expect(visita.session.connected).toBe(true);
    expect(visita.session.roomHasPassword).toBe(true);
    expect(visita.asked).toEqual([]);

    // Y el proyecto de la sala llega entero: entrar por la puerta no deja al
    // que entra con la sala a medias.
    for (let i = 0; i < 60 && visita.store.project.channelOrder.length === 0; i++) {
      await sleep(25);
    }
    const nombres = visita.store.project.channelOrder.map(
      (id) => visita.store.project.channels[id]?.name,
    );
    expect(nombres).toContain('Bombo');
  });

  it('quitarla vuelve a abrir la sala para el siguiente', async () => {
    const server = await serve();
    const dueno = make('Orbit');
    await dueno.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    await dueno.session.setRoomPassword(PASSWORD);
    await sleep(200);
    await dueno.session.setRoomPassword(null);
    await sleep(200);

    const visita = make('Invitado');
    await visita.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    expect(visita.session.connected).toBe(true);
    expect(visita.session.roomHasPassword).toBe(false);
  });

  it('un invitado no cambia la cerradura', async () => {
    const server = await serve();
    const dueno = make('Orbit');
    await dueno.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    const visita = make('Invitado');
    await visita.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);

    await visita.session.setRoomPassword('la mia');
    await sleep(300);
    expect(dueno.session.roomHasPassword).toBe(false);

    // Y el siguiente entra sin nada.
    const tercero = make('Otro');
    await tercero.session.connect(`ws://127.0.0.1:${server.port}`, ROOM);
    expect(tercero.session.connected).toBe(true);
  });
});
