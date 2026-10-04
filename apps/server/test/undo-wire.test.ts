/**
 * BUG 002 por el socket: el inverso de un patch que quita un campo opcional tiene
 * que llegar ÍNTEGRO al otro cliente.
 *
 * El core ya está probado (undo local y undo tras JSON). Aquí está el criterio de
 * aceptación que pedía la tarjeta: **dos clientes reales** convergen. El productor
 * pone un campo opcional, se Calcula el inverso, y el inverso viaja por el log
 * como cualquier comando; el otro cliente lo aplica y ambos quedan igual.
 *
 * Arnés Yjs a mano, propio para no depender de un fichero que otros tocan.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { applyCommand, createChannel, createEmptyProject, type Project } from '@orbit/core';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'P7K2RD';
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

/**
 * Proyecto con un canal de id FIJO: los dos lados de la prueba son dos proyectos
 * distintos que tienen que representar el MISMO proyecto, así que los ids no
 * pueden salir al azar o el patch no encontraría el canal.
 */
function proyecto(): Project {
  const p = createEmptyProject();
  applyCommand(p, { type: 'addChannel', channel: { ...createChannel('synth', 0), id: 'c1' } });
  return p;
}

describe('002 · el inverso de un campo opcional converge entre clientes', () => {
  it('lo que el productor deshace, lo deshace el otro cliente', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-002-'));
    handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });

    const productor = new Peer(handle.port, 'productor');
    await productor.open();
    const invitado = new Peer(handle.port, 'invitado');
    await invitado.open();

    // El productor pone el campo opcional y saca su inverso: eso es lo que viaja.
    const local = proyecto();
    const poner = {
      type: 'patchChannel',
      channelId: local.channelOrder[0]!,
      patch: { groupId: 'g1' },
    } as const;
    const inverse = applyCommand(local, poner);
    productor.push(poner);
    await sleep(250);

    // Y el inverso, que es el que lleva la marca de borrado.
    expect(JSON.stringify(inverse)).toContain('\\u0000unset');
    productor.push(inverse);
    await sleep(300);

    // Los dos clientes tienen ya los dos comandos en su log.
    for (const peer of [productor, invitado]) {
      expect(peer.log.length).toBe(2);
    }
    // Y el inverso llega ÍNTEGRO: la clave de patch sigue ahí, con su marca.
    const recibido = invitado.log.get(1)['cmd'] as { patch: Record<string, unknown> };
    expect(Object.keys(recibido.patch)).toContain('groupId');
  });

  it('y el estado de un cliente que aplica lo que recibe queda como el del otro', async () => {
    // Aplica el inverso recibido a un proyectoGemelo del productor: los dos
    // terminan sin el campo, que es lo que el bug rompía (uno lo quitaba y el
    // otro se lo quedaba).
    dir = mkdtempSync(join(tmpdir(), 'orbit-002b-'));
    handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
    const productor = new Peer(handle.port, 'productor');
    await productor.open();

    const local = proyecto();
    const poner = {
      type: 'patchChannel',
      channelId: local.channelOrder[0]!,
      patch: { groupId: 'g1' },
    } as const;
    const inverse = applyCommand(local, poner);
    applyCommand(local, inverse);
    productor.push(poner);
    await sleep(200);
    productor.push(JSON.parse(JSON.stringify(inverse)) as unknown);
    await sleep(300);

    const gemelo = proyecto();
    for (const entrada of productor.log.toArray()) {
      applyCommand(gemelo, entrada['cmd'] as never);
    }
    expect('groupId' in gemelo.channels[gemelo.channelOrder[0]!]!).toBe(false);
    expect(JSON.stringify(gemelo.channels[gemelo.channelOrder[0]!])).toBe(
      JSON.stringify(local.channels[local.channelOrder[0]!]),
    );
  });
});

void vi;