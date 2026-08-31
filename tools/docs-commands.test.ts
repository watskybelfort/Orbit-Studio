/**
 * Que la lista de comandos no se quede atrás del `package.json`.
 *
 * Este repo ya se tropezó dos veces seguidas con lo mismo. En la v3.9 se
 * arregló que `npm run lint` no estuviera en el arranque rápido del README
 * (commit `5ad9ca4`, «la lista de comandos no nombraba el linter que rompe la
 * CI») — y esa MISMA ronda estrenó `lint:css` y `listen:kit` sin añadirlos a
 * ninguna de las dos listas. Se arregló la instancia y no la clase, que es
 * justo el modo de fallo que el repo se dedica a cazar en las demás partes.
 *
 * Así que la comprobación vive aquí y no en la cabeza de nadie: si añadís un
 * script, este test te obliga a decir para qué sirve en el sitio donde alguien
 * lo va a buscar.
 *
 * **Dónde se busca un comando, y por qué son dos sitios y no uno.** `CLAUDE.md`
 * es la lista operativa —la lee quien va a trabajar en el repo, y ahí tienen
 * que estar TODOS—; el README es la puerta de entrada, y ahí basta con los que
 * alguien necesita para arrancar. Por eso el test es estricto con el primero y
 * solo exige un subconjunto del segundo: una lista de bienvenida con diez
 * comandos no da la bienvenida a nadie.
 *
 * Mismo patrón que `tools/eslint/package-graph.test.ts`, que hace esto con el
 * grafo de paquetes: el dato vive en un sitio y el test comprueba que lo que se
 * escribió al lado no ha divergido.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Los `.md` se leen normalizados: el checkout de Windows los trae con CRLF. */
function leer(rel: string): string {
  return readFileSync(resolve(RAIZ, rel), 'utf8').replace(/\r\n?/g, '\n');
}

const scripts = Object.keys(
  (JSON.parse(leer('package.json')) as { scripts: Record<string, string> }).scripts,
);

/**
 * Los que el README tiene que nombrar sí o sí: lo mínimo para clonar, arrancar
 * y no romper la CI. El resto son de trabajo diario y viven en CLAUDE.md.
 */
const IMPRESCINDIBLES_EN_README = ['dev', 'test', 'typecheck', 'lint'];

describe('la lista de comandos documentada no se queda atrás del package.json', () => {
  it('CLAUDE.md nombra TODOS los scripts', () => {
    const doc = leer('CLAUDE.md');
    const faltan = scripts.filter((s) => !doc.includes(`npm run ${s}`) && !doc.includes(`npm ${s}`));
    expect(
      faltan,
      `Estos scripts existen en package.json y CLAUDE.md no los nombra: ${faltan.join(', ')}. ` +
        'Añadilos al bloque «## Comandos» con una línea que diga para qué sirven.',
    ).toEqual([]);
  });

  it('el README nombra al menos los imprescindibles para arrancar', () => {
    const doc = leer('README.md');
    const faltan = IMPRESCINDIBLES_EN_README.filter(
      (s) => !doc.includes(`npm run ${s}`) && !doc.includes(`npm ${s}`),
    );
    expect(
      faltan,
      `El README no nombra: ${faltan.join(', ')}. Es la puerta de entrada del repo.`,
    ).toEqual([]);
  });

  it('los imprescindibles del README siguen existiendo en package.json', () => {
    // La otra dirección de la misma verdad: si alguien renombra `test`, esta
    // lista deja de significar nada y el test de arriba pasaría vacío.
    const inventados = IMPRESCINDIBLES_EN_README.filter((s) => !scripts.includes(s));
    expect(
      inventados,
      `Esta lista nombra scripts que ya no existen: ${inventados.join(', ')}.`,
    ).toEqual([]);
  });
});
