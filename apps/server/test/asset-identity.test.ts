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
import { createHash } from 'node:crypto';
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
/** El hash de un sample ES el sha1 de sus bytes: la identidad se comprueba de verdad. */
const sha1 = (bytes: Uint8Array): string => createHash('sha1').update(bytes).digest('hex');

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
/** A (220 Hz) y B (440 Hz): mismo tamaño y forma, distinto audio. */
const HASH_A = sha1(A);
const HASH_B = sha1(B);
/** Una clave que NO es el sha1 de nada: como la que dejaba el cliente viejo. */
const HASH_LEGADO = 'parte-1';

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

  it('el receptor guarda la HUELLA, no una copia: no se sirve lo que no encaja', () => {
    // Sin el servidor en medio: el .bin ya guardado y tocado a mano.
    const doc = new Y.Doc();
    const recibidos: SampleAsset[] = [];
    const avisos: AssetRejection[] = [];
    const binding = new SampleAssetBinding(doc, {
      onAsset: (a) => recibidos.push(a),
      onRejected: (r) => avisos.push(r),
    });
    binding.start();

    // A llega primero y es lo que se sirve.
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', A, 'yo'));
    expect(recibidos).toHaveLength(1);
    expect(iguales(binding.get(HASH_A), A)).toBe(true);

    // El .bin manipulado trae otros bytes bajo el mismo hash.
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', B, 'alguien'));
    // No se anuncia dos veces, se avisa una, y NO se sirven bytes que no son los
    // de su hash (el servidor va a devolver el original por su lado).
    expect(recibidos).toHaveLength(1);
    expect(avisos.map((a) => a.reason)).toEqual(['invalid']);
    expect(binding.get(HASH_A)).toBeNull();
    // Y repetir la sustitución no vuelve a avisar (avisa una vez por hash).
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', B, 'otro'));
    expect(avisos).toHaveLength(1);
    expect(binding.get(HASH_A)).toBeNull();

    // Cuando el original vuelve (lo restituye el servidor), se sirve otra vez.
    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', A, 'servidor'));
    expect(iguales(binding.get(HASH_A), A)).toBe(true);

    binding.destroy();
    doc.destroy();
  });

  it('el receptor NO retiene los bytes: ni de los rechazados ni de los borrados', () => {
    const doc = new Y.Doc();
    const binding = new SampleAssetBinding(doc, { maxAssetBytes: 4 });
    binding.start();
    const mapa = doc.getMap<SampleAsset>('assets');

    // Un blob de 8 bytes con el tope en 4: se rechaza y NO se guarda nada suyo.
    const grande = new Uint8Array(8);
    mapa.set('h1', asset('h1', 'grande.wav', grande, 'yo'));
    expect(binding.get('h1')).toBeNull();

    // Añadir y borrar muchos no deja nada detrás: la huella son ~40 bytes, no el
    // audio. Aquí se mira lo observable: el contador de la sala vuelve a cero.
    // Mismo contenido cada vez (es el mismo archivo): añadir y borrar cinco veces
    // no deja nada detrás. La huella son ~40 bytes por clave, no el audio.
    for (let i = 0; i < 5; i++) {
      mapa.set('h2', asset('h2', 'corto.wav', new Uint8Array([7]), 'yo'));
      expect(binding.get('h2')).not.toBeNull();
      doc.transact(() => mapa.delete('h2'));
    }
    expect(binding.hashes).not.toContain('h2');
    expect(binding.get('h2')).toBeNull();

    // Lo que se retiene de un asset aceptado es solo su identidad (~40 bytes), nunca
    // el audio, y NADA de lo que se rechazó: `h1` (8 bytes con el tope en 4) no
    // dejó ni huella. Eso se mide mirando lo que el binding retiene, que es
    // justo lo que se quejó la revisión.
    const identidades = (b: unknown): number =>
      (b as { identity: Map<string, string> }).identity.size;
    expect(identidades(binding)).toBe(1); // solo h2, el que sí se aceptó

    // Y al soltar el observer (destroy) se sueltan también esas identidades.
    binding.destroy();
    expect(identidades(binding)).toBe(0);

    binding.destroy();
    doc.destroy();
  });

  it('borrar el sample y republicar OTRO audio bajo el mismo hash tampoco vale', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();

    host.assets.publish(A, { hash: HASH_A, name: 'a.wav', by: 'host' });
    await sleep(300);
    expect(iguales(host.bytesDe(HASH_A), A)).toBe(true);

    // El productor borra el sample: ya no hay original que devolver.
    host.doc.transact(() => host.doc.getMap<SampleAsset>('assets').delete(HASH_A));
    await sleep(300);
    expect(host.bytesDe(HASH_A)).toBeNull();

    // Y ahora publica OTRO audio (B) bajo el MISMO hash de A.
    host.assets.publish(B, { hash: HASH_A, name: 'a.wav', by: 'host' });
    await sleep(400);

    // No entra: el hash de A no es el sha1 de B. Ni el mapa ni el audio lo dan
    // por bueno, y quien entre tarde tampoco lo oye.
    expect(host.bytesDe(HASH_A)).toBeNull();
    const tarde = new Peer(server.port, 'tarde');
    await tarde.open();
    await sleep(300);
    expect(tarde.bytesDe(HASH_A)).toBeNull();
    expect(tarde.recibidos.filter((a) => a.hash === HASH_A)).toEqual([]);
  });

  it('una clave que NO es sha1 se acepta, pero su contenido tampoco se cambia', async () => {
    // Compatibilidad: el cliente viejo publicaba con el id de la parte cuando no
    // habia WebCrypto. Esa sala tiene que seguir sonando.
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();

    expect(host.assets.publish(A, { hash: HASH_LEGADO, name: 'a.wav', by: 'host' })).toBe(
      'published',
    );
    await sleep(300);
    expect(iguales(host.bytesDe(HASH_LEGADO), A)).toBe(true);

    // Con la misma clave pero otro contenido: no hay sha1 que comparar, pero se
    // recuerda la huella de lo aceptado.
    host.doc.transact(() => host.doc.getMap<SampleAsset>('assets').set(HASH_LEGADO, asset(HASH_LEGADO, 'a.wav', B, 'otro')));
    await sleep(400);
    expect(iguales(host.bytesDe(HASH_LEGADO), A)).toBe(true);
  });

  it('una PRIMERA publicacion con bytes que no son su hash se rechaza', async () => {
    const server = await serve();
    const host = new Peer(server.port, 'host');
    await host.open();

    // B publicado con el hash de A: la correspondencia se comprueba en la primera
    // publicacion tambien, no solo cuando algo ya estaba antes.
    host.doc.transact(() => host.doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', B, 'yo')));
    await sleep(400);
    expect(host.bytesDe(HASH_A)).toBeNull();

    // Y el que se publica bien, entra.
    host.doc.transact(() => host.doc.getMap<SampleAsset>('assets').set(HASH_B, asset(HASH_B, 'b.wav', B, 'yo')));
    await sleep(300);
    expect(iguales(host.bytesDe(HASH_B), B)).toBe(true);
  });

  it('el receptor comprueba el SHA-1 de verdad en la PRIMERA publicación', async () => {
    // Sin servidor: un `.bin` manipulado o un cliente que publica B con el hash de
    // A. La huella del receptor dice «son los mismos bytes que la primera vez», pero
    // no dice que esa primera vez fingiera, así que el digest se comprueba en segundo
    // plano y el hash pasa a sospechoso si no cuadra.
    const doc = new Y.Doc();
    const recibidos: SampleAsset[] = [];
    const avisos: AssetRejection[] = [];
    const binding = new SampleAssetBinding(doc, {
      onAsset: (a) => recibidos.push(a),
      onRejected: (r) => avisos.push(r),
    });
    binding.start();

    doc.getMap<SampleAsset>('assets').set(HASH_A, asset(HASH_A, 'a.wav', B, 'alguien'));
    await new Promise((r) => setTimeout(r, 50));

    // Los bytes NO son los de su hash: no se sirven y se avisa.
    expect(binding.get(HASH_A)).toBeNull();
    expect(avisos.map((a) => a.reason)).toContain('invalid');
    expect(recibidos).toHaveLength(1);
    binding.destroy();
    doc.destroy();

    // Y un sample bien publicado con SU hash se sirve como siempre.
    const doc2 = new Y.Doc();
    const binding2 = new SampleAssetBinding(doc2);
    binding2.start();
    doc2.getMap<SampleAsset>('assets').set(HASH_B, asset(HASH_B, 'b.wav', B, 'yo'));
    await new Promise((r) => setTimeout(r, 50));
    expect(iguales(binding2.get(HASH_B), B)).toBe(true);
    binding2.destroy();
    doc2.destroy();
  });

  it('el tope de la SALA se comprueba antes de la huella y del contador', () => {
    const doc = new Y.Doc();
    const avisos: AssetRejection[] = [];
    // 10 bytes de presupuesto para la sala: entra uno de 8 y el de 4 ya no cabe.
    const binding = new SampleAssetBinding(doc, {
      maxAssetBytes: 8,
      maxRoomBytes: 10,
      onRejected: (r) => avisos.push(r),
    });
    binding.start();
    const mapa = doc.getMap<SampleAsset>('assets');
    mapa.set('h1', asset('h1', 'a.wav', new Uint8Array(8), 'yo'));
    expect(binding.get('h1')).not.toBeNull();

    mapa.set('h2', asset('h2', 'b.wav', new Uint8Array(4), 'yo'));
    // No se sirve, no se anuncia, y el aviso es el de la sala llena.
    expect(binding.get('h2')).toBeNull();
    expect(avisos.map((a) => a.reason)).toContain('room-full');
    // Y no se recuerda su identidad: lo que no entra, no ocupa (ni 40 bytes).
    const identidades = (b: unknown): number =>
      (b as { identity: Map<string, string> }).identity.size;
    expect(identidades(binding)).toBe(1);
    binding.destroy();
    doc.destroy();
  });
});
