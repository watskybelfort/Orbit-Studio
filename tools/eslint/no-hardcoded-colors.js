/**
 * `orbit/no-hardcoded-colors` — la regla 4 de CLAUDE.md, en código.
 *
 *   «Temas: ningún color hardcodeado en componentes — todo por CSS variables
 *    (tokens en packages/ui/src/theme/).»
 *
 * Un `#5aa9e6` suelto en un componente no rompe nada hoy: rompe el día que el
 * usuario cambia el acento y ese trozo de interfaz se queda con el azul de
 * fábrica. Y no se ve en una revisión, porque es una cadena de siete
 * caracteres en medio de un JSX de doscientas líneas.
 *
 * Qué es un color para la regla:
 *   - `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`
 *   - `rgb(` / `rgba(` / `hsl(` / `hsla(` / `hwb(` / `lab(` / `lch(` /
 *     `oklab(` / `oklch(`
 *
 * Se mira en cadenas y en plantillas, que es donde acaban los colores de
 * verdad: `style={{ background: '#111' }}`, `ctx.fillStyle = '#111'`, y el
 * `${}` de una plantilla de CSS en línea.
 *
 * Lo que NO se mira: `packages/ui/src/theme/**`. Ahí es donde los colores se
 * DEFINEN — es la única carpeta que puede escribir un valor literal, y por eso
 * eslint.config.js la deja fuera. Los nombres de color CSS (`red`, `white`)
 * tampoco se persiguen: distinguir `'red'`-el-color de `'red'`-la-palabra
 * necesita saber en qué propiedad cae, y una regla que se equivoca la apaga
 * todo el mundo.
 */

const FUNC = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/;
const HEX = /#([0-9a-fA-F]+)\b/g;

/** `#12345` no es un color (cinco dígitos); `#root` tampoco. */
function looksLikeColor(text) {
  if (FUNC.test(text)) return true;
  for (const m of text.matchAll(HEX)) {
    const n = m[1].length;
    if (n === 3 || n === 4 || n === 6 || n === 8) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ningún color hardcodeado en componentes: todo por variables CSS (regla 4 de CLAUDE.md).',
    },
    schema: [],
    messages: {
      color:
        'Color literal en un componente (`{{value}}`): regla 4 de CLAUDE.md — sácalo a un token de packages/ui/src/theme/ y léelo por variable CSS.',
    },
  },

  create(context) {
    function report(node, raw) {
      const value = raw.length > 40 ? `${raw.slice(0, 37)}…` : raw;
      context.report({ node, messageId: 'color', data: { value } });
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        if (looksLikeColor(node.value)) report(node, node.value.trim());
      },
      TemplateElement(node) {
        const raw = node.value?.cooked ?? node.value?.raw ?? '';
        if (looksLikeColor(raw)) report(node, raw.trim());
      },
    };
  },
};
