/**
 * BUG 054 — un mensaje de chat malformado deja la sala inservible.
 *
 * El chat es otro `Y.Array` del mismo doc y también es entrada de red: lo escribe
 * cualquier peer del protocolo y NO pasa por el log de comandos (un mensaje no es
 * una mutación del proyecto, no entra en el undo ni lo filtran los roles). Con un
 * `null` dentro, leer la conversación reventaba con `Cannot read properties of null
 * (reading 'text')` en el host y en quien entraba tarde, y el servidor guardaba el
 * dato inválido en el `.bin`.
 *
 * Arnés Yjs a mano, propio para no depender de un fichero que otros tocan.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { ChatBinding, isChatMessage, type ChatMessage } from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'H8T3QW';
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
  readonly chat: ChatBinding;

  constructor(port: number, readonly name: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.chat = new ChatBinding(this.doc, { name, color: '#fff' });
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

  /** Mete basura en el array del chat SIN pasar por el binding, como haría un peer. */
  pushCrudo(valor: unknown): void {
    this.doc.transact(() => {
      this.doc.getArray<unknown>('chat').push([valor]);
    });
  }

  get crudos(): unknown[] {
    return this.doc.getArray<unknown>('chat').toArray();
  }

  /** Lectura como la hace la UI: no puede reventar. */
  leer(): ChatMessage[] {
    return this.chat.messages;
  }

  close(): void {
    this.chat.destroy();
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
  dir = mkdtempSync(join(tmpdir(), 'orbit-054-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

const BASURA: unknown[] = [
  null,
  'texto suelto',
  42,
  [],
  {},
  { id: 'x' },
  { id: 'x', user: 'U', color: '#fff', at: 1, client: 1 },
  { id: 'x', user: 'U', color: '#fff', text: null, at: 1, client: 1 },
  { id: 'x', user: 'U', color: '#fff', text: 'hola', at: 'ayer', client: 1 },
  { id: 'x', user: 'U', color: '#fff', text: 'hola', at: 1, client: 1, beat: 'a' },
];

describe('054 · un mensaje de chat malformado no deja la sala inservible', () => {
  it('depura una sala antigua al abrirla, conserva su mensaje y persiste el chat limpio', async () => {
    const server = await serve();
    const oldDoc = new Y.Doc();
    const valid = { id: 'legado', user: 'U', color: '#fff', text: 'Conservar', at: 1, client: 1, beat: 4 };
    oldDoc.getArray<unknown>('chat').push([null, valid, ...BASURA]);
    const file = join(dir!, `${ROOM}.bin`);
    writeFileSync(file, Y.encodeStateAsUpdate(oldDoc));
    oldDoc.destroy();
    const host = new Peer(server.port, 'host');
    await host.open();
    expect(host.crudos).toEqual([valid]);
    expect(host.chat.pinned).toEqual([valid]);
    await server.close();
    handle = null;
    const restored = new Y.Doc();
    Y.applyUpdate(restored, new Uint8Array(readFileSync(file)));
    expect(restored.getArray('chat').toArray()).toEqual([valid]);
    restored.destroy();
  });

  it('el host sigue leyendo sus mensajes válidos con basura dentro', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    host.chat.send('hola');

    for (const valor of BASURA) host.pushCrudo(valor);
    await sleep(200);

    // Leer no revienta, y lo que se ve es el mensaje de verdad.
    const leidos = host.leer();
    expect(leidos.map((m) => m.text)).toEqual(['hola']);
  });

  it('un invitado puede envenenar el chat: los demás leen igual de bien', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    host.chat.send('hola');
    await sleep(200);
    invitado.pushCrudo(null);
    invitado.pushCrudo({ id: 'z', user: 'Z', color: '#fff', text: null, at: 1, client: 9 });
    await sleep(350);

    // El servidor retira lo malformado del doc: lo que se persiste no lleva el dato.
    expect(host.crudos.every((m) => isChatMessage(m))).toBe(true);
    expect(host.leer().map((m) => m.text)).toEqual(['hola']);
  });

  it('quien entra tarde lee los válidos y no hereda la basura', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    host.chat.send('hola');
    await sleep(200);
    invitado.pushCrudo(null);
    await sleep(300);

    const tarde = new Peer(server.port, 'tarde');
    await tarde.open();
    await sleep(250);

    expect(tarde.leer().map((m) => m.text)).toEqual(['hola']);
    expect(tarde.crudos.every((m) => isChatMessage(m))).toBe(true);
  });

  it('las notas ancladas y el borrado siguen funcionando con basura en medio', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const anclado = host.chat.send('aquí falta un break', { beat: 32 })!;
    host.chat.send('charla');
    await sleep(200);
    host.pushCrudo(null);

    expect(host.chat.pinned.map((m) => m.id)).toEqual([anclado.id]);
    // Y borrar uno sigue borrando elbueno, no el `null` de al lado.
    expect(host.chat.remove(anclado.id)).toBe(true);
    expect(host.leer().map((m) => m.text)).toEqual(['charla']);
    expect(host.chat.remove('no-existe')).toBe(false);
  });

  it('el que va bien se pinta recortado, como siempre', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const largo = 'a'.repeat(5000);
    host.chat.send(largo);
    await sleep(200);
    expect(host.leer()[0]!.text.length).toBeLessThan(5000);
  });
});
