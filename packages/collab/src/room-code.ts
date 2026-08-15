/**
 * Códigos de room: 6 caracteres del alfabeto A-Z2-9 sin ambiguos
 * (sin O/0 ni I/1). Por la red viajan sin guion ("K3P9QF"); para mostrar
 * se formatean como "K3P-9QF".
 */

export const ROOM_CODE_LENGTH = 6;

/** Alfabeto de 32 caracteres sin ambiguos (256 % 32 === 0 → sin sesgo). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Genera un código de room de 6 caracteres (criptográfico si hay crypto). */
export function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[bytes[i]! % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

/** Normaliza entrada del usuario: mayúsculas y sin guiones/espacios. */
export function normalizeRoomCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

/** ¿Es un código válido (6 chars del alfabeto sin ambiguos)? */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** Formatea para mostrar: "K3P9QF" → "K3P-9QF". */
export function formatRoomCode(code: string): string {
  const c = normalizeRoomCode(code);
  return c.length === ROOM_CODE_LENGTH ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}
