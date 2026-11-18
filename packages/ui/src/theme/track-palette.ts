/**
 * Los colores de pista de la Playlist y las dos tintas de sus swatches.
 *
 * Vive en `theme/` porque la regla dura 4 solo deja literales de color aquí:
 * un preset es un dato que se pinta con `style={{ background }}` y
 * `<input type="color">` ni siquiera acepta `var(--x)` — necesita `#rrggbb`.
 * Lo mismo vale para la tinta del check sobre el swatch: se calcula en
 * `editors/playlist/color-tools.ts`, pero los dos valores viven aquí.
 *
 * Los diez primeros SON la paleta de fábrica de `core` (`PALETTE`), en el
 * mismo orden. No es casualidad: una pista nace con `pickColor(order)` y
 * "Volver al color de fábrica" tiene que caer dentro de la grilla, o el botón
 * devuelve un color que el usuario no puede volver a elegir de la paleta.
 * Los cuatro últimos completan la rueda para que haya un tono cercano a
 * cualquier idea (cielo, frambuesa, menta y grafito) sin repetir matiz.
 *
 * Los catorce están a media luminancia a propósito: son vibrantes y se
 * distinguen tanto sobre `--surface` del tema oscuro como sobre el claro. La
 * legibilidad del check no depende de eso — la resuelve `readableInk`.
 */

import { pickColor } from '@orbit/core';

export interface TrackColorPreset {
  /** `#rrggbb`, siempre en minúsculas. */
  value: string;
  /** Nombre en español para `title`/`aria-label`. */
  name: string;
}

export const TRACK_COLOR_PRESETS: readonly TrackColorPreset[] = [
  { value: '#5aa9e6', name: 'Azul' },
  { value: '#e6675a', name: 'Coral' },
  { value: '#7ce65a', name: 'Verde' },
  { value: '#e6c95a', name: 'Amarillo' },
  { value: '#b45ae6', name: 'Violeta' },
  { value: '#5ae6c9', name: 'Turquesa' },
  { value: '#e65aa9', name: 'Rosa' },
  { value: '#a9e65a', name: 'Lima' },
  { value: '#5a7ce6', name: 'Índigo' },
  { value: '#e6935a', name: 'Naranja' },
  { value: '#64d2ff', name: 'Cielo' },
  { value: '#ff5c8a', name: 'Frambuesa' },
  { value: '#30d158', name: 'Menta' },
  { value: '#8e8e93', name: 'Grafito' },
];

/**
 * Color de fábrica de la pista `order`, determinista.
 *
 * Envuelve `pickColor` a propósito en vez de reimplementar la rotación: la
 * pista se creó con ese color y "volver al de fábrica" tiene que devolver
 * exactamente el que tenía. Un orden negativo o no finito (un proyecto viejo,
 * un `NaN` de una importación) cae en el primer color en vez de devolver
 * `undefined`: `PALETTE[NaN]` no existe y el canvas no sabría qué pintar.
 */
export function defaultTrackColor(order: number): string {
  return pickColor(Number.isFinite(order) ? Math.max(0, Math.trunc(order)) : 0);
}

/** Tinta oscura para un swatch claro (mismo tono que el texto de clip). */
export const SWATCH_INK_DARK = '#101114';

/** Tinta clara para un swatch oscuro. */
export const SWATCH_INK_LIGHT = '#f7f8fa';
