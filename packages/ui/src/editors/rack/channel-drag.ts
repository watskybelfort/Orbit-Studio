/**
 * Arrastre de canales dentro del rack (drag nativo del navegador).
 *
 * Va con un tipo MIME propio para que el rack distinga de un vistazo lo que
 * llega: un canal suyo (mover) o un sonido del browser (crear un sampler). En
 * `dragover` el navegador NO deja leer el contenido —solo los tipos—, de ahí
 * que haya dos funciones: una para saber QUÉ viaja y otra, ya en el drop, para
 * saber CUÁL.
 */

import type { Id } from '@orbit/core';

export const CHANNEL_MIME = 'application/x-orbit-channel';

export function setChannelDrag(dt: DataTransfer, channelId: Id): void {
  dt.effectAllowed = 'move';
  dt.setData(CHANNEL_MIME, channelId);
}

/** ¿Lo que se está arrastrando es un canal del rack? */
export function isChannelDrag(dt: DataTransfer): boolean {
  return [...dt.types].includes(CHANNEL_MIME);
}

/** Canal que traía el drop; cadena vacía si no venía ninguno. */
export function getChannelDrag(dt: DataTransfer): Id | '' {
  return dt.getData(CHANNEL_MIME);
}
