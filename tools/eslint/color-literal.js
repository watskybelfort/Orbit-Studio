/**
 * ¿Este texto contiene un color literal? Una sola definición, dos lectores.
 *
 * La regla dura 4 se hace cumplir en dos sitios que no comparten runtime: la
 * regla de ESLint `no-hardcoded-colors` (los `.tsx` y `.ts` de
 * `packages/ui/src`) y el script `tools/lint-css-colors.mjs` (los `.css`, que
 * ESLint no ve sin traerse `@eslint/css` y su parser). Hasta la v3.10 los dos
 * llevaban su propia copia del predicado, palabra por palabra — y con el mismo
 * defecto: la regex de funciones no llevaba el flag `i`, así que un
 * `color: RGB(1,2,3)` pasaba por los dos sin que ninguno lo viera.
 *
 * No eran dos bugs: era una línea copiada dos veces. Por eso ahora vive aquí, y
 * es el mismo movimiento que el repo ya hizo con el grafo de paquetes — el dato
 * se escribe una vez y lo leen los que lo necesiten.
 *
 * **Lo que a propósito NO se persigue**: los nombres de color CSS (`red`,
 * `white`). Distinguir `'red'`-el-color de `'red'`-la-palabra necesita saber en
 * qué propiedad cae, y una regla que se equivoca la acaba apagando todo el
 * mundo.
 */

/** Funciones de color de CSS. `i` porque CSS no distingue mayúsculas. */
const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/i;

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX = /#([0-9a-fA-F]+)\b/g;

/**
 * El `#` de una data-URI viaja percent-encoded (`%23ff0000`): dentro de un
 * `url("data:image/svg+xml,…fill='%23ff0000'…")` el navegador lo lee como
 * color y el ojo humano no.
 */
const HEX_ENCODED = /%23([0-9a-fA-F]+)\b/gi;

/**
 * Una referencia a un fragmento SVG (`fill: url(#dead)`) no es un color, pero
 * su id puede caer entero en `[0-9a-fA-F]` y con una longitud de color. Se
 * quitan antes de buscar hex — al revés que el resto de la función, aquí el
 * riesgo es el falso POSITIVO, y un linter que marca lo que está bien se acaba
 * desactivando.
 */
const URL_FRAGMENT = /\burl\(\s*#[^)]*\)/gi;

/** 3, 4, 6 u 8 dígitos es un color; otra longitud es otra cosa (`#12345`, `#root`). */
function esLongitudDeColor(n) {
  return n === 3 || n === 4 || n === 6 || n === 8;
}

export function looksLikeColor(text) {
  if (FUNC.test(text)) return true;
  const limpio = text.replace(URL_FRAGMENT, '');
  for (const m of limpio.matchAll(HEX)) {
    if (esLongitudDeColor(m[1].length)) return true;
  }
  for (const m of limpio.matchAll(HEX_ENCODED)) {
    if (esLongitudDeColor(m[1].length)) return true;
  }
  return false;
}
