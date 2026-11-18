/**
 * Aritmética del color de la Playlist, sin React ni DOM.
 *
 * Todo lo que puede romperse en silencio cuando alguien pinta una pista o una
 * selección vive aquí y se prueba en `test/playlist-colors.test.ts`: qué hex
 * vale, qué tinta contrasta sobre un swatch y de dónde sale el color de un
 * clip. Este archivo NO lleva literales de color (regla dura 4): las dos
 * tintas se importan de `theme/track-palette.ts`.
 */

import { SWATCH_INK_DARK, SWATCH_INK_LIGHT } from '../../theme/track-palette';

/**
 * Un color hex con o sin `#`, de 3, 4, 6 u 8 dígitos.
 *
 * Se aceptan 4 y 8 porque el modelo puede traerlos de un `.orbit` exportado
 * por otra herramienta; la alpha se descarta al normalizar (ver abajo).
 */
const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** ¿Es un color hex que la UI puede pintar? */
export function isHexColor(value: string | null | undefined): boolean {
  return normalizeHexColor(value) !== null;
}

/**
 * Normaliza un color hex a `#rrggbb` en minúsculas, o `null` si no vale.
 *
 * - Acepta `#abc`, `abc`, `#rrggbb`, `#rrggbbaa`, mayúsculas y espacios
 *   alrededor; `#abc` se expande a `#aabbcc`.
 * - La alpha de `#rgba`/`#rrggbbaa` se DESCARTA: el proyecto guarda colores
 *   opacos (`color?: string` sin canal alfa) y `<input type="color">` tampoco
 *   la maneja; conservarla obligaría a inventar un formato que nadie lee.
 * - `''`, `'red'`, `rgb(…)` y longitudes raras son `null`. El campo de texto
 *   los marca en vivo en vez de escribir un valor que el canvas descartaría.
 */
export function normalizeHexColor(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = HEX_COLOR.exec(value.trim());
  if (!match) return null;
  let digits = match[1]!.toLowerCase();
  if (digits.length === 3 || digits.length === 4) {
    digits = digits
      .slice(0, 3)
      .split('')
      .map((digit) => digit + digit)
      .join('');
  }
  return `#${digits.slice(0, 6)}`;
}

/** Convierte un dígito sRGB (0–255) a su valor lineal para la luminancia. */
function linearChannel(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Luminancia relativa de un `#rrggbb` ya normalizado (fórmula WCAG). */
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b);
}

/** Contraste WCAG entre dos luminancias relativas. */
function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const INK_DARK_LUMINANCE = relativeLuminance(SWATCH_INK_DARK);
const INK_LIGHT_LUMINANCE = relativeLuminance(SWATCH_INK_LIGHT);

/**
 * La tinta (check, icono) que más contrasta sobre `bg`.
 *
 * No se usa un umbral fijo de luminancia: un amarillo y un grafito pueden
 * quedar a los dos lados de un 0,45 y uno de ellos acabar con la tinta
 * equivocada. Se comparan los dos contrastes WCAG y gana el mayor, que es la
 * misma decisión que tomaría el ojo. Un `bg` inválido cae en la tinta clara:
 * se supone que el swatch pinta algo a media luminancia y verse claro es
 * mejor que perderse en un fondo oscuro.
 */
export function readableInk(bg: string): string {
  const hex = normalizeHexColor(bg);
  if (!hex) return SWATCH_INK_LIGHT;
  const luminance = relativeLuminance(hex);
  return contrast(luminance, INK_DARK_LUMINANCE) >= contrast(luminance, INK_LIGHT_LUMINANCE)
    ? SWATCH_INK_DARK
    : SWATCH_INK_LIGHT;
}

/** Un color cuenta como ausente si falta o es una cadena vacía. */
function present(color: string | null | undefined): string | undefined {
  return typeof color === 'string' && color.trim() !== '' ? color : undefined;
}

/**
 * Color con el que se dibuja un clip.
 *
 * La cadena de tres argumentos es la que usaba el canvas: color propio del
 * clip → color del patrón → acento del tema. El cuarto (`trackColor`) es la
 * personalización de la pista y va DELIBERADAMENTE por encima del patrón:
 * elegir el color de una pista tiene que pintar lo que hay dentro, o el
 * swatch de la cabecera sería decoración. El color propio del clip sigue
 * ganando a todo — un clip marcado en verde se queda verde aunque su pista
 * sea azul.
 */
export function resolveClipColor(
  clipColor: string | null | undefined,
  patternColor: string | null | undefined,
  accent: string,
  trackColor?: string | null,
): string {
  return present(clipColor) ?? present(trackColor) ?? present(patternColor) ?? accent;
}

/**
 * El color propio que comparten TODOS los clips dados, o `undefined`.
 *
 * Se usa para marcar un preset en el menú de la selección. Compara
 * normalizado, así `#ABC` y `#aabbcc` son el mismo color; si uno no tiene
 * color propio o no coinciden, no hay preset marcado. Fingir que la selección
 * es de un color que no es sería mentir en el menú.
 */
export function commonClipColor(colors: readonly (string | null | undefined)[]): string | undefined {
  if (colors.length === 0) return undefined;
  const first = normalizeHexColor(colors[0]);
  if (first === null) return undefined;
  for (const color of colors) {
    if (normalizeHexColor(color) !== first) return undefined;
  }
  return first;
}
