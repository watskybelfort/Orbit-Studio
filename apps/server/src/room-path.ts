/**
 * Validación del código de sala que llega en el path del WebSocket.
 *
 * Aislado del arranque del servidor (que tiene efectos de red al importarse)
 * para poder probarlo sin levantar nada.
 */

/** 6 chars del alfabeto sin ambiguos (sin O/0 ni I/1). */
export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;

/**
 * Normaliza el path del WS a un código de sala válido, o `null` si no lo es.
 * Acepta barras, guiones y minúsculas ("/k3p-9qf" → "K3P9QF"); cualquier otra
 * cosa (longitud, caracteres ambiguos, símbolos) se rechaza.
 */
export function normalizeRoomCode(rawPath: string): string | null {
  const code = rawPath.replace(/\//g, '').replace(/-/g, '').toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : null;
}
