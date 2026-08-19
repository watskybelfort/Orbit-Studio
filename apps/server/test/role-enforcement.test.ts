/**
 * El guardia de roles, atacado con un cliente crudo.
 *
 * No basta con probar `checkEntry`: los tres agujeros que esto cierra estaban
 * en el camino que lleva del socket a la decisión, no en la regla.
 *
 * 1. El rol salía de `entry.client`, un campo que escribe el propio cliente →
 *    un invitado firmaba con el clientID del productor y pasaba.
 * 2. La lista de "ya juzgado" se indexaba por `client:seq`, otros dos campos
 *    del cliente → repetir una clave ya usada saltaba la validación entera.
 * 3. Solo se vigilaba el log. El SNAPSHOT (Y.Map 'meta') es el proyecto que
 *    carga todo el que entra, y no lo miraba nadie.
 *
 * El atacante de aquí es un Y.Doc con el protocolo a mano, que es exactamente
 * lo que tendría cualquiera con el repo delante.
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

/** Un peer de Yjs a pelo: doc propio, protocolo a mano y cero buenos modales. */
class RawPeer {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  private readonly ws: WebSocket;

  constructor(port: number, readonly name: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${ROOM}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('error', () => undefined);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return; // lo que llegó de fuera no se devuelve
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
    // Presencia: sin ella el servidor no sabe qué clientID lleva este socket.
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

  get log(): Y.Array<Record<string, unknown>> {
    return this.doc.getArray<Record<string, unknown>>('commands');
  }

  get meta(): Y.Map<string | number> {
    return this.doc.getMap<string | number>('meta');
  }

  /** Mete una entrada en el log tal cual, sin pasar por ningún binding. */
  push(entry: Record<string, unknown>): void {
    this.doc.transact(() => {
      this.log.push([entry]);
    });
  }

  types(): string[] {
    return this.log.toArray().map((e) => {
      const cmd = e['cmd'] as { type?: unknown } | undefined;
      return typeof cmd?.type === 'string' ? cmd.type : '?';
    });
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BORRAR_CANAL = { type: 'removeChannel', channelId: 'ch1' };
const MOVER_NOTA = { type: 'setTempo', tempo: 128 };

describe('el guardia de roles no se deja engañar', () => {
  it('el productor sí puede borrar un canal', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'A');
    await productor.open();
    productor.push({ cmd: BORRAR_CANAL, client: productor.doc.clientID, seq: 1 });
    await sleep(300);
    expect(productor.types()).toEqual(['removeChannel']);
  });

  it('un invitado que firma con el clientID del productor NO cuela', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'A');
    await productor.open();
    const invitado = new RawPeer(server.port, 'B');
    await invitado.open();

    // Firmado con el clientID ajeno: es lo que el servidor creía a pies juntillas.
    invitado.push({ cmd: BORRAR_CANAL, client: productor.doc.clientID, seq: 77 });
    await sleep(400);

    expect(invitado.types()).toEqual([]);
    expect(productor.types()).toEqual([]);
  });

  it('reusar un client:seq ya visto tampoco salta la validación', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'A');
    await productor.open();
    const invitado = new RawPeer(server.port, 'B');
    await invitado.open();

    // Primero algo permitido, para que esa clave quede "vista".
    invitado.push({ cmd: MOVER_NOTA, client: invitado.doc.clientID, seq: 0 });
    await sleep(300);
    expect(invitado.types()).toEqual(['setTempo']);

    // Y ahora lo prohibido, con la MISMA clave.
    invitado.push({ cmd: BORRAR_CANAL, client: invitado.doc.clientID, seq: 0 });
    await sleep(400);
    expect(invitado.types()).toEqual(['setTempo']);
    expect(productor.types()).toEqual(['setTempo']);
  });

  it('un invitado no reescribe el snapshot del proyecto', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'A');
    await productor.open();
    productor.doc.transact(() => {
      productor.meta.set('snapshot', '{"proyecto":"el de verdad"}');
      productor.meta.set('snapshotSeq', 0);
    });
    await sleep(300);

    const invitado = new RawPeer(server.port, 'B');
    await invitado.open();
    expect(invitado.meta.get('snapshot')).toBe('{"proyecto":"el de verdad"}');

    invitado.doc.transact(() => {
      invitado.meta.set('snapshot', '{"proyecto":"SECUESTRADO POR UN INVITADO"}');
    });
    await sleep(400);

    expect(productor.meta.get('snapshot')).toBe('{"proyecto":"el de verdad"}');
    expect(invitado.meta.get('snapshot')).toBe('{"proyecto":"el de verdad"}');
  });

  it('el productor sí reescribe el snapshot (compactar sigue funcionando)', async () => {
    const server = await serve();
    const productor = new RawPeer(server.port, 'A');
    await productor.open();
    productor.doc.transact(() => {
      productor.meta.set('snapshot', '{"proyecto":"v1"}');
    });
    await sleep(300);
    productor.doc.transact(() => {
      productor.meta.set('snapshot', '{"proyecto":"v2 compactado"}');
      productor.meta.set('snapshotSeq', 12);
    });
    await sleep(300);
    expect(productor.meta.get('snapshot')).toBe('{"proyecto":"v2 compactado"}');
    expect(productor.meta.get('snapshotSeq')).toBe(12);
  });
});
