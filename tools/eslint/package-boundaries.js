/**
 * `orbit/package-boundaries` — la regla 6 de CLAUDE.md, en código.
 *
 *   ui→core,engine,collab · collab→core · engine→core · claude-bridge→core
 *   Nada circular.
 *
 * Vigila las DOS formas de cruzar la frontera, no solo la evidente:
 *
 *   1. `import … from '@orbit/otro'` — el alias del workspace.
 *   2. `import … from '../../otro/src/x'` — el relativo que se sale del
 *      paquete. Este es el que se cuela en una revisión humana, porque a
 *      simple vista parece un import interno; sin esto, bastaría con escribir
 *      la ruta a mano para saltarse la regla entera.
 *
 * Lo que NO hace: pedir que un relativo permitido se reescriba como alias.
 * `sound-library` importa `../../engine/src/render/offline`, que no sale por
 * el `index.ts` de `@orbit/engine`, y `@orbit/engine/render/offline` no
 * resuelve en ejecución (el subcamino del alias apunta a `src/`, no a la raíz
 * del paquete). La arista está permitida; cómo se escriba es estilo, y esta
 * regla no es de estilo.
 *
 * El grafo se declara entero abajo (`GRAPH`) y es un DAG por capas: si un
 * paquete solo puede importar paquetes de capa estrictamente menor, no hay
 * ciclo posible. Añadir una arista hacia arriba —el `core → ui` de la prueba—
 * falla aquí antes de llegar a `tsc`, que lo aceptaría encantado.
 */

import path from 'node:path';

/**
 * Quién puede importar a quién. Es el mapa de CLAUDE.md **más lo que el árbol
 * ya hace de verdad**: `sound-library` no aparece en CLAUDE.md (es posterior)
 * y `claude-bridge` importa `engine` y `sound-library` además de `core`.
 * Se escribe la realidad, porque una regla que no pasa sobre el árbol tal cual
 * está no la enciende nadie. Sigue siendo un DAG estricto:
 *
 *   core ← engine ← sound-library ← claude-bridge ← ui
 *   core ← collab ← ui
 */
const GRAPH = {
  'packages/core': [],
  'packages/engine': ['packages/core'],
  'packages/collab': ['packages/core'],
  'packages/sound-library': ['packages/core', 'packages/engine'],
  'packages/claude-bridge': ['packages/core', 'packages/engine', 'packages/sound-library'],
  'packages/ui': [
    'packages/core',
    'packages/engine',
    'packages/collab',
    'packages/claude-bridge',
    'packages/sound-library',
  ],
  // Las apps son las hojas: montan los paquetes, nadie las importa.
  // El main del escritorio levanta ADEMÁS el servidor de colaboración dentro
  // del propio proceso (abrir sala desde la app, sin lanzar nada aparte), y
  // por eso —y solo por eso— `apps/desktop` puede importar `apps/server`.
  'apps/desktop': [
    'packages/core',
    'packages/engine',
    'packages/collab',
    'packages/claude-bridge',
    'packages/sound-library',
    'packages/ui',
    'apps/server',
  ],
  'apps/server': ['packages/core', 'packages/collab'],
};

/** Alias del workspace → carpeta del paquete. */
const ALIASES = {
  '@orbit/core': 'packages/core',
  '@orbit/engine': 'packages/engine',
  '@orbit/collab': 'packages/collab',
  '@orbit/ui': 'packages/ui',
  '@orbit/claude-bridge': 'packages/claude-bridge',
  '@orbit/sound-library': 'packages/sound-library',
  '@orbit/server': 'apps/server',
  '@orbit/desktop': 'apps/desktop',
};

/** `packages/ui/src/App.tsx` → `packages/ui`. `tools/x.ts` → null (libre). */
function unitOf(posixPath) {
  const m = /(?:^|\/)((?:packages|apps)\/[a-z0-9-]+)\//.exec(posixPath);
  return m ? m[1] : null;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** El paquete al que apunta un especificador, o null si no cruza frontera. */
function targetOf(source, fromFilePosix) {
  for (const [alias, unit] of Object.entries(ALIASES)) {
    if (source === alias || source.startsWith(`${alias}/`)) return unit;
  }
  if (source.startsWith('.')) {
    const resolved = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFilePosix), source)));
    return unitOf(`${resolved}/`);
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Las dependencias entre paquetes van en un solo sentido (regla 6 de CLAUDE.md). Nada circular.',
    },
    schema: [],
    messages: {
      forbidden:
        '`{{from}}` no puede importar `{{to}}` (regla 6 de CLAUDE.md). Permitido desde `{{from}}`: {{allowed}}.',
      unknown: '`{{from}}` no está en el mapa de dependencias de tools/eslint/package-boundaries.js.',
    },
  },

  create(context) {
    const filePosix = toPosix(path.relative(context.cwd, context.filename));
    const from = unitOf(`${filePosix}`);
    // tools/, scripts sueltos y la raíz no tienen fronteras que vigilar.
    if (!from) return {};

    const allowed = GRAPH[from];

    function check(node, source) {
      if (typeof source !== 'string' || source === '') return;
      const to = targetOf(source, filePosix);
      if (to === null || to === from) return;

      if (!allowed) {
        context.report({ node, messageId: 'unknown', data: { from } });
        return;
      }
      if (!allowed.includes(to)) {
        context.report({
          node,
          messageId: 'forbidden',
          data: { from, to, allowed: allowed.length ? allowed.join(', ') : 'nada (es la base)' },
        });
      }
    }

    return {
      ImportDeclaration: (node) => check(node, node.source?.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source?.value),
      ImportExpression: (node) =>
        node.source?.type === 'Literal' && check(node, node.source.value),
    };
  },
};
