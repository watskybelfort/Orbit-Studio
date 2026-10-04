/**
 * BUG 055 — un invitado puede sustituir los BYTES de un sample ya publicado sin
 * cambiar su hash.
 *
 * El hash es la identidad del contenido (`SampleRef.hash`, y la clave del
 * `Y.Map('assets')`). Con solo la política de 013 —que juzgaba el rol— un invitado
 * podía escribir `assets[sha1(A)] = B` con otros bytes de la misma forma y tamaño:
 * el cliente que ya tenía el sample se quedaba con A (solo se avisa una vez por
 * hash) y uno que entraba tarde cargaba B con el MISMO SampleRef, es decir, mismo
 * proyecto y mismo hash con distinto audio.
 *
 * Aquí se fija la regla por los dos lados: el servidor devuelve los bytes
 * originales y el receptor congela los primeros que vio para ese hash.
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
import { SampleAssetBinding, type SampleAsset, type AssetRejection } from '@orbit/collab';
import { startServer, type ServerHandle } from '../src/index';

const ROOM = 'A5K9ZT';
const SYNC = 0;
const AWARENESS = 1;
/** Hashes de A (220 Hz) y B (440 Hz): mismo tamaño y forma, distinto audio. */
const HASH_A = 'ff53fd344654db4ffa7d36cc498e24193728c0d5';
const HASH_B = 'd42df9e3a9b1650f7ba2bda1c6a7868d5aa0e012';

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

/** WAV PCM32 del mismo tamaño con dos tonos distintos: A y B. */
function wav(hz: number): Uint8Array {
  const rate = 8000;
  const muestras = 400;
  const datos = new Uint8Array(44 + muestras * 4);
  const vista = new DataView(datos.buffer);
  const texto = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) vista.setUint8(offset + i, s.charCodeAt(i));
  };
  texto(0, 'RIFF');
  vista.setUint32(4, 36 + muestras * 4, true);
  texto(8, 'WAVEfmt ');
  vista.setUint32(16, 16, true);
  vista.setUint16(20, 3, true);
  vista.setUint16(22, 1, true);
  vista.setUint32(24, rate, true);
  vista.setUint32(28, rate * 4, true);
  vista.setUint16(32, 4, true);
  vista.setUint16(34, 32, true);
  texto(36, 'data');
  vista.setUint32(40, muestras * 4, true);
  for (let i = 0; i < muestras; i++) {
    vista.setInt32(44 + i * 4, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 1e6), true);
  }
  return datos;
}

const A = wav(220);
const B = wav(440);

function asset(hash: string, name: string, bytes: Uint8Array, by: string): SampleAsset {
  return { hash, name, size: bytes.byteLength, by, at: 1, bytes };
}

function iguales(a: Uint8Array | null, b: Uint8Array): boolean {
  if (a === null || a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < b.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

class Peer {
  readonly doc = new Y.Doc();
  private readonly ws: WebSocket;
  private readonly awareness: awarenessProtocol.Awareness;
  readonly assets: SampleAssetBinding;
  readonly recibidos: SampleAsset[] = [];
  readonly avisos: AssetRejection[] = [];

  constructor(port: number, readonly name: string) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.assets = new SampleAssetBinding(this.doc, {
      onAsset: (a) => this.recibidos.push(a),
      onRejected: (r) => this.avisos.push(r),
    });
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
    this.assets.start();
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

  /** Escribe en el mapa de assets SIN pasar por el binding, como haría un peer. */
  meterCrudo(el: SampleAsset): void {
    this.doc.transact(() => {
      this.doc.getMap<SampleAsset>('assets').set(el.hash, el);
    });
  }

  bytesDe(hash: string): Uint8Array | null {
    return this.doc.getMap<SampleAsset>('assets').get(hash)?.bytes ?? null;
  }

  close(): void {
    this.assets.destroy();
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
  dir = mkdtempSync(join(tmpdir(), 'orbit-055-'));
  handle = await startServer({ port: 0, host: '127.0.0.1', roomsDir: dir });
  return handle;
}

describe('055 · el hash es la identidad: los bytes publicados no se sustituyen', () => {
  it('el invitado que cambia los bytes no cambia lo que oye nadie', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    expect(host.assets.publish(A, { hash: HASH_A, name: 'a.wav', by: 'host' })).toBe('published');
    await sleep(300);
    expect(iguales(host.bytesDe(HASH_A), A)).toBe(true);
    expect(iguales(host.assets.get(HASH_A), A)).toBe(true);

    // El invitado del protocolo sustituye los bytes y MIENTE en el campo hash.
    invitado.meterCrudo(asset(HASH_A, 'a.wav', B, 'invitado'));
    await sleep(400);

    // El servidor devuelve los originales: ni el host ni el invitado oyen B.
    expect(iguales(host.bytesDe(HASH_A), A)).toBe(true);
    expect(iguales(host.assets.get(HASH_A), A)).toBe(true);
    expect(iguales(invitado.bytesDe(HASH_A), A)).toBe(true);
  });

  it('y un cliente que llega tarde carga el MISMO audio que el que ya estaba', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    host.assets.publish(A, { hash: HASH_A, name: 'a.wav', by: 'host' });
    await sleep(300);
    // El sustituto entra y lo meten en el mapa a pelo.
    invitado.meterCrudo(asset(HASH_A, 'a.wav', B, 'invitado'));
    await sleep(400);

    const tarde = new Peer(server.port, 'tarde');
    await tarde.open();
    await sleep(300);

    // El tardío recibe el asset y sus bytes son los de A, no los de B.
    const recibido = tarde.recibidos.find((a) => a.hash === HASH_A);
    expect(recibido).toBeDefined();
    expect(iguales(recibido?.bytes ?? null, A)).toBe(true);
    expect(iguales(tarde.bytesDe(HASH_A), A)).toBe(true);
    expect(iguales(tarde.assets.get(HASH_A), A)).toBe(true);
  });

  it('publicar dos veces el MISMO sample es idempotente, y un hash nuevo se acepta', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();
    const invitado = new Peer(server.port, 'invitado');
    await invitado.open();

    expect(host.assets.publish(A, { hash: HASH_A, name: 'a.wav', by: 'host' })).toBe('published');
    // Repetirlo con los mismos bytes no es una sustitución: es el mismo archivo.
    expect(host.assets.publish(A, { hash: HASH_A, name: 'a.wav', by: 'host' })).toBe('duplicate');
    await sleep(300);
    // Y con un hash nuevo que nadie había publicado, entra normal.
    expect(invitado.assets.publish(B, { hash: HASH_B, name: 'b.wav', by: 'invitado' })).toBe(
      'published',
    );
    await sleep(300);
    expect(iguales(host.bytesDe(HASH_B), B)).toBe(true);
    // El original sano sigue intacto: rechazar la sustitución no borra nada.
    expect(iguales(host.bytesDe(HASH_A), A)).toBe(true);
    // Nadie recibió un aviso por una republicación idéntica.
    expect(host.avisos).toHaveLength(0);
  });

  it('el binding congela los bytes: un .bin manipulado no cambia el audio local', () => {
    // Sin el servidor en medio: el .bin ya guardado y tocado a mano.
    const doc = new Y.Doc();
    const recibidos: SampleAsset[] = [];
    const avisos: AssetRejection[] = [];
    const binding = new SampleAssetBinding(doc, {
      onAsset: (a) => recibidos.push(a),
      onRejected: (r) => avisos.push(r),
    });
    binding.start();

    // A llega primero: queda congelado con sus bytes.
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', A, 'yo'));
    expect(recibidos).toHaveLength(1);
    expect(iguales(binding.get(HASH_A), A)).toBe(true);

    // El .bin manipulado trae otros bytes bajo el mismo hash.
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', B, 'alguien'));
    // No se anuncia dos veces, se avisa una, y lo que se sirve sigue siendo A.
    expect(recibidos).toHaveLength(1);
    expect(avisos.map((a) => a.reason)).toEqual(['invalid']);
    expect(iguales(binding.get(HASH_A), A)).toBe(true);
    // Y repetir la sustitución no vuelve a avisar (avisa una vez por hash).
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', B, 'otro'));
    expect(avisos).toHaveLength(1);

    binding.destroy();
    doc.destroy();
  });
});