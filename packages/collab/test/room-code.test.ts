/** Códigos de room: generación, validación y formato. */

import { describe, expect, it } from 'vitest';
import {
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from '../src/room-code';

describe('room-code', () => {
  it('genera códigos válidos de 6 chars sin ambiguos', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      for (const ch of code) {
        expect(ROOM_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it('el alfabeto no tiene caracteres ambiguos', () => {
    for (const ambiguo of ['O', '0', 'I', '1']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(ambiguo);
    }
  });

  it('normaliza entrada del usuario (guiones, minúsculas, espacios)', () => {
    expect(normalizeRoomCode('k3p-9qf')).toBe('K3P9QF');
    expect(normalizeRoomCode(' K3P 9QF ')).toBe('K3P9QF');
  });

  it('formatea para mostrar como XXX-XXX', () => {
    expect(formatRoomCode('K3P9QF')).toBe('K3P-9QF');
    expect(formatRoomCode('k3p-9qf')).toBe('K3P-9QF');
  });

  it('rechaza códigos inválidos', () => {
    expect(isValidRoomCode('K3P9Q')).toBe(false); // corto
    expect(isValidRoomCode('K3P9QF0')).toBe(false); // largo
    expect(isValidRoomCode('K3P9Q0')).toBe(false); // 0 ambiguo
    expect(isValidRoomCode('K3P9QI')).toBe(false); // I ambiguo
    expect(isValidRoomCode('k3p9qf')).toBe(false); // minúsculas: normalizar antes
  });
});
