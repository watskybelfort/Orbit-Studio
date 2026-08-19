import { describe, expect, it } from 'vitest';
import {
  AUTH_MAX_ITERATIONS,
  AUTH_MIN_ITERATIONS,
  authMessage,
  fromBase64,
  makeProof,
  makeRoomAuth,
  parseRoomAuth,
  randomNonce,
  timingSafeEqual,
  toBase64,
  verifyProof,
} from '../src/room-auth';
import { parseControl } from '../src/control';

// Las iteraciones de verdad (210k) tardan ~150 ms por derivación y aquí se
// derivan decenas de veces: los tests usan el mínimo admitido, que ejercita el
// MISMO camino.
const ITERS = AUTH_MIN_ITERATIONS;

describe('room-auth', () => {
  it('la prueba correcta entra', async () => {
    const record = await makeRoomAuth('el sotano 2026', ITERS);
    const message = authMessage('K3P9QF', randomNonce());
    const proof = await makeProof('el sotano 2026', record.salt, record.iterations, message);
    expect(await verifyProof(record, message, proof)).toBe(true);
  });

  it('otra contraseña no entra', async () => {
    const record = await makeRoomAuth('el sotano 2026', ITERS);
    const message = authMessage('K3P9QF', randomNonce());
    const proof = await makeProof('el sotano 2025', record.salt, record.iterations, message);
    expect(await verifyProof(record, message, proof)).toBe(false);
  });

  it('la prueba de una sala no vale en otra', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    const nonce = randomNonce();
    const proof = await makeProof('clave', record.salt, record.iterations, authMessage('AAAAAA', nonce));
    expect(await verifyProof(record, authMessage('BBBBBB', nonce), proof)).toBe(false);
  });

  it('la prueba de una conexion no vale en la siguiente (nonce de un solo uso)', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    const primero = authMessage('K3P9QF', randomNonce());
    const proof = await makeProof('clave', record.salt, record.iterations, primero);
    const segundo = authMessage('K3P9QF', randomNonce());
    expect(await verifyProof(record, primero, proof)).toBe(true);
    expect(await verifyProof(record, segundo, proof)).toBe(false);
  });

  it('lo guardado NO sirve para entrar: storedKey no es la clave que firma', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    const message = authMessage('K3P9QF', randomNonce());
    // Un ladron del archivo de la sala tiene storedKey. Si intenta usarlo como
    // si fuera clientKey (lo mas directo que puede probar), no pasa.
    const stored = fromBase64(record.storedKey);
    const falso = toBase64(stored);
    expect(await verifyProof(record, message, falso)).toBe(false);
  });

  it('cada sala tiene su sal: la misma contrasena da registros distintos', async () => {
    const a = await makeRoomAuth('misma', ITERS);
    const b = await makeRoomAuth('misma', ITERS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.storedKey).not.toBe(b.storedKey);
  });

  it('una prueba con basura no revienta la verificacion', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    const message = authMessage('K3P9QF', randomNonce());
    expect(await verifyProof(record, message, 'no es base64 ni de lejos !!!')).toBe(false);
    expect(await verifyProof(record, message, '')).toBe(false);
    expect(await verifyProof(record, message, toBase64(new Uint8Array(8)))).toBe(false);
  });

  it('timingSafeEqual compara contenido, no referencia', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('parseRoomAuth', () => {
  it('acepta un registro bien formado', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    expect(parseRoomAuth(record)).toEqual(record);
    expect(parseRoomAuth(JSON.parse(JSON.stringify(record)))).toEqual(record);
  });

  it('rechaza iteraciones fuera de rango (la puerta de adorno)', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    expect(parseRoomAuth({ ...record, iterations: 1 })).toBeNull();
    expect(parseRoomAuth({ ...record, iterations: AUTH_MAX_ITERATIONS + 1 })).toBeNull();
    expect(parseRoomAuth({ ...record, iterations: 12.5 })).toBeNull();
  });

  it('rechaza claves y sales de tamano equivocado', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    expect(parseRoomAuth({ ...record, storedKey: toBase64(new Uint8Array(16)) })).toBeNull();
    expect(parseRoomAuth({ ...record, salt: toBase64(new Uint8Array(4)) })).toBeNull();
  });

  it('rechaza lo que no es un registro', () => {
    expect(parseRoomAuth(null)).toBeNull();
    expect(parseRoomAuth('clave')).toBeNull();
    expect(parseRoomAuth({ v: 2, salt: 'AAAA', iterations: 210000, storedKey: 'AAAA' })).toBeNull();
    expect(parseRoomAuth({})).toBeNull();
  });
});

describe('control: mensajes de la puerta', () => {
  it('challenge ida y vuelta', () => {
    const json = JSON.stringify({ type: 'challenge', salt: 'c2FsdA==', iterations: 210000, nonce: 'bm9uY2U=' });
    expect(parseControl(json)).toEqual({
      type: 'challenge',
      salt: 'c2FsdA==',
      iterations: 210000,
      nonce: 'bm9uY2U=',
    });
  });

  it('un challenge con iteraciones ridiculas se descarta', () => {
    const json = JSON.stringify({ type: 'challenge', salt: 'c2FsdA==', iterations: 1, nonce: 'bm9uY2U=' });
    expect(parseControl(json)).toBeNull();
  });

  it('auth: se descarta una prueba desmesurada', () => {
    expect(parseControl(JSON.stringify({ type: 'auth', proof: 'x'.repeat(40) }))).toEqual({
      type: 'auth',
      proof: 'x'.repeat(40),
    });
    expect(parseControl(JSON.stringify({ type: 'auth', proof: 'x'.repeat(5000) }))).toBeNull();
  });

  it('setPassword acepta null (quitar) y valida el registro', async () => {
    const record = await makeRoomAuth('clave', ITERS);
    expect(parseControl(JSON.stringify({ type: 'setPassword', auth: null }))).toEqual({
      type: 'setPassword',
      auth: null,
    });
    expect(parseControl(JSON.stringify({ type: 'setPassword', auth: record }))).toEqual({
      type: 'setPassword',
      auth: record,
    });
    expect(
      parseControl(JSON.stringify({ type: 'setPassword', auth: { ...record, iterations: 1 } })),
    ).toBeNull();
  });

  it('roomAuth solo con booleano', () => {
    expect(parseControl(JSON.stringify({ type: 'roomAuth', protected: true }))).toEqual({
      type: 'roomAuth',
      protected: true,
    });
    expect(parseControl(JSON.stringify({ type: 'roomAuth', protected: 'si' }))).toBeNull();
  });

  it('authOk no lleva nada', () => {
    expect(parseControl(JSON.stringify({ type: 'authOk' }))).toEqual({ type: 'authOk' });
  });
});
