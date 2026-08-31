/**
 * El grafo de paquetes, escrito una vez y comparado con quien lo repite.
 *
 * La regla 6 de CLAUDE.md describió durante ocho versiones un grafo de cuatro
 * paquetes que el árbol ya no tenía: `sound-library` ni figuraba, y doce
 * imports reales la incumplían. No lo notó nadie porque la prosa no la
 * comprobaba nada — el linter sí hacía cumplir el grafo verdadero, pero era el
 * único que lo sabía. Este test cierra ese hueco: `package-graph.json` es la
 * fuente, y aquí se comprueba que CLAUDE.md, `docs/ARCHITECTURE.md` y los
 * exports reales de `core` siguen de acuerdo con ella.
 *
 * Lo que sí hacía originalmente: vigilar lo que un linter no puede ver —que
 * lo ESCRITO en tres sitios siga diciendo lo mismo—, no los imports del árbol
 * en sí. Eso último lo cubre `orbit/package-boundaries` en `npm run lint`.
 *
 * El bloque final (`el linter de fronteras cierra sus tres puertas
 * traseras`) es la excepción deliberada: monta un `Linter` de ESLint y le da
 * de comer fuentes sintéticas para comprobar que la REGLA MUERDE de verdad
 * en los tres agujeros que tapó la v3.10 (`require()`, `import()` dinámico y
 * el barril que cuela `node/`), y que un alias nuevo en `tsconfig.json` no
 * puede quedar sin vigilar en silencio. Un test de sincronía de documentos no
 * podía probar eso —lintea código, no prosa—, así que aquí se le hace sitio.
 *
 *   npx vitest run tools/eslint/package-graph.test.ts
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import babelParser from '@babel/eslint-parser';
import { describe, expect, it } from 'vitest';

import config from './package-graph.json';
import tsconfigJson from '../../tsconfig.json';
// `package-boundaries.js` es JS de ESLint sin `.d.ts` (no lo cubre ningún
// paquete de `@types`, y este repo no compila JS: `tsconfig.json` › `include`
// solo trae `.ts` de `tools/`). `tsc --noEmit` en estricto lo marca TS7016, y
// una `declare module` de aumento no vale para un módulo relativo que SÍ
// resuelve a un archivo real (TS2665). La forma del módulo es la de
// cualquier regla de ESLint: `export default { meta, create }`.
// @ts-expect-error — ver el porqué arriba.
import packageBoundaries from './package-boundaries.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function leer(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * Cómo se reconoce la lista canónica dentro de un `.md`.
 *
 * Un token es `` `nombre→dep,dep` `` sin espacios, y una LISTA es una tirada de
 * dos o más tokens seguidos separados por `·` o por comas. Así, mencionar una
 * arista suelta en prosa —«`ui→sound-library` son ocho sitios»— no cuenta como
 * declaración, que es justo lo que hace falta para poder explicar el grafo sin
 * romper el test. Y de las tiradas solo valen las que declaran `core`, que es
 * el ancla de la lista de verdad y no aparece en ningún ejemplo de prosa.
 */
function listasDeclaradas(markdown: string): Record<string, string[]>[] {
  const texto = markdown.replace(/\s+/g, ' ');
  const tirada = /`[a-z-]+→[^`]+`(?:\s*[,·]\s*`[a-z-]+→[^`]+`)+/g;
  const listas: Record<string, string[]>[] = [];

  for (const run of texto.match(tirada) ?? []) {
    const mapa: Record<string, string[]> = {};
    for (const [, nombre, deps] of run.matchAll(/`([a-z-]+)→([^`]+)`/g)) {
      mapa[nombre!] = deps === '∅' ? [] : deps!.split(',').sort();
    }
    if ('core' in mapa) listas.push(mapa);
  }
  return listas;
}

/**
 * El JSON, en el vocabulario de los documentos: solo `packages/*` y sin el
 * prefijo. Las apps son hojas y se explican en prosa, no en la lista.
 */
function grafoEsperado(): Record<string, string[]> {
  const corto = (u: string) => u.replace(/^packages\//, '');
  const out: Record<string, string[]> = {};
  for (const [unidad, deps] of Object.entries(config.graph)) {
    if (!unidad.startsWith('packages/')) continue;
    out[corto(unidad)] = deps.map(corto).sort();
  }
  return out;
}

describe('el grafo escrito coincide con el grafo declarado', () => {
  const esperado = grafoEsperado();

  for (const doc of ['CLAUDE.md', 'docs/ARCHITECTURE.md']) {
    it(`${doc} declara el mismo grafo que package-graph.json`, () => {
      const listas = listasDeclaradas(leer(doc));
      expect(
        listas.length,
        `${doc} no declara ninguna lista de dependencias reconocible (ver el comentario de este test)`,
      ).toBeGreaterThan(0);
      for (const lista of listas) expect(lista).toEqual(esperado);
    });
  }
});

describe('el grafo es un DAG por capas', () => {
  it('toda dependencia apunta a una unidad declarada', () => {
    const unidades = new Set(Object.keys(config.graph));
    for (const [unidad, deps] of Object.entries(config.graph)) {
      for (const dep of deps) {
        expect(unidades, `${unidad} depende de ${dep}, que no está en el grafo`).toContain(dep);
      }
    }
  });

  it('no hay ciclos: existe un orden topológico', () => {
    // Kahn. Si sobra alguna unidad al final, es que están en un ciclo — y un
    // ciclo aquí es el único fallo que la regla 6 nunca podría tolerar.
    const pendientes = new Map(Object.entries(config.graph).map(([u, d]) => [u, new Set(d)]));
    const orden: string[] = [];
    let avanzo = true;
    while (avanzo) {
      avanzo = false;
      for (const [unidad, deps] of pendientes) {
        if (deps.size > 0) continue;
        pendientes.delete(unidad);
        orden.push(unidad);
        for (const otras of pendientes.values()) otras.delete(unidad);
        avanzo = true;
      }
    }
    expect([...pendientes.keys()], 'estas unidades forman un ciclo').toEqual([]);
    expect(orden[0], 'la capa 0 tiene que ser core').toBe('packages/core');
  });
});

describe('la lista `modelOnly` sigue cubriendo el estado de core', () => {
  // `engine` puede usar el MODELO de `core` (tipos, constantes y funciones
  // puras de `model/`) pero no su ESTADO. Como `core` exporta todo por un
  // índice plano, la regla de ESLint solo puede vigilarlo por nombre, con una
  // lista. Una lista escrita a mano se queda corta en cuanto `core` crece: esto
  // la vuelve a derivar de los exports de verdad y falla si se desincroniza.
  const runtimeExports = (rel: string): string[] => {
    const src = leer(path.posix.join('packages/core/src', rel));
    const nombres: string[] = [];
    for (const [, nombre] of src.matchAll(
      /^export\s+(?:async\s+)?(?:class|function\s*\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      nombres.push(nombre!);
    }
    return nombres;
  };

  for (const [unidad, regla] of Object.entries(config.modelOnly)) {
    it(`${unidad}: la lista prohibida son exactamente los exports en runtime de ${regla.sources.join(', ')}`, () => {
      const reales = regla.sources.flatMap(runtimeExports).sort();
      expect(reales.length, 'no se leyó ningún export: ¿se movieron los archivos?').toBeGreaterThan(0);
      expect([...regla.deny].sort()).toEqual(reales);
    });
  }
});

describe('package.json declara al menos lo que su unidad importa de verdad', () => {
  // El cuarto sitio que describe el grafo, y también mentía: `packages/engine`
  // importaba `@orbit/core` sin declararlo, `sound-library` no declaraba ni
  // `core` ni `engine`, etc. — invisible porque npm workspaces iza todo a la
  // raíz y `tsconfig`/`vite` resuelven por `paths`: funciona por accidente de
  // la topología, no porque esté declarado. Esta es la cuarta comparación del
  // mismo patrón que las de arriba: no confía en una tabla escrita a mano (ni
  // la mía ni la de nadie), deriva "lo que importa de verdad" recorriendo el
  // código fuente de cada unidad.
  //
  // El assert es `⊇`, no igualdad: `apps/desktop` tiene permitidas en el
  // grafo `core`, `engine` y `sound-library` que hoy no usa directamente (le
  // llegan transitivamente por `ui`), y declararlas de más en una hoja del
  // grafo no es un fallo.

  const IGNORAR = new Set(['node_modules', 'dist', 'out', 'build', '.git', 'coverage']);

  // `ReturnType<typeof readdirSync>` resuelve al overload equivocado
  // (`Dirent<Buffer>[]`, no el `Dirent<string>[]` que de verdad devuelve la
  // llamada con `withFileTypes: true` y sin `encoding`); dejar que la
  // asignación infiera el tipo sola evita el choque.
  function leerDirEntries(abs: string) {
    try {
      return readdirSync(abs, { withFileTypes: true });
    } catch {
      return null;
    }
  }

  function listarFuentes(dir: string): string[] {
    const abs = path.join(ROOT, dir);
    const entradas = leerDirEntries(abs);
    if (!entradas) return [];
    const out: string[] = [];
    for (const entrada of entradas) {
      if (IGNORAR.has(entrada.name)) continue;
      const rel = path.posix.join(dir, entrada.name);
      if (entrada.isDirectory()) out.push(...listarFuentes(rel));
      else if (/\.tsx?$/.test(entrada.name)) out.push(rel);
    }
    return out;
  }

  // Reconoce un especificador SOLO en posición de import real —`from '...'`,
  // `import('...')`, `require('...')`— y no cualquier mención de `@orbit/` en
  // el archivo. Esa es la trampa: un grep ingenuo de `@orbit/` cuenta también
  // las menciones en comentarios (`packages/engine/src/compile.ts` explica en
  // prosa "Ver `model/groups.ts` en @orbit/core") y hay al menos un comentario
  // que además parece un import real —`packages/ui/src/collab/collab-state.ts`
  // dice en prosa "el renderer NO puede importar @orbit/server"—, que un grep
  // por `@orbit/` sin más contaría como dependencia cuando es exactamente lo
  // contrario: la razón por la que NO se importa.
  const ESPECIFICADOR =
    /\bfrom\s*(['"])(@orbit\/[a-z-]+)(?:\/[^'"]*)?\1|\b(?:import|require)\(\s*(['"])(@orbit\/[a-z-]+)(?:\/[^'"]*)?\3\s*\)/g;

  function importsReales(unidad: string, propioNombre: string): Set<string> {
    const nombres = new Set<string>();
    for (const archivo of listarFuentes(unidad)) {
      for (const m of leer(archivo).matchAll(ESPECIFICADOR)) {
        const spec = m[2] ?? m[4];
        // La auto-referencia (un paquete que se importa a sí mismo por su
        // propio alias) no es una dependencia externa.
        if (spec && spec !== propioNombre) nombres.add(spec);
      }
    }
    return nombres;
  }

  for (const unidad of Object.keys(config.graph)) {
    it(`${unidad}/package.json declara todo lo que ${unidad} importa de verdad`, () => {
      const pkg = JSON.parse(leer(path.posix.join(unidad, 'package.json')));
      const declarado = new Set(
        Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
          ...pkg.optionalDependencies,
        }),
      );
      const real = importsReales(unidad, pkg.name);
      // `packages/core` es la capa 0 del grafo (no puede depender de nada) y
      // legítimamente no tiene ningún import de `@orbit/*`: el resto de
      // unidades sí tiene al menos una arista permitida, así que si no se
      // detectó ningún import real ahí es señal de que el código fuente se
      // movió y el recorrido de archivos dejó de encontrarlo, no de que la
      // unidad esté limpia.
      if ((config.graph as Record<string, string[]>)[unidad]!.length > 0) {
        expect(real.size, `no se detectó ningún import de @orbit/* en ${unidad}: ¿se movió el código fuente?`).toBeGreaterThan(0);
      }
      for (const dep of real) {
        expect(declarado, `${unidad} importa ${dep} de verdad pero su package.json no lo declara`).toContain(dep);
      }
    });
  }
});

describe('el linter de fronteras cierra sus tres puertas traseras', () => {
  // Mismo parser que `eslint.config.js` (Babel, sin `@typescript-eslint`: ver
  // la cabecera de ese archivo para el porqué). Se reconstruye acá en vez de
  // importarlo porque `eslint.config.js` no es de los archivos que puede
  // tocar esta tarea, y de todos modos lo único que hace falta de él es este
  // parser — el resto de su configuración (React hooks, colores, etc.) no
  // pinta nada en una prueba de `orbit/package-boundaries`.
  const linter = new Linter();
  const lintConfig = [
    {
      files: ['**/*.ts'],
      languageOptions: {
        ecmaVersion: 'latest' as const,
        sourceType: 'module' as const,
        parser: babelParser,
        parserOptions: {
          requireConfigFile: false,
          babelOptions: {
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: ['typescript'] },
          },
        },
      },
      plugins: { orbit: { rules: { 'package-boundaries': packageBoundaries } } },
      rules: { 'orbit/package-boundaries': 'error' as const },
    },
  ];

  function idsOf(code: string, filename: string): (string | null | undefined)[] {
    return linter.verify(code, lintConfig, filename).map((m) => m.messageId);
  }

  // A — tools/eslint/package-boundaries.js no tenía listener de
  // `CallExpression`: un `require('@orbit/...')` cruzaba cualquier frontera
  // sin que la regla lo viera.
  it('A: require(\'@orbit/x\') no esquiva la frontera prohibida', () => {
    const ids = idsOf(
      "const mod = require('@orbit/ui');\nmodule.exports = mod;\n",
      'packages/engine/src/foo.ts',
    );
    expect(ids).toContain('forbidden');
  });

  it('A: un require(\'node:...\') legítimo (los tests de ui) sigue sin avisos', () => {
    const ids = idsOf(
      "const { parentPort } = require('node:worker_threads');\n",
      'packages/ui/test/foo.test.ts',
    );
    expect(ids).toEqual([]);
  });

  // B — el bucle de `node.specifiers` es un no-op para `ImportExpression`
  // (nunca tiene `.specifiers`): un `import()` dinámico se llevaba un nombre
  // de `modelOnly.deny` sin que la regla lo notara.
  it('B: import() desestructurado también respeta el deny de modelOnly', () => {
    const ids = idsOf(
      "async function f() {\n  const { ProjectStore } = await import('@orbit/core');\n  return ProjectStore;\n}\n",
      'packages/engine/src/foo.ts',
    );
    expect(ids).toContain('notModel');
  });

  it('B: (await import(...)).Nombre también respeta el deny de modelOnly', () => {
    const ids = idsOf(
      "async function f() {\n  return (await import('@orbit/core')).ProjectStore;\n}\n",
      'packages/engine/src/foo.ts',
    );
    expect(ids).toContain('notModel');
  });

  it('B: import() de un nombre permitido de core sigue sin avisos', () => {
    const ids = idsOf(
      "async function f() {\n  const { midiToHz } = await import('@orbit/core');\n  return midiToHz;\n}\n",
      'packages/engine/src/foo.ts',
    );
    expect(ids).toEqual([]);
  });

  it('B: la arista prohibida sigue vigilada para import() (no es solo modelOnly)', () => {
    const ids = idsOf(
      "async function f() {\n  return await import('@orbit/ui');\n}\n",
      'packages/engine/src/foo.ts',
    );
    expect(ids).toContain('forbidden');
  });

  // C — `BROWSER_ONLY.has(from) && isNodeSubpath(source)` solo miraba el
  // string del import del archivo linteado: un barril podía reexportar su
  // propia subruta `node/` bajo el alias base sin que ese string dijera
  // jamás "node/". Se cierra en el origen: el índice público de un paquete
  // del que depende un `browserOnly` no puede reexportar su lado `node/`.
  it('C: el índice de un paquete relevante para ui no puede reexportar su node/', () => {
    const ids = idsOf("export * from './node/ws-host';\n", 'packages/claude-bridge/src/index.ts');
    expect(ids).toContain('barrelNodeSubpath');
  });

  it('C: la forma directa (subruta node/ importada desde ui) sigue detectada', () => {
    const ids = idsOf(
      "import { startWsHost } from '@orbit/claude-bridge/node/ws-host';\n",
      'packages/ui/src/foo.ts',
    );
    expect(ids).toContain('nodeSubpath');
  });

  it('C: un import interno a node/ que NO es el índice público sigue sin avisos', () => {
    const ids = idsOf(
      "export { startWsHost } from './node/ws-host';\n",
      'packages/claude-bridge/src/executor.ts',
    );
    expect(ids).toEqual([]);
  });

  it('C: el índice real de claude-bridge, hoy, sigue limpio', () => {
    const real = leer('packages/claude-bridge/src/index.ts');
    expect(linter.verify(real, lintConfig, 'packages/claude-bridge/src/index.ts')).toEqual([]);
  });

  // D — nada comparaba `ALIASES` con `tsconfig.json` › `paths`: un alias
  // nuevo en uno sin su par en el otro dejaba ese import sin vigilar en
  // silencio. Se cerró derivando `ALIASES` de `tsconfig.json` en vez de
  // escribirlo dos veces (mismo criterio que ya usa `package-graph.json` para
  // el grafo), así que esta prueba no compara dos listas — ejercita la regla
  // de verdad contra CADA alias que declara tsconfig.json hoy: si alguno
  // quedara sin vigilar, `targetOf` devolvería `null` y saldrían 0 problemas
  // donde tiene que salir `forbidden`.
  it('D: cada alias base de tsconfig.json termina vigilado por la regla', () => {
    const paths = tsconfigJson.compilerOptions.paths as Record<string, string[]>;
    const aliasesBase = Object.keys(paths).filter((alias) => !alias.endsWith('/*'));
    expect(aliasesBase.length).toBeGreaterThan(0);

    for (const alias of aliasesBase) {
      if (alias === '@orbit/core') continue; // core no puede importarse a sí mismo.
      const ids = idsOf(`import x from '${alias}';\n`, 'packages/core/src/foo.ts');
      expect(ids, `${alias} no quedó vigilado (targetOf debería resolverlo, no devolver null)`).toContain(
        'forbidden',
      );
    }
  });

  // La exención de `import type` es a propósito (ver el comentario de
  // `package-boundaries.js` junto a `spec.importKind`) y no se tocó en esta
  // tarea; esto solo la deja fijada para que un cambio futuro en el bloque de
  // `modelOnly` (donde se sumó el soporte de `import()` dinámico) no la rompa
  // por accidente.
  it('sigue exento: import type { X } de un nombre denegado no avisa', () => {
    const ids = idsOf("import type { ProjectStore } from '@orbit/core';\n", 'packages/engine/src/foo.ts');
    expect(ids).toEqual([]);
  });
});
