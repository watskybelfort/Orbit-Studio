/**
 * BUG 015 — el log de una sala debe tener claves únicas, y el servidor es quien las
 * deja escritas.
 *
 * La clave de idempotencia de una entrada es `client:seq`, y la escriben dos enteros
 * que pone el cliente. Con una clave repetida la sala se dividía: quien ya estaba
 * aplicaba la primera y se saltaba la segunda, quien entraba tarde se las aplicaba las
 * dos, y acababa con dos proyectos distintos según cuándo se entrara.
 *
 * Aquí el servidor retira del log la entrada repetida (gana la primera, que es lo que
 * ya aplicó el resto) y la que viene firmada con el clientID de otro socket vivo, que
 * es la misma suplantación que en la presencia (BUG 012). Retirar una entrada es una
 * operación normal del CRDT: converge en todos los clientes y quien la mandó se queda
 * como la sala.
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
import { MESSAGE_CONTROL, encodeControl, parseControl, type ControlMessage } from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'D5K2QW';
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
  readonly controles: ControlMessage[] = [];

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
    // La presencia: es lo que ata el clientID a este socket en el servidor.
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

  /** Una entrada del log con la clave que se le quiera dar, escrita a pelo. */
  meter(client: number, seq: number, cmd: unknown): void {
    this.doc.transact(() => {
      this.doc.getArray<unknown>('commands').push([
        { id: `e${Math.random().toString(36).slice(2)}`, client, seq, cmd, role: 'invitado' },
      ]);
    });
  }

  /** Varias entradas del log en UNA transacción, como si fuera un solo envío. */
  meterVarias(entradas: { client: number; seq: number; cmd: unknown }[]): void {
    this.doc.transact(() => {
      for (const e of entradas) {
        this.doc.getArray<unknown>('commands').push([
          { id: `e${Math.random().toString(36).slice(2)}`, ...e, role: 'invitado' },
        ]);
      }
    });
  }

  /** El log tal y como lo ve este peer. */
  get log(): { client?: unknown; seq?: unknown; cmd: Record<string, unknown> }[] {
    return this.doc
      .getArray<{ client?: unknown; seq?: unknown; cmd: Record<string, unknown> }>('commands')
      .toArray();
  }

  get denegados(): string[] {
    return this.controles.filter((c) => c.type === 'denied').map((c) => c.reason ?? '');
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
    } else if (type === MESSAGE_CONTROL) {
      const control = parseControl(decoding.readVarString(decoder));
      if (control !== null) this.controles.push(control);
    }
  }
}

async function serve(): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-015-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

describe('015 · el log se queda con claves únicas', () => {
  it('una entrada con la clave de otra se retira y quien la mandó se entera', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();

    const mio = host.doc.clientID;
    host.meter(mio, 0, { type: 'setTempo', tempo: 150 });
    await sleep(350);
    expect(host.log).toHaveLength(1);

    // La MISMA clave con otro comando: es una repetición, no un cambio.
    host.meter(mio, 0, { type: 'setTempo', tempo: 160 });
    await sleep(400);

    // El log se queda con la primera, que es la que el resto de clientes aplicó.
    expect(host.log).toHaveLength(1);
    expect(host.log[0]?.cmd).toEqual({ type: 'setTempo', tempo: 150 });
    expect(host.denegados.some((r) => r.includes('no se aplica dos veces'))).toBe(true);
  });

  it('una entrada firmada con el clientID de otro se retira', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const otro = new Peer(server.port, 'otro');
    await otro.open();
    await sleep(200);

    // El del otro se firma con el clientID del host, que tiene su socket vivo.
    otro.meter(host.doc.clientID, 0, { type: 'setTempo', tempo: 160 });
    await sleep(400);

    expect(otro.log).toHaveLength(0);
    expect(otro.denegados.some((r) => r.includes('clientID de otro'))).toBe(true);
  });

  it('una entrada sin clave (client/seq que no son enteros) se retira', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();

    host.meter(Number.NaN as unknown as number, 0, { type: 'setTempo', tempo: 150 });
    host.meter(host.doc.clientID, 0, { type: 'setTempo', tempo: 150 });
    await sleep(400);

    // La sin clave se va; la que sí lo tiene se queda.
    expect(host.log).toHaveLength(1);
    expect(host.log[0]?.cmd).toEqual({ type: 'setTempo', tempo: 150 });
  });

  it('las entradas de verdad de dos sockets siguen todas en el log', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const otro = new Peer(server.port, 'otro');
    await otro.open();
    await sleep(200);

    host.meter(host.doc.clientID, 0, { type: 'setTempo', tempo: 150 });
    host.meter(host.doc.clientID, 1, { type: 'setSwing', swing: 0.2 });
    otro.meter(otro.doc.clientID, 0, { type: 'setTempo', tempo: 160 });
    await sleep(450);

    // Mismo `seq` con distinto `client` son entradas DISTINTAS: nadie se pisa.
    expect(host.log).toHaveLength(3);
    expect(otro.log).toHaveLength(3);
    expect(host.denegados).toEqual([]);
  });

  it('si las dos repetidas entran en el MISMO envío, la segunda también se va', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const mio = host.doc.clientID;

    // Las dos en una sola transacción: el juicio no puede fiarse de «lo que ya
    // estaba», tiene que ir viendo las que van entrando en este mismo lote.
    host.meterVarias([
      { client: mio, seq: 7, cmd: { type: 'setTempo', tempo: 150 } },
      { client: mio, seq: 7, cmd: { type: 'setTempo', tempo: 160 } },
      { client: mio, seq: 8, cmd: { type: 'setSwing', swing: 0.2 } },
    ]);
    await sleep(400);

    expect(host.log).toHaveLength(2);
    expect(host.log[0]?.cmd).toEqual({ type: 'setTempo', tempo: 150 });
    expect(host.log[1]?.cmd).toEqual({ type: 'setSwing', swing: 0.2 });
  });
});