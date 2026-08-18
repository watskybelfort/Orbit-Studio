import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from '../src/room-path';

describe('normalizeRoomCode', () => {
  it('acepta un código válido y lo pasa a mayúsculas', () => {
    expect(normalizeRoomCode('/K3P9QF')).toBe('K3P9QF');
    expect(normalizeRoomCode('/k3p9qf')).toBe('K3P9QF');
  });

  it('tolera barras y guiones de adorno', () => {
    expect(normalizeRoomCode('/k3p-9qf')).toBe('K3P9QF');
    expect(normalizeRoomCode('//K3P-9Q-F/')).toBe('K3P9QF');
  });

  it('rechaza longitudes que no son 6', () => {
    expect(normalizeRoomCode('/K3P9Q')).toBeNull();
    expect(normalizeRoomCode('/K3P9QFA')).toBeNull();
    expect(normalizeRoomCode('/')).toBeNull();
    expect(normalizeRoomCode('')).toBeNull();
  });

  it('rechaza caracteres ambiguos (O/0, I/1) y símbolos', () => {
    expect(normalizeRoomCode('/K3P9Q0')).toBeNull(); // 0
    expect(normalizeRoomCode('/K3P9QO')).toBeNull(); // O
    expect(normalizeRoomCode('/K3P9QI')).toBeNull(); // I
    expect(normalizeRoomCode('/K3P9Q1')).toBeNull(); // 1
    expect(normalizeRoomCode('/../etc')).toBeNull();
    expect(normalizeRoomCode('/K3P9Q!')).toBeNull();
  });
});
