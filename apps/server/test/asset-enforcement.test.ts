/**
 * El mapa `assets` también es el proyecto: lo que entra ahí se replica a TODOS
 * y se guarda en el .bin. El servidor no puede fiarse ni de su forma ni del rol
 * del que lo publica.
 *
 * Lo que se cierra aquí:
 * 1. Un asset malformado (sin `bytes`) ya no se acepta ni se replica: antes
 *    solo se miraba su tamaño declarado, así que pasaba y el receptor se comía
 *    el TypeError al escanearlo.
 * 2. Un oyente no publica muestras: los topes de tamaño no son una política de
 *    rol, y el rol lo reparte el servidor.
 *
 * El atacante es un Y.Doc con el protocolo a mano, como en role-enforcement.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { SampleAsset } from '@orbit/collab';
import { encodeControl } from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'K3P9QF';
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

let handle: ServerHandle | null = null;
let dir: string | null = null;
const peers: RawPeer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
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

function blob(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i + 1) % 251;
  return out;
}

/** Un peer de Yjs a pelo: doc propio, protocolo a mano y cero buenos modales. */
class RawPeer {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  private readonly ws: WebSocket;

  constructor(port: number) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${ROOM}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('error', () => undefined);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.sendRaw(encoding.toUint8Array(encoder));
    });
    peers.push(this);
  }

  async open(): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        this.ws.once('open', () => resolve());
        this.ws.once('error', reject);
      });
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.sendRaw(encoding.toUint8Array(encoder));
    this.awareness.setLocalStateField('user', { name: 'peer', color: '#fff' });
    const aEncoder = encoding.createEncoder();
    encoding.writeVarUint(aEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      aEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.sendRaw(encoding.toUint8Array(aEncoder));
    await sleep(250);
  }

  get assets(): Y.Map<SampleAsset> {
    return this.doc.getMap<SampleAsset>('assets');
  }

  /** Publica un valor en el mapa `assets` tal cual, sin pasar por el binding. */
  setAsset(key: string, value: unknown): void {
    this.doc.transact(() => {
      this.assets.set(key, value as SampleAsset);
    });
  }

  checkAsset(key: string): boolean {
    return this.assets.has(key);
  }

  /** Pide al servidor el rol de otro (solo lo atiende si quien lo pide es productor). */
  assignRole(clientId: number, role: 'invitado' | 'oyente'): void {
    this.sendRaw(encodeControl({ type: 'setRole', client: clientId, role }));
  }

  close(): void {
    this.ws.close();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private sendRaw(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.sendRaw(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    }
  }
}

describe('el servidor no deja entrar basura en el mapa de samples', () => {
  it('un asset malformado (sin bytes) se borra y no corta el sync de los demás', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port);
    await productor.open();
    const invitado = new RawPeer(server.port);
    await invitado.open();

    invitado.setAsset('malo', { hash: 'malo', name: 'Malo', by: 'evil', at: 0 });
    await sleep(300);
    expect(productor.checkAsset('malo')).toBe(false);
    expect(invitado.checkAsset('malo')).toBe(false);

    // Y lo legítimo que venga después sigue funcionando.
    const bien: SampleAsset = {
      hash: 'bien',
      name: 'Kick',
      size: 64,
      by: 'invitado',
      at: 0,
      bytes: blob(64),
    };
    invitado.setAsset('bien', bien);
    await sleep(300);
    expect(productor.checkAsset('bien')).toBe(true);
    expect(productor.assets.get('bien')?.bytes.byteLength).toBe(64);
  });

  it('un invitado sí puede publicar un sample legítimo', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port);
    await productor.open();
    const invitado = new RawPeer(server.port);
    await invitado.open();

    invitado.setAsset('kick', {
      hash: 'kick',
      name: 'Kick',
      size: 32,
      by: 'invitado',
      at: 0,
      bytes: blob(32),
    });
    await sleep(300);
    expect(productor.checkAsset('kick')).toBe(true);
  });

  it('un oyente no publica samples: se le borra lo que meta', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port);
    await productor.open();
    const invitado = new RawPeer(server.port);
    await invitado.open();
    const oyente = new RawPeer(server.port);
    await oyente.open();

    // El rol lo reparte el servidor: el productor se lo baja a oyente.
    productor.assignRole(oyente.doc.clientID, 'oyente');
    await sleep(250);

    oyente.setAsset('colado', {
      hash: 'colado',
      name: 'Colado',
      size: 16,
      by: 'oyente',
      at: 0,
      bytes: blob(16),
    });
    await sleep(300);
    expect(productor.checkAsset('colado')).toBe(false);
    expect(oyente.checkAsset('colado')).toBe(false);
  });

  it('un cliente con nombre/hash que no son texto tampoco cuela', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port);
    await productor.open();
    const invitado = new RawPeer(server.port);
    await invitado.open();

    invitado.setAsset('raro', {
      hash: 7,
      name: { toString: () => 'boom' },
      size: 8,
      by: 'evil',
      at: 0,
      bytes: blob(8),
    });
    await sleep(300);
    expect(productor.checkAsset('raro')).toBe(false);
    expect(invitado.checkAsset('raro')).toBe(false);
  });
});
