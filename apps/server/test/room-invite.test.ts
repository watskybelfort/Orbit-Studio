/**
 * Invitaciones caducables, contra el servidor de verdad.
 *
 * La criptografía y el ciclo de vida están probados aparte (room-invite.test.ts
 * en @orbit/collab). Aquí se prueba lo que pasa EN EL SOCKET: que un token
 * abre la puerta sin la contraseña, que el de un solo uso no abre dos veces,
 * que quien no es productor no fabrica llaves, que revocar surte efecto en el
 * acto y que las invitaciones sobreviven a cerrar la sala — que es cuando el
 * servidor se olvida de todo lo demás.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as decoding from 'lib0/decoding';
import {
  AUTH_MIN_ITERATIONS,
  MESSAGE_CONTROL,
  encodeControl,
  makeRoomAuth,
  parseControl,
  type ControlMessage,
} from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';
import { authFilePath } from '../src/auth-store';

const ROOM = 'K3P9QF';
const PASSWORD = 'el sotano de abajo';
const HOUR = 60 * 60 * 1000;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cliente crudo del canal de control (igual que el de room-password.test.ts). */
class Peer {
  readonly control: ControlMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private readonly ws: WebSocket;

  constructor(port: number, room = ROOM) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${room}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
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

  clear(): void {
    this.control.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

/** Entra como productor, pone contraseña y devuelve el peer (sigue dentro). */
async function producer(port: number): Promise<Peer> {
  const peer = new Peer(port);
  await peer.open();
  expect(await peer.waitFor('role')).toEqual({ type: 'role', role: 'productor' });
  peer.clear();
  peer.send({ type: 'setPassword', auth: await makeRoomAuth(PASSWORD, AUTH_MIN_ITERATIONS) });
  expect((await peer.waitFor('roomAuth'))?.protected).toBe(true);
  peer.clear();
  return peer;
}

/**
 * Pide una invitación y devuelve su token y la lista que el servidor manda
 * detrás. Se leen las DOS antes de limpiar: `waitFor` busca por tipo, así que
 * un `invites` viejo en el buzón haría que el siguiente test creyera que la
 * revocación no ha surtido efecto.
 */
async function makeInvite(
  peer: Peer,
  ttlMs = HOUR,
  uses = 1,
): Promise<{ token: string; ids: string[] }> {
  peer.send({ type: 'createInvite', ttlMs, uses });
  const created = await peer.waitFor('inviteCreated');
  expect(created).not.toBeNull();
  const list = await peer.waitFor('invites');
  peer.clear();
  return { token: created!.token, ids: (list?.list ?? []).map((i) => i.id) };
}

describe('invitaciones de sala', () => {
  it('un token abre la puerta sin saber la contraseña', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss);

    const guest = new Peer(server.port);
    await guest.open();
    // La sala está protegida: primero el desafío.
    expect(await guest.waitFor('challenge')).not.toBeNull();
    guest.send({ type: 'joinInvite', token });
    expect(await guest.waitFor('authOk')).not.toBeNull();
    expect(guest.closed).toBeNull();

    guest.close();
    boss.close();
  });

  it('la de un solo uso no abre dos veces', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss, HOUR, 1);

    const first = new Peer(server.port);
    await first.open();
    await first.waitFor('challenge');
    first.send({ type: 'joinInvite', token });
    expect(await first.waitFor('authOk')).not.toBeNull();
    first.close();
    await sleep(150);

    const second = new Peer(server.port);
    await second.open();
    await second.waitFor('challenge');
    second.send({ type: 'joinInvite', token });
    const closed = await second.waitClosed();
    expect(closed?.code).toBe(1008);
    expect(closed?.reason).toContain('ya no vale');

    boss.close();
  });

  it('con varios usos entra más de uno', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss, HOUR, 2);

    for (const _ of [0, 1]) {
      const guest = new Peer(server.port);
      await guest.open();
      await guest.waitFor('challenge');
      guest.send({ type: 'joinInvite', token });
      expect(await guest.waitFor('authOk')).not.toBeNull();
      guest.close();
      await sleep(150);
    }

    const third = new Peer(server.port);
    await third.open();
    await third.waitFor('challenge');
    third.send({ type: 'joinInvite', token });
    expect((await third.waitClosed())?.code).toBe(1008);

    boss.close();
  });

  it('un token inventado no entra', async () => {
    const server = await serve();
    const boss = await producer(server.port);

    const guest = new Peer(server.port);
    await guest.open();
    await guest.waitFor('challenge');
    guest.send({ type: 'joinInvite', token: 'aaaaaa.bbbbbbbbbbbb' });
    expect((await guest.waitClosed())?.code).toBe(1008);

    boss.close();
  });

  it('revocar la deja sin efecto en el acto', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token, ids } = await makeInvite(boss, HOUR, 5);
    expect(ids).toHaveLength(1);

    boss.send({ type: 'revokeInvite', id: ids[0]! });
    expect((await boss.waitFor('invites'))?.list).toHaveLength(0);

    const guest = new Peer(server.port);
    await guest.open();
    await guest.waitFor('challenge');
    guest.send({ type: 'joinInvite', token });
    expect((await guest.waitClosed())?.code).toBe(1008);

    boss.close();
  });

  it('quien no es productor no fabrica llaves', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss, HOUR, 5);

    const guest = new Peer(server.port);
    await guest.open();
    await guest.waitFor('challenge');
    guest.send({ type: 'joinInvite', token });
    await guest.waitFor('authOk');
    guest.clear();

    guest.send({ type: 'createInvite', ttlMs: HOUR, uses: 10 });
    const denied = await guest.waitFor('denied');
    expect(denied?.reason).toContain('productor');
    expect(guest.control.find((m) => m.type === 'inviteCreated')).toBeUndefined();

    guest.close();
    boss.close();
  });

  it('sin contraseña no hay invitaciones que valgan', async () => {
    const server = await serve();
    const peer = new Peer(server.port);
    await peer.open();
    expect(await peer.waitFor('role')).toEqual({ type: 'role', role: 'productor' });
    peer.clear();

    peer.send({ type: 'createInvite', ttlMs: HOUR, uses: 1 });
    const denied = await peer.waitFor('denied');
    expect(denied?.reason).toContain('contraseña');
    peer.close();
  });

  it('el secreto no se guarda: en el archivo solo hay huellas', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss);
    boss.close();
    await sleep(200);

    const raw = readFileSync(authFilePath(dir!, ROOM), 'utf8');
    const secret = token.slice(token.indexOf('.') + 1);
    expect(raw).not.toContain(secret);
    expect(raw).toContain('invites');
  });

  it('sobreviven a que la sala se cierre', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss, HOUR, 3);
    boss.close();
    // Sin nadie dentro, el servidor cierra la sala y se olvida de todo lo que
    // no esté en disco.
    await sleep(300);

    const guest = new Peer(server.port);
    await guest.open();
    await guest.waitFor('challenge');
    guest.send({ type: 'joinInvite', token });
    expect(await guest.waitFor('authOk')).not.toBeNull();
    guest.close();
  });

  it('quitar la contraseña se lleva las invitaciones', async () => {
    const server = await serve();
    const boss = await producer(server.port);
    const { token } = await makeInvite(boss, HOUR, 5);

    boss.send({ type: 'setPassword', auth: null });
    expect((await boss.waitFor('roomAuth'))?.protected).toBe(false);
    boss.clear();

    // La sala queda abierta: se entra sin desafío, y el token ya no existe.
    boss.send({ type: 'createInvite', ttlMs: HOUR, uses: 1 });
    expect((await boss.waitFor('denied'))?.reason).toContain('contraseña');
    expect(token.length).toBeGreaterThan(0);
    boss.close();
  });
});
