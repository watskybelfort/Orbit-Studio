/**
 * Firma de la galería. Se firma DE VERDAD con WebCrypto (se genera un par de
 * claves en cada test), así que lo que se prueba es la propiedad que importa:
 * que tocar el índice después de firmarlo invalida la firma.
 */

import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_ALG,
  canonicalIndex,
  fingerprint,
  sha256Base64,
  toBase64,
  verifyIndex,
  type IndexSignature,
  type SignableIndex,
} from '../src/state/gallery-signature';

const subtle = globalThis.crypto.subtle;

async function keyPair(): Promise<CryptoKeyPair> {
  return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

async function publicKeyBase64(pair: CryptoKeyPair): Promise<string> {
  return toBase64(new Uint8Array(await subtle.exportKey('spki', pair.publicKey)));
}

async function sign(index: SignableIndex, pair: CryptoKeyPair): Promise<IndexSignature> {
  const data = new TextEncoder().encode(canonicalIndex(index));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data);
  return {
    alg: SIGNATURE_ALG,
    key: await publicKeyBase64(pair),
    sig: toBase64(new Uint8Array(sig)),
  };
}

const index: SignableIndex = {
  name: 'Galería de Ana',
  description: 'Cosas que hago',
  plugins: [
    { id: 'tremolo', url: 'https://ana.example/tremolo.js', sha256: 'AAAA' },
    { id: 'chorus', url: 'https://ana.example/chorus.js', sha256: 'BBBB' },
  ],
};

describe('canonicalIndex', () => {
  it('no depende del orden en que vengan los plugins', () => {
    const alReves: SignableIndex = { ...index, plugins: [...index.plugins].reverse() };
    expect(canonicalIndex(alReves)).toBe(canonicalIndex(index));
  });

  it('cubre id, url y hash de cada plugin', () => {
    const text = canonicalIndex(index);
    expect(text).toContain('plugin:tremolo|https://ana.example/tremolo.js|AAAA');
  });

  it('cambiar la URL de un plugin cambia lo que se firma', () => {
    const movido: SignableIndex = {
      ...index,
      plugins: [{ ...index.plugins[0]!, url: 'https://malo.example/x.js' }, index.plugins[1]!],
    };
    expect(canonicalIndex(movido)).not.toBe(canonicalIndex(index));
  });

  it('cambiar el hash de un plugin cambia lo que se firma', () => {
    const otro: SignableIndex = {
      ...index,
      plugins: [{ ...index.plugins[0]!, sha256: 'ZZZZ' }, index.plugins[1]!],
    };
    expect(canonicalIndex(otro)).not.toBe(canonicalIndex(index));
  });

  it('lleva su versión delante: un esquema nuevo no se confunde con este', () => {
    expect(canonicalIndex(index).startsWith('orbit-gallery-v1\n')).toBe(true);
  });
});

describe('verifyIndex', () => {
  it('una firma buena verifica', async () => {
    const pair = await keyPair();
    const result = await verifyIndex(index, await sign(index, pair));
    expect(result.ok).toBe(true);
  });

  it('cambiar la URL de un plugin invalida la firma', async () => {
    const pair = await keyPair();
    const signature = await sign(index, pair);
    const manipulado: SignableIndex = {
      ...index,
      plugins: [
        { ...index.plugins[0]!, url: 'https://malo.example/troyano.js' },
        index.plugins[1]!,
      ],
    };
    const result = await verifyIndex(manipulado, signature);
    expect(result.ok).toBe(false);
  });

  it('cambiar el hash de un plugin invalida la firma', async () => {
    const pair = await keyPair();
    const signature = await sign(index, pair);
    const manipulado: SignableIndex = {
      ...index,
      plugins: [{ ...index.plugins[0]!, sha256: 'otro-hash' }, index.plugins[1]!],
    };
    expect((await verifyIndex(manipulado, signature)).ok).toBe(false);
  });

  it('añadir un plugin invalida la firma', async () => {
    const pair = await keyPair();
    const signature = await sign(index, pair);
    const conExtra: SignableIndex = {
      ...index,
      plugins: [...index.plugins, { id: 'colado', url: 'https://malo.example/c.js' }],
    };
    expect((await verifyIndex(conExtra, signature)).ok).toBe(false);
  });

  it('la firma de OTRA clave no vale', async () => {
    const buena = await keyPair();
    const mala = await keyPair();
    const firmaMala = await sign(index, mala);
    // Se hace pasar por la buena cambiando la clave declarada.
    const suplantada: IndexSignature = { ...firmaMala, key: await publicKeyBase64(buena) };
    expect((await verifyIndex(index, suplantada)).ok).toBe(false);
  });

  it('un algoritmo desconocido se rechaza sin mirar nada más', async () => {
    const pair = await keyPair();
    const signature = {
      ...(await sign(index, pair)),
      alg: 'RSA-DE-LOS-90',
    } as unknown as IndexSignature;
    const result = await verifyIndex(index, signature);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Algoritmo');
  });

  it('una firma ilegible no lanza: devuelve "no verificado"', async () => {
    const pair = await keyPair();
    const signature = { ...(await sign(index, pair)), sig: 'no-es-base64-valido!!' };
    await expect(verifyIndex(index, signature)).resolves.toMatchObject({ ok: false });
  });

  it('una clave que no es una clave tampoco lanza', async () => {
    const pair = await keyPair();
    const signature = { ...(await sign(index, pair)), key: toBase64(new Uint8Array([1, 2, 3])) };
    await expect(verifyIndex(index, signature)).resolves.toMatchObject({ ok: false });
  });

  it('el orden de los plugins no rompe una firma buena', async () => {
    const pair = await keyPair();
    const signature = await sign(index, pair);
    const alReves: SignableIndex = { ...index, plugins: [...index.plugins].reverse() };
    expect((await verifyIndex(alReves, signature)).ok).toBe(true);
  });
});

describe('fingerprint', () => {
  it('es corta, legible y estable', async () => {
    const pair = await keyPair();
    const key = await publicKeyBase64(pair);
    const a = await fingerprint(key);
    expect(a).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
    expect(await fingerprint(key)).toBe(a);
  });

  it('dos claves distintas dan huellas distintas', async () => {
    const a = await fingerprint(await publicKeyBase64(await keyPair()));
    const b = await fingerprint(await publicKeyBase64(await keyPair()));
    expect(a).not.toBe(b);
  });
});

describe('sha256Base64', () => {
  it('el hash cambia si cambia un solo carácter del archivo', async () => {
    const a = await sha256Base64('export function createEffect() {}');
    const b = await sha256Base64('export function createEffect() { }');
    expect(a).not.toBe(b);
  });

  it('es estable', async () => {
    const source = 'export function createEffect() {}';
    expect(await sha256Base64(source)).toBe(await sha256Base64(source));
  });
});
