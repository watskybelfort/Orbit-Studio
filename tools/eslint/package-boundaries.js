/**
 * `orbit/package-boundaries` — la regla 6 de CLAUDE.md, en código.
 *
 * El grafo NO se escribe aquí: vive en `package-graph.json`, al lado, para que
 * lo lean a la vez esta regla y `package-graph.test.ts` —el test que comprueba
 * que CLAUDE.md y `docs/ARCHITECTURE.md` siguen diciendo lo mismo que el JSON—.
 * Ese reparto es deliberado y es la lección de la v3.8: la regla 6 llevaba
 * meses describiendo un grafo de cuatro paquetes que el árbol ya no tenía (ni
 * `sound-library` aparecía), y nadie se enteró porque nada comparaba la prosa
 * con la realidad. Ahora hay UNA fuente y dos lectores.
 *
 * La regla vigila tres cosas:
 *
 * 1. **El grafo.** `graph` del JSON, un DAG por capas: si un paquete solo puede
 *    importar paquetes de capa estrictamente menor, no hay ciclo posible.
 *    Añadir una arista hacia arriba —el `core → ui` de la prueba— falla aquí
 *    antes de llegar a `tsc`, que lo aceptaría encantado.
 *
 *    Y vigila las DOS formas de cruzar la frontera, no solo la evidente:
 *      a. `import … from '@orbit/otro'` — el alias del workspace.
 *      b. `import … from '../../otro/src/x'` — el relativo que se sale del
 *         paquete. Este es el que se cuela en una revisión humana, porque a
 *         simple vista parece un import interno; sin esto, bastaría con
 *         escribir la ruta a mano para saltarse la regla entera.
 *
 * 2. **El renderer no se trae Node** (`browserOnly`). `packages/ui` se empaqueta
 *    para el navegador, así que no puede importar una subruta `node/` de otro
 *    paquete aunque la ARISTA esté permitida. Es un agujero real y no teórico:
 *    `ui → claude-bridge` es legal y necesario (el `ToolExecutor` corre en el
 *    renderer, contra el `ProjectStore` vivo), pero
 *    `@orbit/claude-bridge/node/ws-host` arrastraría `ws` y `node:http` al
 *    bundle. Por eso ese paquete parte su índice: la raíz es browser-safe y lo
 *    de Node se pide por subruta desde `apps/desktop`. Lo mismo dice a mano
 *    `packages/ui/src/collab/collab-state.ts` sobre `@orbit/server`; aquí deja
 *    de ser un comentario y pasa a ser una regla.
 *
 * 3. **El motor compila el proyecto, no lo edita** (`modelOnly`). La regla 6
 *    decía `engine→core (tipos)` y era falso desde el primer compilador:
 *    `compile.ts` importa una docena de funciones puras de `core` y
 *    `dsp/voices.ts` importa `DRUM_MAP`/`midiToHz`. Lo que sí se sostiene —y es
 *    lo que aquel `(tipos)` quería decir— es que de `core` se usa el MODELO,
 *    nunca el `ProjectStore`, el bus de comandos ni el historial. Como `core`
 *    exporta todo por un índice plano, no se puede vigilar por ruta: se vigila
 *    por nombre, con la lista `deny` del JSON, que `package-graph.test.ts`
 *    mantiene sincronizada con los exports reales de `store.ts`, `commands.ts`
 *    e `history-tree.ts`.
 *
 * Lo que NO hace: pedir que un relativo permitido se reescriba como alias.
 * `sound-library` importa `../../engine/src/render/offline`, que no sale por
 * el `index.ts` de `@orbit/engine`, y `@orbit/engine/render/offline` no
 * resuelve en ejecución (el subcamino del alias apunta a `src/`, no a la raíz
 * del paquete). La arista está permitida; cómo se escriba es estilo, y esta
 * regla no es de estilo.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG = JSON.parse(readFileSync(new URL('./package-graph.json', import.meta.url), 'utf8'));

/** Quién puede importar a quién. Ver `package-graph.json` y ARCHITECTURE.md. */
const GRAPH = CONFIG.graph;
/** Unidades que se empaquetan para el navegador: nada de subrutas `node/`. */
const BROWSER_ONLY = new Set(CONFIG.browserOnly);
/** `unidad → { target, deny }`: qué nombres NO puede traerse de `target`. */
const MODEL_ONLY = CONFIG.modelOnly;

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

/** ¿El especificador entra en el lado Node de otro paquete? */
function isNodeSubpath(source) {
  return /(?:^|\/)node\//.test(source);
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
      unknown: '`{{from}}` no está en el mapa de dependencias de tools/eslint/package-graph.json.',
      nodeSubpath:
        '`{{from}}` se empaqueta para el navegador y no puede importar `{{source}}`: el lado `node/` arrastra `ws`/`node:http` al bundle. Eso se importa desde `apps/desktop`.',
      notModel:
        '`{{from}}` usa de `{{to}}` el modelo, no el estado: `{{name}}` es del store / bus de comandos / historial. El motor compila el proyecto, no lo edita (regla 6 de CLAUDE.md).',
    },
  },

  create(context) {
    const filePosix = toPosix(path.relative(context.cwd, context.filename));
    const from = unitOf(`${filePosix}`);
    // tools/, scripts sueltos y la raíz no tienen fronteras que vigilar.
    if (!from) return {};

    const allowed = GRAPH[from];
    // Los tests SÍ cruzan a `core` con el bus de comandos: montan el proyecto
    // de prueba con `applyCommand` y luego lo compilan. Eso es conducir el
    // modelo desde fuera, no que el motor dependa del store. El grafo de
    // paquetes, en cambio, se les aplica igual que al resto.
    const isTest = /(?:^|\/)test\//.test(filePosix) || /\.test\.[cm]?[jt]sx?$/.test(filePosix);
    const modelOnly = isTest ? undefined : MODEL_ONLY[from];

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
        return;
      }
      if (BROWSER_ONLY.has(from) && isNodeSubpath(source)) {
        context.report({ node, messageId: 'nodeSubpath', data: { from, source } });
        return;
      }
      if (modelOnly && to === modelOnly.target) {
        for (const spec of node.specifiers ?? []) {
          // Solo los nombrados en runtime: `import type { HistoryView }` es
          // una anotación, no una dependencia.
          if (spec.type !== 'ImportSpecifier') continue;
          if (spec.importKind === 'type' || node.importKind === 'type') continue;
          const name = spec.imported?.name;
          if (name && modelOnly.deny.includes(name)) {
            context.report({ node: spec, messageId: 'notModel', data: { from, to, name } });
          }
        }
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
