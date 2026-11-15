import { describe, expect, it } from 'vitest';
import { encodeControl, parseControl, readControlBody } from '../src/control';
import * as decoding from 'lib0/decoding';

const token = 'x'.repeat(40);

describe('credencial de sesión en el canal de control', () => {
  it('session lleva token y rol', () => {
    expect(parseControl(JSON.stringify({ type: 'session', token, role: 'invitado' }))).toEqual({
      type: 'session',
      token,
      role: 'invitado',
    });
    expect(parseControl(JSON.stringify({ type: 'session', token, role: 'dios' }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'session', token: 'corto', role: 'productor' }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'session', token: 'x'.repeat(600), role: 'productor' }))).toBeNull();
  });

  it('resume viaja con los clientID y no admite basura', () => {
    expect(parseControl(JSON.stringify({
      type: 'resume',
      token,
      clientIds: [7, 7, 9],
    }))).toEqual({ type: 'resume', token, clientIds: [7, 9] });

    expect(parseControl(JSON.stringify({ type: 'resume', token, clientIds: [-1] }))).toBeNull();
    expect(parseControl(JSON.stringify({ type: 'resume', token, clientIds: ['7'] }))).toBeNull();
    expect(parseControl(JSON.stringify({
      type: 'resume',
      token,
      clientIds: Array.from({ length: 9 }, (_, i) => i),
    }))).toBeNull();
  });

  it('sessionExpired es un aviso sin campos', () => {
    expect(parseControl(JSON.stringify({ type: 'sessionExpired' }))).toEqual({ type: 'sessionExpired' });
  });

  it('el mensaje sobrevive al codec binario del protocolo', () => {
    const encoded = encodeControl({ type: 'resume', token, clientIds: [3] });
    const decoder = decoding.createDecoder(encoded);
    expect(decoding.readVarUint(decoder)).toBe(2);
    expect(readControlBody(decoder)).toEqual({ type: 'resume', token, clientIds: [3] });
  });
});
