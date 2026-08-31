/**
 * Leer código fuente dentro de un test sin que el final de línea del checkout
 * decida el resultado.
 *
 * Este repo prueba la lógica que vive dentro de un `.tsx` leyendo su TEXTO, en
 * vez de montar el componente con jsdom (la convención está en CLAUDE.md y la
 * estrena `drop-handlers-sync.test.ts`). El precio escondido de esa convención
 * es que el test pasa a depender de una decisión que no es del código: en
 * Windows, con el `core.autocrlf=true` que git trae de fábrica —el mismo que
 * usa el runner `windows-latest` de la CI—, el checkout escribe **CRLF**. Un
 * `toContain("  useInputGuardReason,\n  useInputMonitorStore,\n}")` pasa en
 * Linux y falla en Windows sin que nadie haya tocado una línea.
 *
 * No es hipotético: es lo que le pasó a `input-section-recording-guard.test.ts`
 * y lo que dejó la CI de Windows en rojo desde el commit `23af541` hasta la
 * v3.8.0 **incluida** —la release se cortó con la CI roja—, mientras ubuntu
 * seguía verde en las mismas corridas.
 *
 * **Por qué acá y no con un `.gitattributes` que fuerce `eol=lf`.** Son dos
 * problemas distintos que se parecen. El final de línea del árbol de trabajo es
 * del entorno de cada uno; lo que estos tests afirman es el CONTENIDO del
 * código, y un salto de línea de dos bytes en vez de uno no cambia ese
 * contenido. Normalizar al leer los vuelve ciertos con **cualquier** checkout
 * —incluido el de quien clone con la configuración por defecto de Windows y no
 * sepa que existe un `.gitattributes`—; forzar `eol=lf` los volvería ciertos
 * solo mientras ese archivo siga ahí y nadie edite con una herramienta que
 * reescriba los finales. El segundo arreglo, además, reescribe el árbol entero
 * de todo el mundo para tapar un problema de once archivos de test.
 *
 * **El índice está limpio, y eso refuerza la decisión.** `git ls-files --eol`
 * dice 584 archivos de texto, TODOS `i/lf`, y cero `i/crlf`: el repo no tiene
 * mezcla de finales de línea, la mezcla la fabrica el checkout. (Cuidado con
 * medirlo mal: un `git grep -Il $'
'` contesta 584 sobre 584, porque mira el
 * árbol de trabajo, que con `core.autocrlf=true` ya está convertido — es una
 * medida del `git config` de quien la corre, no del repositorio.) O sea que un
 * `.gitattributes` con `eol=lf` no arreglaría nada que no arregle esto: no hay
 * nada que renormalizar, solo hay tests que afirman sobre bytes que el checkout
 * decide.
 *
 * Regla para el próximo test que lea fuente: **entrá por acá**, no por
 * `readFileSync` directo. Si hace falta leer algo que no está bajo
 * `packages/ui/src`, está `readText`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

/**
 * CRLF y CR sueltos a `\n`. Nada más: no toca sangrías, ni espacios al final
 * de línea, ni el resto del texto, porque eso SÍ es contenido y un test que lo
 * afirme tiene que seguir pudiendo fallar.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Un archivo cualquiera, por ruta absoluta, con los finales normalizados. */
export function readText(absPath: string): string {
  return normalizeEol(readFileSync(absPath, 'utf8'));
}

/**
 * Un archivo de `packages/ui/src`, por ruta relativa a esa carpeta:
 * `readSource('editors/playlist/Playlist.tsx')`.
 */
export function readSource(relToSrc: string): string {
  return readText(resolve(SRC, relToSrc));
}
