/**
 * Si el VALIDADOR revienta, la entrada no entra. Barrera del servidor.
 *
 * El guardián del log decide con `commandProblem`, y ese validador es código nuestro:
 * si un día tiene un hueco (como el `kind in RAMAS_PARAM_REF` que heredaba de
 * `Object.prototype` y reventaba con `rama.apunta is not iterable`), la excepción
 * subía al manejador del mensaje, que la cazaba y ya está: la entrada se quedaba
 * APLICADA en el doc, repartida a todos los peers y guardada en el `.bin`, sin `denied`
 * para nadie (medido: log 4→7, `denied` vacío).
 *
 * Aquí se simula el validador roto —con `vi.mock`, sin tocar el código de producción—
 * y se comprueba que la puerta lo trata como «no permitido, con motivo» y que la
 * entrada se retira del log.
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

/** Cuando está a true, `commandProblem` revienta como lo haría un validador con un hueco. */
let validadorRoto = false;

vi.mock('@orbit/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@orbit/core')>();
  return {
    ...real,
    commandProblem: (cmd: unknown) => {
      if (validadorRoto) throw new TypeError('rama.apunta is not iterable');
      return real.commandProblem(cmd as never);
    },
  };
});

const { checkEntry } = await import('../src/room-roles');
const { startServer } = await import('../src/index');

const ROOM = 'T7W4QM';
const SYNC = 0;
const AWARENESS = 1;

let handle: Awaited<ReturnType<typeof startServer>> | null = null;
let dir: string | null = null;
const peers: Peer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  if (handle) await handle.close();
  handle = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  validadorRoto = false;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Un comando perfectamente válido, para que lo que lo juzgue sea el validador. */
const BUENO = {
  type: 'setSwing',
  swing: 0.25,
};

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

  meterCrudo(cmd: unknown): void {
    this.doc.transact(() => {
      this.doc
        .getArray<unknown>('commands')
        .push([{ id: `e${Math.random().toString(36).slice(2)}`, client: this.doc.clientID, seq: 1, role: 'productor', cmd }]);
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

describe('el servidor no se traga una excepción del validador', () => {
  it('la puerta lo dice con el motivo y sin dejar entrar la entrada', () => {
    validadorRoto = true;
    const entrada = { id: 'e1', client: 1, seq: 1, role: 'productor', cmd: BUENO };
    const veredicto = checkEntry(entrada as never, 'productor', true);
    expect(veredicto.allowed).toBe(false);
    expect(veredicto.reason).toMatch(/no se puede juzgar/);
    // Y con el validador sano, la misma entrada entra: no estamos rejecting de más.
    validadorRoto = false;
    expect(checkEntry(entrada as never, 'productor', true).allowed).toBe(true);
  });

  it('y por el socket la entrada tampoco se queda en el doc', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-validator-throws-'));
    handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });

    // Con el validador sano, para tener un log con una entrada buena de partida.
    const host = new Peer(handle.port, 'host');
    await host.open();
    host.meterCrudo(BUENO);
    await sleep(300);
    expect(host.log.length).toBe(1);

    // Ahora el validador revienta: una entrada nueva NO puede quedarse aplicada.
    validadorRoto = true;
    host.meterCrudo({ type: 'setSwing', swing: 0.4 });
    await sleep(400);
    expect(host.log.length).toBe(1);
  });
});