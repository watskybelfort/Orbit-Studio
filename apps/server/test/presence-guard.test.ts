/**
 * La presencia no se puede firmar con el clientID de otro.
 *
 * El servidor creía lo que le llegara: un invitado mandaba un update de
 * awareness con el clientID del productor, el servidor lo aplicaba y lo
 * replicaba, y desde ahí el "productor" de la lista tenía el nombre del
 * atacante (y su clientID quedaba apuntado a otro socket). El dueño de un
 * clientID solo puede serlo el socket que lo anunció PRIMERO.
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

/** Un update de awareness crudo para un clientID ajeno. */
function spoofUpdate(clientID: number, clock: number, state: unknown): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 1);
  encoding.writeVarUint(encoder, clientID);
  encoding.writeVarUint(encoder, clock);
  encoding.writeVarString(encoder, JSON.stringify(state));
  return encoding.toUint8Array(encoder);
}

class RawPeer {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly ws: WebSocket;

  constructor(port: number, readonly name: string, clientId?: number) {
    this.doc = new Y.Doc();
    // Misma identidad Yjs que otra conexión: el caso de reconectar sin perder
    // el doc (clientID persistente).
    if (clientId !== undefined) this.doc.clientID = clientId;
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
    this.awareness.setLocalStateField('user', { name: this.name, color: '#fff' });
    const aEncoder = encoding.createEncoder();
    encoding.writeVarUint(aEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      aEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.sendRaw(encoding.toUint8Array(aEncoder));
    await sleep(250);
  }

  /** Anuncia presencia para un clientID que no es el suyo. */
  announce(clientID: number, clock: number, state: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, spoofUpdate(clientID, clock, state));
    this.sendRaw(encoding.toUint8Array(encoder));
  }

  nameOf(clientID: number): string | null {
    const state = this.awareness.getStates().get(clientID) as
      | { user?: { name?: unknown } }
      | undefined;
    return typeof state?.user?.name === 'string' ? state.user.name : null;
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

describe('la presencia tiene dueño', () => {
  it('un invitado no puede anunciar presencia con el clientID del productor', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'Productor');
    await productor.open();
    const invitado = new RawPeer(server.port, 'Invitado');
    await invitado.open();

    expect(productor.nameOf(productor.doc.clientID)).toBe('Productor');
    expect(productor.nameOf(invitado.doc.clientID)).toBe('Invitado');

    // Clock alto para saltarse la comprobación de "más reciente" del protocolo.
    invitado.announce(productor.doc.clientID, 99, {
      user: { name: 'Productor (falso)', color: '#000' },
    });
    await sleep(350);

    // El productor sigue siendo él en su propia vista y en la del atacante.
    expect(productor.nameOf(productor.doc.clientID)).toBe('Productor');
    expect(invitado.nameOf(productor.doc.clientID)).toBe('Productor');
    // Y el clientID del invitado sigue siendo suyo.
    expect(productor.nameOf(invitado.doc.clientID)).toBe('Invitado');
  });

  it('tampoco puede retirar la presencia del otro con un estado null', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'Productor');
    await productor.open();
    const invitado = new RawPeer(server.port, 'Invitado');
    await invitado.open();

    invitado.announce(productor.doc.clientID, 99, null);
    await sleep(350);

    expect(productor.nameOf(productor.doc.clientID)).toBe('Productor');
    expect(invitado.nameOf(productor.doc.clientID)).toBe('Productor');
  });

  it('un clientID libre sí se puede reclamar (reconexión del mismo doc)', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'Productor');
    await productor.open();
    const invitado = new RawPeer(server.port, 'Invitado');
    await invitado.open();

    // El invitado se va y vuelve con el MISMO doc (mismo clientID).
    const sameId = invitado.doc.clientID;
    invitado.close();
    await sleep(250);
    const vuelto = new RawPeer(server.port, 'Invitado', sameId);
    await vuelto.open();
    // Clock por encima del último visto (el doc de verdad lo conserva al
    // reconectar; aquí el peer de prueba arranca de cero).
    vuelto.announce(sameId, 99, { user: { name: 'Invitado', color: '#fff' } });
    await sleep(350);

    expect(productor.nameOf(sameId)).toBe('Invitado');
  });
});
