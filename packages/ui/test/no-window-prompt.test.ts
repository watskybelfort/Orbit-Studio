import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readText } from './read-source';

/**
 * `window.prompt` no existe en Electron 43: lanza «prompt() is not supported».
 * Cada sitio que lo llamaba era una acción que moría en silencio —guardar una
 * plantilla, renombrar un patrón, renombrar una sección, guardar un layout—.
 *
 * Este test es el candado del BARRIDO, no de un sitio: recorre todo
 * `packages/ui/src` y falla si alguien vuelve a escribir una llamada. No
 * prohíbe la palabra (los comentarios que explican el porqué la nombran); sí
 * la invocación, `window.prompt(`.
 *
 * Se lee el texto con `readText` (finales de línea normalizados) como el resto
 * de los tests de fuente del repo; ver `read-source.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');
const SOURCE_FILE = /\.(ts|tsx)$/;

/** Todos los `.ts`/`.tsx` de `src`, recursivo y en orden estable. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (SOURCE_FILE.test(entry.name)) out.push(full);
  }
  return out;
}

/** `window.prompt(` con cualquier espacio entre el nombre y el paréntesis. */
const PROMPT_CALL = /window\.prompt\s*\(/;

describe('nada llama a window.prompt', () => {
  it('ningún archivo de packages/ui/src invoca window.prompt', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => PROMPT_CALL.test(readText(file)))
      .map((file) => file.slice(SRC.length + 1).replaceAll('\\', '/'));
    expect(offenders).toEqual([]);
  });

  it('las cuatro superficies que lo usaban pasan por el diálogo del shell', () => {
    // Las cinco llamadas (dos en el menú) viven en cuatro archivos y las cerró
    // el mismo barrido. Si alguien borra la llamada en vez de convertirla, la
    // acción desaparece sin ruido: esto la sujeta.
    const sites = [
      'shell/MenuBar.tsx',
      'browser/Browser.tsx',
      'palette/default-commands.ts',
      'editors/playlist/SectionLane.tsx',
    ] as const;
    for (const site of sites) {
      expect(readText(join(SRC, site)), site).toContain('askName(');
    }
  });
});
