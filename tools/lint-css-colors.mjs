/**
 * `npm run lint:css` — la regla dura 4 aplicada a los `.css`.
 *
 * ESLint cubre los `.tsx` y `.ts` de `packages/ui/src` con
 * `orbit/no-hardcoded-colors`, pero los `.css` no los ve, y ahí es donde
 * estaban casi todos: veintitantos literales repartidos por ocho archivos,
 * más cinco `var(--x, #hex)` con fallback, que son peores porque funcionan
 * hasta que el token no está definido y entonces pintan un color que no es de
 * ningún tema.
 *
 * **Por qué un script y no una regla de ESLint.** Para que ESLint entienda CSS
 * hay que traer `@eslint/css` y su parser, y `tools/eslint/index.js` dice
 * explícitamente que el plugin de reglas duras va sin dependencias. Esto son
 * cien líneas sin ninguna, del mismo estilo que el resto de `tools/`.
 *
 * **La excepción, que es la de la regla 4**: los editores que pintan en
 * `<canvas>` declaran su paleta por tema (`--au-*`, `--pr-*`, `--pl-*`) con
 * valores literales a propósito, porque `getComputedStyle()` no resuelve una
 * custom property que referencia otra. Esas declaraciones se saltan; cualquier
 * otra cosa que parezca un color fuera de `theme/` es un error.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/;
const HEX = /#([0-9a-fA-F]+)\b/g;
/** Las paletas de canvas de la regla 4: literales a propósito. */
const CANVAS_PALETTE_PROP = /^--(?:au|pr|pl)-/i;

function looksLikeColor(text) {
  if (FUNC.test(text)) return true;
  for (const m of text.matchAll(HEX)) {
    const n = m[1].length;
    // 3/4/6/8 dígitos es un color; otras longitudes son otra cosa (un id de
    // fragmento en una `url()`, por ejemplo).
    if (n === 3 || n === 4 || n === 6 || n === 8) return true;
  }
  return false;
}

/** Borra comentarios conservando los saltos, para no mover los números de línea. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

const files = execSync('git ls-files "packages/ui/src/**/*.css"')
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);

let violations = 0;
for (const rel of files) {
  // Donde los colores SÍ viven: es la excepción que hace verdadera a la regla.
  if (rel.startsWith('packages/ui/src/theme/')) continue;
  const text = stripComments(readFileSync(rel, 'utf8'));
  const declRe = /(--[\w-]+|[a-zA-Z-]+)\s*:\s*([^;{}]+);/g;
  let m;
  while ((m = declRe.exec(text))) {
    const [, prop, value] = m;
    if (CANVAS_PALETTE_PROP.test(prop)) continue;
    if (looksLikeColor(value)) {
      violations++;
      console.error(`${rel}:${lineOf(text, m.index)}  ${prop}: ${value.trim()}`);
    }
  }
}

if (violations) {
  console.error(
    `\n${violations} color(es) hardcodeado(s) fuera de packages/ui/src/theme/ (regla dura 4 de CLAUDE.md).\n` +
      'Si el color no tiene token, el arreglo es crear el token — no un `var(--x, #hex)` con fallback.',
  );
  process.exit(1);
}
console.log(`lint:css — ${files.length} archivos, ningún color fuera de theme/`);
