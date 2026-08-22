import { describe, expect, it } from 'vitest';
import {
  SEND_PARTS,
  describeSend,
  resolveSend,
  sendIsShaped,
  type Send,
} from '../src';

const plain: Send = { target: 3, level: 0.5 };

describe('resolveSend', () => {
  it('un envío de siempre (sin campos nuevos) sigue significando lo mismo', () => {
    expect(resolveSend(plain)).toEqual({
      target: 3,
      level: 0.5,
      tap: 'post',
      part: 'stereo',
      invert: false,
      pan: 0,
      mute: false,
    });
  });

  it('acota el nivel y el pan a su rango', () => {
    expect(resolveSend({ ...plain, level: 99 }).level).toBe(2);
    expect(resolveSend({ ...plain, level: -1 }).level).toBe(0);
    expect(resolveSend({ ...plain, pan: 5 }).pan).toBe(1);
    expect(resolveSend({ ...plain, pan: -5 }).pan).toBe(-1);
  });

  it('un valor que no existe cae al de siempre en vez de romper', () => {
    const raro = { ...plain, tap: 'lo-que-sea', part: 'diagonal' } as unknown as Send;
    expect(resolveSend(raro)).toMatchObject({ tap: 'post', part: 'stereo' });
  });

  it('un nivel que no es número no deja el envío en NaN', () => {
    const roto = { ...plain, level: Number.NaN } as Send;
    expect(resolveSend(roto).level).toBe(0);
  });

  it('acepta las cinco partes', () => {
    for (const part of SEND_PARTS) {
      expect(resolveSend({ ...plain, part }).part).toBe(part);
    }
  });
});

describe('sendIsShaped', () => {
  it('un envío normal no está moldeado', () => {
    expect(sendIsShaped(plain)).toBe(false);
  });

  it('cualquier cosa que cambie la señal lo marca', () => {
    expect(sendIsShaped({ ...plain, tap: 'pre' })).toBe(true);
    expect(sendIsShaped({ ...plain, part: 'side' })).toBe(true);
    expect(sendIsShaped({ ...plain, invert: true })).toBe(true);
    expect(sendIsShaped({ ...plain, pan: -0.5 })).toBe(true);
  });

  it('silenciarlo no es moldearlo: no cambia lo que lleva, lo apaga', () => {
    expect(sendIsShaped({ ...plain, mute: true })).toBe(false);
  });
});

describe('describeSend', () => {
  it('un envío normal no se explica', () => {
    expect(describeSend(plain)).toBe('');
  });

  it('junta lo que tiene de especial, en orden', () => {
    expect(describeSend({ ...plain, tap: 'pre', part: 'side', invert: true })).toBe(
      'pre · lados (side) · invertido',
    );
  });

  it('el pan se cuenta por su lado', () => {
    expect(describeSend({ ...plain, pan: -0.4 })).toContain('izq');
    expect(describeSend({ ...plain, pan: 0.4 })).toContain('der');
  });
});
