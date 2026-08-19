/**
 * La puerta de la sala, probada contra el servidor de verdad.
 *
 * No se prueba la criptografía aquí (eso es cosa de room-auth.test.ts en
 * @orbit/collab): se prueba lo que pasa en el socket — que sin prueba no entra
 * nadie, que la prueba correcta abre, que la de otra conexión no vale, que solo
 * el productor cambia la cerradura y que la contraseña sobrevive a cerrar la
 * sala (que es cuando el servidor la olvida todo lo demás).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as decoding from 'lib0/decoding';
import {
  AUTH_MIN_ITERATIONS,
  MESSAGE_CONTROL,
  authMessage,
  encodeControl,
  makeProof,
  makeRoomAuth,
  parseControl,
  type ControlMessage,
} from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';
import { authFilePath } from '../src/auth-store';

const ROOM = 'K3P9QF';
const PASSWORD = 'el sotano de abajo';

let handle: ServerHandle | null = null;
let dir: string | null = null;

afterEach(async () => {
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

/** Un cliente crudo que solo entiende el canal de control. */
class Peer {
  readonly control: ControlMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly ws: WebSocket;

  constructor(port: number, room = ROOM) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${room}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => {
      const bytes = new Uint8Array(data);
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) !== MESSAGE_CONTROL) return;
      const message = parseControl(decoding.readVarString(decoder));
      if (message) this.control.push(message);
    });
    this.ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    this.ws.on('error', () => {
      // el cierre correspondiente ya lo apunta
    });
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(message: ControlMessage): void {
    this.ws.send(encodeControl(message));
  }

  /** Espera a un mensaje de control de ese tipo (o a que cierren la puerta). */
  async waitFor<T extends ControlMessage['type']>(
    type: T,
    ms = 4000,
  ): Promise<Extract<ControlMessage, { type: T }> | null> {
    const until = Date.now() + ms;
    for (;;) {
      const found = this.control.find((m) => m.type === type);
      if (found) return found as Extract<ControlMessage, { type: T }>;
      if (this.closed) return null;
      if (Date.now() > until) return null;
      await sleep(25);
    }
  }

  async waitClosed(ms = 4000): Promise<{ code: number; reason: string } | null> {
    const until = Date.now() + ms;
    while (!this.closed && Date.now() < until) await sleep(25);
    return this.closed;
  }

  /** Olvida lo recibido: el server manda `roomAuth` al entrar Y al cambiarla. */
  clear(): void {
    this.control.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Entra, pone la contraseña como productor y se va. */
async function lockRoom(port: number, password = PASSWORD): Promise<void> {
  const peer = new Peer(port);
  await peer.open();
  expect(await peer.waitFor('role')).toEqual({ type: 'role', role: 'productor' });
  peer.clear();
  peer.send({ type: 'setPassword', auth: await makeRoomAuth(password, AUTH_MIN_ITERATIONS) });
  const notice = await peer.waitFor('roomAuth');
  expect(notice?.protected).toBe(true);
  peer.close();
  await sleep(150);
}

describe('contraseña de sala', () => {
  it('sin contraseña se entra como siempre, y el panel se entera de que no la hay', async () => {
    const server = await serve();
    const peer = new Peer(server.port);
    await peer.open();
    expect(await peer.waitFor('roomAuth')).toEqual({ type: 'roomAuth', protected: false });
    peer.close();
  });

  it('el productor pone la contraseña y queda en disco, fuera del doc', async () => {
    const server = await serve();
    await lockRoom(server.port);
    const file = authFilePath(dir!, ROOM);
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.v).toBe(1);
    expect(typeof saved.storedKey).toBe('string');
    // Lo guardado no contiene la contraseña por ningún lado.
    expect(JSON.stringify(saved)).not.toContain(PASSWORD);
  });

  it('con contraseña, el que llega recibe un desafio y no entra hasta probarlo', async () => {
    const server = await serve();
    await lockRoom(server.port);

    const peer = new Peer(server.port);
    await peer.open();
    const challenge = await peer.waitFor('challenge');
    expect(challenge).not.toBeNull();
    // Nada de sala mientras no pruebe: ni rol ni tabla de roles.
    await sleep(200);
    expect(peer.control.some((m) => m.type === 'role')).toBe(false);
    peer.close();
  });

  it('la prueba correcta abre la puerta', async () => {
    const server = await serve();
    await lockRoom(server.port);

    const peer = new Peer(server.port);
    await peer.open();
    const challenge = await peer.waitFor('challenge');
    expect(challenge).not.toBeNull();
    peer.send({
      type: 'auth',
      proof: await makeProof(
        PASSWORD,
        challenge!.salt,
        challenge!.iterations,
        authMessage(ROOM, challenge!.nonce),
      ),
    });
    expect(await peer.waitFor('authOk')).not.toBeNull();
    expect(await peer.waitFor('role')).not.toBeNull();
    peer.close();
  });

  it('la contraseña equivocada cierra con 1008 y su motivo', async () => {
    const server = await serve();
    await lockRoom(server.port);

    const peer = new Peer(server.port);
    await peer.open();
    const challenge = await peer.waitFor('challenge');
    peer.send({
      type: 'auth',
      proof: await makeProof(
        'otra cosa',
        challenge!.salt,
        challenge!.iterations,
        authMessage(ROOM, challenge!.nonce),
      ),
    });
    const closed = await peer.waitClosed();
    expect(closed?.code).toBe(1008);
    expect(closed?.reason).toContain('Contraseña');
  });

  it('la prueba de una conexion no vale en la siguiente', async () => {
    const server = await serve();
    await lockRoom(server.port);

    const primero = new Peer(server.port);
    await primero.open();
    const challenge = await primero.waitFor('challenge');
    const proof = await makeProof(
      PASSWORD,
      challenge!.salt,
      challenge!.iterations,
      authMessage(ROOM, challenge!.nonce),
    );
    primero.close();

    // Otra conexión, mismo servidor: el nonce es distinto, la prueba no cuela.
    const segundo = new Peer(server.port);
    await segundo.open();
    expect(await segundo.waitFor('challenge')).not.toBeNull();
    segundo.send({ type: 'auth', proof });
    const closed = await segundo.waitClosed();
    expect(closed?.code).toBe(1008);
  });

  it('un invitado no puede cambiar la cerradura', async () => {
    const server = await serve();
    const productor = new Peer(server.port);
    await productor.open();
    expect(await productor.waitFor('role')).toEqual({ type: 'role', role: 'productor' });

    const invitado = new Peer(server.port);
    await invitado.open();
    expect(await invitado.waitFor('role')).toEqual({ type: 'role', role: 'invitado' });

    invitado.send({ type: 'setPassword', auth: await makeRoomAuth('mia', AUTH_MIN_ITERATIONS) });
    const denied = await invitado.waitFor('denied');
    expect(denied?.reason).toContain('productor');
    expect(existsSync(authFilePath(dir!, ROOM))).toBe(false);

    productor.close();
    invitado.close();
  });

  it('el productor puede quitarla y la sala vuelve a abrirse sola', async () => {
    const server = await serve();
    await lockRoom(server.port);

    const peer = new Peer(server.port);
    await peer.open();
    const challenge = await peer.waitFor('challenge');
    peer.send({
      type: 'auth',
      proof: await makeProof(
        PASSWORD,
        challenge!.salt,
        challenge!.iterations,
        authMessage(ROOM, challenge!.nonce),
      ),
    });
    expect(await peer.waitFor('role')).toEqual({ type: 'role', role: 'productor' });
    peer.send({ type: 'setPassword', auth: null });
    await sleep(200);
    expect(existsSync(authFilePath(dir!, ROOM))).toBe(false);

    const otro = new Peer(server.port);
    await otro.open();
    expect(await otro.waitFor('roomAuth')).toEqual({ type: 'roomAuth', protected: false });
    peer.close();
    otro.close();
  });

  it('la contraseña es de la sala, no de la conexion: otra sala sigue abierta', async () => {
    const server = await serve();
    await lockRoom(server.port);
    const otraSala = new Peer(server.port, 'M4T9WZ');
    await otraSala.open();
    expect(await otraSala.waitFor('roomAuth')).toEqual({ type: 'roomAuth', protected: false });
    otraSala.close();
  });
});
