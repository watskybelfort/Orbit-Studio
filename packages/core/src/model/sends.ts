/**
 * Envíos: lo que llevan y cómo se cuenta.
 *
 * Un envío dejó de ser un cable con una perilla. Ahora puede tomar la señal
 * antes del fader, mandar solo una parte (el centro, los lados, un canal) e
 * invertir la polaridad — que es lo que lo convierte en un PROCESO dentro del
 * enrutado y no en una suma más.
 *
 * Aquí vive lo que hace falta en los tres sitios que hablan de envíos (el
 * mixer, el grafo y el motor): los valores por defecto —para que un `.orbit`
 * anterior siga significando lo mismo— y la frase que describe uno.
 */

import type { Send, SendPart, SendTap } from './types';

export const SEND_TAPS: SendTap[] = ['post', 'pre'];
export const SEND_PARTS: SendPart[] = ['stereo', 'mid', 'side', 'left', 'right'];

export const SEND_TAP_LABELS: Record<SendTap, string> = {
  post: 'Post-fader',
  pre: 'Pre-fader',
};

export const SEND_PART_LABELS: Record<SendPart, string> = {
  stereo: 'Todo',
  mid: 'Centro (mid)',
  side: 'Lados (side)',
  left: 'Solo izquierdo',
  right: 'Solo derecho',
};

/** Abreviatura para el cable del grafo y para la fila del strip. */
export const SEND_PART_SHORT: Record<SendPart, string> = {
  stereo: '',
  mid: 'M',
  side: 'S',
  left: 'L',
  right: 'R',
};

/**
 * Un envío con todo resuelto.
 *
 * Los campos nuevos son opcionales en el modelo (un `.orbit` de antes no los
 * trae), así que TODO el que lee un envío pasa por aquí: si cada sitio pusiera
 * su propio valor por defecto, acabarían discrepando y el motor sonaría
 * distinto de lo que pinta la UI.
 */
export interface ResolvedSend {
  target: number;
  level: number;
  tap: SendTap;
  part: SendPart;
  invert: boolean;
  pan: number;
  mute: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function resolveSend(send: Send): ResolvedSend {
  return {
    target: send.target,
    level: clamp(Number.isFinite(send.level) ? send.level : 0, 0, 2),
    tap: send.tap === 'pre' ? 'pre' : 'post',
    part: SEND_PARTS.includes(send.part as SendPart) ? (send.part as SendPart) : 'stereo',
    invert: send.invert === true,
    pan: clamp(Number.isFinite(send.pan ?? 0) ? send.pan ?? 0 : 0, -1, 1),
    mute: send.mute === true,
  };
}

/** ¿Este envío hace algo más que llevar la señal tal cual? */
export function sendIsShaped(send: Send): boolean {
  const r = resolveSend(send);
  return r.tap !== 'post' || r.part !== 'stereo' || r.invert || r.pan !== 0;
}

/**
 * Cómo se lee un envío de un vistazo: "pre · lados · ø". Cadena vacía cuando no
 * tiene nada especial — un envío normal no necesita explicarse.
 */
export function describeSend(send: Send): string {
  const r = resolveSend(send);
  const bits: string[] = [];
  if (r.tap === 'pre') bits.push('pre');
  if (r.part !== 'stereo') bits.push(SEND_PART_LABELS[r.part].toLowerCase());
  if (r.invert) bits.push('invertido');
  if (r.pan !== 0) bits.push(r.pan < 0 ? 'izq' : 'der');
  if (r.mute) bits.push('silenciado');
  return bits.join(' · ');
}
