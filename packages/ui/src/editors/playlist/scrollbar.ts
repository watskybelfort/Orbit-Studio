/**
 * Geometría de las barras de scroll de la Playlist.
 *
 * La Playlist es un `<canvas>` con su propio scroll (`scrollX` en beats,
 * `scrollY` en px), así que no tiene las barras nativas del navegador: solo se
 * movía con la rueda (Shift para horizontal, Ctrl para zoom) y no había forma
 * de VER cuánto contenido quedaba ni de agarrarlo. Estas funciones son la
 * aritmética de una barra arrastrable —tamaño y posición del pulgar, y el
 * scroll que corresponde a una posición del pulgar—, pura para probarla sin DOM.
 * Todo va en las unidades del eje (beats o px); la pista de la barra, en px.
 */

/** Pulgar más pequeño que esto no se puede agarrar con comodidad. */
export const MIN_THUMB_PX = 28;

export interface ThumbGeometry {
  /** Largo del pulgar, px. */
  size: number;
  /** Desplazamiento del pulgar desde el inicio de la pista, px. */
  offset: number;
  /** Scroll máximo, en unidades del eje. */
  maxScroll: number;
}

export function thumbGeometry(
  viewport: number,
  content: number,
  scroll: number,
  track: number,
  minThumb = MIN_THUMB_PX,
): ThumbGeometry {
  const total = Math.max(content, viewport, 1e-9);
  const maxScroll = Math.max(0, total - viewport);
  const size = Math.min(track, Math.max(Math.min(minThumb, track), (track * viewport) / total));
  const room = Math.max(0, track - size);
  const clamped = Math.min(maxScroll, Math.max(0, scroll));
  return { size, offset: maxScroll > 0 ? (clamped / maxScroll) * room : 0, maxScroll };
}

/** El scroll que deja el pulgar en `offset` px. */
export function scrollForOffset(
  offset: number,
  viewport: number,
  content: number,
  track: number,
  minThumb = MIN_THUMB_PX,
): number {
  const { size, maxScroll } = thumbGeometry(viewport, content, 0, track, minThumb);
  const room = track - size;
  if (!(room > 0) || maxScroll === 0) return 0;
  return (Math.min(room, Math.max(0, offset)) / room) * maxScroll;
}

/**
 * Cuánto "mide" la canción a lo ancho, en beats: hasta el último clip y un
 * margen de cuatro compases para poder seguir colocando, nunca menos de 32
 * compases ni menos de lo que ya se está viendo (si no, desplazarse a la
 * derecha encogería la barra bajo el dedo).
 */
export function playlistContentBeats(songEnd: number, scrollX: number, viewBeats: number, barLen: number): number {
  const bar = barLen > 0 ? barLen : 4;
  return Math.max(songEnd + 4 * bar, scrollX + viewBeats, 32 * bar);
}
