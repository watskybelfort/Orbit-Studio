/**
 * Follow-up de 017/018 por la repro de SOLEANO, lado SERVIDOR: una entrada con un
 * `ParamRef.kind` heredado (`toString`, `constructor`…) llega al log por el socket.
 *
 * Antes el validador reventaba con `TypeError: rama.apunta is not iterable`, el
 * manejador del mensaje cazaba la excepción y la entrada se quedaba APLICADA en el
 * doc: repartida a todos los peers, guardada en el `.bin` y con `denied` vacío
 * (medido: log 4→7). Dos cosas se arreglan aquí:
 *
 *  1. La puerta del servidor trata "el validador no pudo opinar" como no permitido, con
 *     el motivo, en vez de dejar que la excepción se coma el juicio.
 *  2. La entrada se retira del log, así que ni el cliente que la mandó ni uno que
 *     llega tarde se quedan con el `kind` inventado dentro.
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
import { checkEntry, entryCommand } from '../src/room-roles';

const ROOM = 'H3R9ZK';
const SYNC = 0;
const AWARENESS = 1;

const HEREDADOS = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

function lfo(kind: string): Record<string, unknown> {
  return {
    type: 'addLfos',
    lfos: [
      {
        id: 'l1',
        target: { kind, param: 'volume' },
        shape: 'sine',
        rateBeats: 4,
        amount: 0.5,
        phase: 0,
        enabled: true,
      },
    ],
  };
}

describe('follow-up 017/018 · la puerta del servidor con un kind heredado', () => {
  it('no lo permite, y el motivo nombra el campo', () => {
    for (const kind of HEREDADOS) {
      const entrada = { id: 'e1', client: 1, seq: 1, role: 'productor', cmd: lfo(kind) };
      const veredicto = checkEntry(entrada as never, 'productor', true);
      expect(veredicto.allowed, kind).toBe(false);
      expect(veredicto.reason, kind).toMatch(/kind/);
      // Y el recorrido previo (qué crea o borra) tampoco lo ve como comando.
      expect(entryCommand(entrada as never), kind).toBeNull();
    }
  });
});

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

  /** Cada entrada con su `seq`: numerar es lo que hace las claves unicas (BUG 015). */
  private seq = 0;
  /** Escribe en el log sin pasar por el bus, como haría un cliente modificado. */
  meterCrudo(cmd: unknown): void {
    this.doc.transact(() => {
      this.doc
        .getArray<unknown>('commands')
        .push([{ id: `e${Math.random().toString(36).slice(2)}`, client: this.doc.clientID, seq: this.seq++, role: 'productor', cmd }]);
    });
  }

  get log(): unknown[] {
    return this.doc.getArray<unknown>('commands').toArray();
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
  dir = mkdtempSync(join(tmpdir(), 'orbit-paramref-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

describe('follow-up 017/018 · por el socket, la entrada inválida no se queda en el log', () => {
  it('con un kind heredado: el log no crece y el cliente tardío tampoco lo ve', async () => {
    const server = await serve();
    const atacante = new Peer(server.port, 'atacante');
    await atacante.open();

    const antes = atacante.log.length;
    for (const kind of HEREDADOS) atacante.meterCrudo(lfo(kind));
    await sleep(400);

    // Ni una se queda: el guardia las retira del log (antes quedaban y se repartían).
    expect(atacante.log.length).toBe(antes);
    expect(JSON.stringify(atacante.log)).not.toMatch(/toString|hasOwnProperty/);

    // Y uno que llega tarde recibe el log limpio.
    const tarde = new Peer(server.port, 'tarde');
    await tarde.open();
    await sleep(250);
    expect(tarde.log.length).toBe(antes);
    expect(JSON.stringify(tarde.log)).not.toMatch(/toString|hasOwnProperty/);
  });

  it('un LFO de verdad sigue entrando por el mismo camino', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const antes = host.log.length;
    host.meterCrudo({
      type: 'addLfos',
      lfos: [
        {
          id: 'l1',
          target: { kind: 'mixer', trackIndex: 0, param: 'volume' },
          shape: 'sine',
          rateBeats: 4,
          amount: 0.5,
          phase: 0,
          enabled: true,
        },
      ],
    });
    await sleep(350);
    expect(host.log.length).toBe(antes + 1);
  });
});