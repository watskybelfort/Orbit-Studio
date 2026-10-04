/**
 * BUG 018 por el camino de verdad: del socket al log.
 *
 * Probar `checkEntry` a pelo no basta para la aceptación de esta tarjeta: lo que
 * se pedía es "unknown/null batch/props ausentes/tipos inválidos rechazados por
 * socket; sala continúa, clientes nuevos pueden entrar y converge tras comandos
 * válidos posteriores". Eso solo se ve con un cliente crudo metiendo basura en el
 * log de verdad y otro entrando después.
 *
 * Arnés propio (y no el de `role-enforcement.test.ts`) para no depender de un
 * fichero que otros están tocando.
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

const ROOM = 'J4M2QX';
const SYNC = 0;
const AWARENESS = 1;

let handle: ServerHandle | null = null;
let dir: string | null = null;
const peers: Peer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  if (handle) await handle.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Peer {
  readonly doc = new Y.Doc();
  private readonly ws: WebSocket;
  private readonly awareness: awarenessProtocol.Awareness;

  constructor(port: number, readonly name: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/${ROOM}`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.on('message', (data: Buffer) => this.onMessage(new Uint8Array(data)));
    this.ws.on('error', () => undefined);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.send(encoding.toUint8Array(encoder));
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
    encoding.writeVarUint(encoder, SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(encoding.toUint8Array(encoder));
    this.awareness.setLocalStateField('user', { name: this.name, color: '#fff' });
    const aEncoder = encoding.createEncoder();
    encoding.writeVarUint(aEncoder, AWARENESS);
    encoding.writeVarUint8Array(
      aEncoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.send(encoding.toUint8Array(aEncoder));
    await sleep(250);
  }

  get log(): Y.Array<Record<string, unknown>> {
    return this.doc.getArray<Record<string, unknown>>('commands');
  }

  push(cmd: unknown): void {
    this.doc.transact(() => {
      this.log.push([{ cmd, client: this.doc.clientID, seq: this.log.length + 1 }]);
    });
  }

  types(): string[] {
    return this.log
      .toArray()
      .map((e) => {
        const cmd = e['cmd'] as { type?: unknown } | undefined;
        return typeof cmd?.type === 'string' ? cmd.type : '?';
      });
  }

  close(): void {
    this.ws.close();
    this.awareness.destroy();
    this.doc.destroy();
  }

  private send(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
    } else if (type === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        this,
      );
    }
  }
}

async function serve(): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-018-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

const BASURA: [string, unknown][] = [
  ['tipo inexistente', { type: 'doesNotExist', id: 'x' }],
  ['batch con commands null', { type: 'batch', commands: null }],
  ['batch ausente', { type: 'batch' }],
  ['sin type', { id: 'x' }],
  ['campo obligatorio que falta', { type: 'setTempo' }],
  ['tipo primitivo equivocado', { type: 'setTempo', tempo: 'pronto' }],
  ['commands no-lista', { type: 'batch', commands: {} }],
  ['hijo inválido dentro de un lote', { type: 'batch', commands: [{ type: 'removeChannel' }] }],
];

describe('018 · por el socket, la basura no entra al log', () => {
  it('todo lo mal formado se retira y el comando bueno se queda', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    for (const [, cmd] of BASURA) host.push(cmd);
    await sleep(350);
    expect(host.types()).toEqual([]);

    // Y el comando bueno, después de la basura, entra normal: la sala sigue viva.
    host.push({ type: 'setTempo', tempo: 128 });
    await sleep(300);
    expect(host.types()).toEqual(['setTempo']);
  });

  it('la sala continúa: entra un cliente nuevo y converge con lo que quedó', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    for (const [, cmd] of BASURA) host.push(cmd);
    host.push({ type: 'setTempo', tempo: 128 });
    await sleep(400);

    const tarde = new Peer(server.port, 'llega-tarde');
    await tarde.open();
    await sleep(300);
    // Lo que se ve al entrar es el log ya limpio: la basura no quedó registrada.
    expect(tarde.types()).toEqual(['setTempo']);

    // Y sigue habiendo ida y vuelta: el nuevo escribe y el host lo ve.
    tarde.push({ type: 'setSwing', swing: 0.2 });
    await sleep(300);
    expect(host.types()).toEqual(['setTempo', 'setSwing']);
    expect(tarde.types()).toEqual(['setTempo', 'setSwing']);
  });

  it('un lote con un comando bueno y uno malo se retira entero, sin aplicar el bueno', async () => {
    // El lote es un solo paso de undo: si se aceptara a medias, el estado sería
    // una mezcla que nadie pidió y que el log no sabría reproducir.
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    host.push({
      type: 'batch',
      label: 'mezcla',
      commands: [{ type: 'setTempo', tempo: 90 }, { type: 'batch', commands: null }],
    });
    await sleep(350);
    expect(host.types()).toEqual([]);
  });
});