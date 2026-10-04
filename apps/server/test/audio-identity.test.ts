/**
 * BUG 014 — el streaming de audio deja falsear quién manda el audio.
 *
 * El campo `from` de un trozo de audio es lo que le dice a quien escucha de quién es
 * el audio que oye: la etiqueta del productor y el reloj del stream. El servidor solo
 * miraba el TAMAÑO del paquete y lo repartía tal cual, así que un invitado podía
 * mandar un trozo con el clientID del PRODUCTOR y a todos les llegaba como suyo
 * (medido: el host recibía audio con `claimedSender` = su propio ID, desde el socket
 * del invitado).
 *
 * Aquí `from` se ata al socket: si el `from` es un clientID que ese socket controla,
 * el paquete sale tal cual; si no, se reatribuye a un clientID suyo (que es el audio
 * del que lo manda) y, si el socket no controla ninguno, se descarta.
 *
 * Arnés Yjs a mano, propio, como en el resto de pruebas de socket.
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
import {
  MESSAGE_AUDIO,
  encodeAudioChunk,
  readAudioChunkBody,
  type AudioChunk,
} from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'V6Q2WT';
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

/** Cuatro muestras: da igual el audio, lo que se juzga es la identidad. */
const MUESTRAS = new Int16Array([123, 321, -7, 7]);

function trozo(from: number, seq: number): AudioChunk {
  return { from, sampleRate: 48000, seq, samples: MUESTRAS, codec: 'pcm16', bytes: MUESTRAS.byteLength };
}

class Peer {
  readonly doc = new Y.Doc();
  private readonly ws: WebSocket;
  private readonly awareness: awarenessProtocol.Awareness;
  /** Los trozos de audio que HAN LLEGADO, con el `from` que traían. */
  readonly oidos: { from: number; seq: number }[] = [];

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

  get clientID(): number {
    return this.doc.clientID;
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

  /** Manda un trozo de audio como sea, sin pasar por ninguna comprobación. */
  enviarAudio(chunk: AudioChunk): void {
    this.send(encodeAudioChunk(chunk));
  }

  /** Manda bytes crudos (para un mensaje mal formado a propósito). */
  enviarCrudo(bytes: Uint8Array): void {
    this.send(bytes);
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
    } else if (type === MESSAGE_AUDIO) {
      const chunk = readAudioChunkBody(decoder);
      if (chunk !== null) this.oidos.push({ from: chunk.from, seq: chunk.seq });
    }
  }
}

async function serve(): Promise<ServerHandle> {
  dir = mkdtempSync(join(tmpdir(), 'orbit-014-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

describe('014 · el audio se reparte con la identidad real de quien lo manda', () => {
  it('un invitado NO puede mandar audio con el clientID del host', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    // El invitado del protocolo se hace pasar por el host.
    invitado.enviarAudio({ ...trozo(host.clientID, 123), from: host.clientID });
    await sleep(300);

    // El host oye el audio, pero como si lo mandara el invitado (su propio id).
    expect(host.oidos).toHaveLength(1);
    expect(host.oidos[0]!.from).toBe(invitado.clientID);
    expect(host.oidos[0]!.from).not.toBe(host.clientID);
  });

  it('tampoco con un clientID de un TERCERO, ni con uno que nadie posee', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const otro = new Peer(server.port, 'otro');
    await otro.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    // El de un tercero…
    invitado.enviarAudio(trozo(otro.clientID, 1));
    // …y uno inventado que no controla nadie.
    invitado.enviarAudio(trozo(999999, 2));
    await sleep(300);

    // Ambos le llegan al host, pero con la identidad del que los mandó.
    expect(host.oidos.map((o) => o.from)).toEqual([invitado.clientID, invitado.clientID]);
    expect(host.oidos.some((o) => o.from === otro.clientID || o.from === 999999)).toBe(false);
  });

  it('el audio propio llega con su propia identidad (el caso legítimo)', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    host.enviarAudio(trozo(host.clientID, 1));
    invitado.enviarAudio(trozo(invitado.clientID, 1));
    await sleep(300);

    // Cada uno oye el del otro CON SU IDENTIDAD, que es lo que usa la UI para
    // etiquetarlo y para el reloj del stream.
    expect(host.oidos.map((o) => o.from)).toEqual([invitado.clientID]);
    expect(invitado.oidos.map((o) => o.from)).toEqual([host.clientID]);
  });

  it('varios invitados a la vez: cada uno conserva la suya', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const a = new Peer(server.port, 'a');
    await a.open();
    const b = new Peer(server.port, 'b');
    await b.open();

    a.enviarAudio(trozo(a.clientID, 7));
    b.enviarAudio(trozo(b.clientID, 7));
    await sleep(300);

    const vistos = new Set(host.oidos.map((o) => o.from));
    expect(vistos).toEqual(new Set([a.clientID, b.clientID]));
  });

  it('un trozo mal formado ya no se reparte (antes solo se miraba el tamaño)', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    // Un codec desconocido con un cuerpo plausible.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AUDIO);
    encoding.writeVarUint(encoder, invitado.clientID);
    encoding.writeVarUint(encoder, 48000);
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint(encoder, 99); // codec que no existe
    encoding.writeVarUint(encoder, 4);
    encoding.writeVarUint8Array(encoder, new Uint8Array(8));
    invitado.enviarCrudo(encoding.toUint8Array(encoder));
    await sleep(300);

    expect(host.oidos).toHaveLength(0);
  });
});