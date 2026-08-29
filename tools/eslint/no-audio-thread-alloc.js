/**
 * `orbit/no-audio-thread-alloc` — la regla 2 de CLAUDE.md, en código.
 *
 *   «Cero alocaciones en el audio thread. En packages/engine/worklet no se
 *    crea ningún objeto/array dentro de process(); buffers preasignados.»
 *
 * Una alocación en el hilo de audio no rompe un test: hace que el GC pare el
 * hilo en el peor momento y el usuario oiga un chasquido cada tantos minutos.
 * Es de las cosas más caras de encontrar después y de las más fáciles de meter
 * sin querer (`const [a, b] = …`, un `.map()`, un objeto de opciones).
 *
 * Qué mira, y qué NO:
 *
 * - Parte de los puntos de entrada del hilo de audio (`process` por defecto,
 *   configurable) y sigue el grafo de llamadas **dentro del mismo archivo**:
 *   `this.mixDown(…)` y `mixDown(…)` se siguen; `this.core.process(…)` no se
 *   puede seguir porque vive en otro módulo — por eso la regla se enciende
 *   sobre TODOS los archivos del camino de audio (ver eslint.config.js), cada
 *   uno con su propio `process` como entrada.
 * - Los inicializadores de campo y el constructor quedan fuera a propósito:
 *   ahí es donde se preasignan los buffers, que es justo lo que la regla pide.
 *
 * Cuando una alocación es inevitable de verdad (el `postMessage` de medidores
 * del worklet: el puerto serializa igual), se apaga con un
 * `// eslint-disable-next-line orbit/no-audio-thread-alloc` **con el porqué al
 * lado**. Que haya que escribir esa línea es el objetivo: la deja a la vista.
 */

/** Métodos que devuelven un array/objeto/cadena nuevos. */
const ALLOCATING_METHODS = new Set([
  'map',
  'filter',
  'slice',
  'concat',
  'flat',
  'flatMap',
  'split',
  'join',
  'from',
  'fromEntries',
  'keys',
  'values',
  'entries',
  'assign',
  'parse',
  'stringify',
  'structuredClone',
  'subarray',
  'toSorted',
  'toReversed',
  'toSpliced',
  'with',
]);

function nameOfKey(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Cero alocaciones dentro de process() y de lo que llama (regla 2 de CLAUDE.md).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          entries: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      alloc:
        'Alocación en el hilo de audio ({{what}}) dentro de `{{fn}}`: regla 2 de CLAUDE.md — preasigna el buffer en el constructor.',
    },
  },

  create(context) {
    const entries = new Set(context.options[0]?.entries ?? ['process']);

    /** nombre → nodo de función, para poder seguir las llamadas. */
    const byName = new Map();
    /** nodo de función → nombre con el que lo llamamos en el mensaje. */
    const labels = new Map();
    /** nodo de función → Set de nombres que llama. */
    const calls = new Map();
    /** nodo de función → funciones definidas dentro de ella. */
    const nested = new Map();
    /** Puntos de entrada del hilo de audio encontrados en este archivo. */
    const roots = [];
    /** Pila de funciones que estamos recorriendo. */
    const stack = [];

    function enter(node, name) {
      if (name) {
        byName.set(name, node);
        labels.set(node, name);
        if (entries.has(name)) roots.push(node);
      }
      calls.set(node, new Set());
      nested.set(node, new Set());
      const outer = stack[stack.length - 1];
      if (outer) nested.get(outer).add(node);
      stack.push(node);
    }

    function current() {
      return stack[stack.length - 1];
    }

    /** Alocaciones vistas, para decidir al final si están en camino caliente. */
    const found = [];

    function note(node, what) {
      const fn = current();
      if (fn) found.push({ node, what, fn });
    }

    function calleeName(node) {
      const c = node.callee;
      if (!c) return null;
      if (c.type === 'Identifier') return c.name;
      if (c.type === 'MemberExpression' && !c.computed && c.object?.type === 'ThisExpression') {
        return nameOfKey(c.property);
      }
      return null;
    }

    function onFunctionEnter(node) {
      // El nombre se resuelve desde el padre: método de clase, declaración,
      // o `const f = () => …`.
      const p = node.parent;
      let name = null;
      if (node.type === 'FunctionDeclaration') name = node.id?.name ?? null;
      else if (p?.type === 'MethodDefinition' || p?.type === 'Property') name = nameOfKey(p.key);
      else if (p?.type === 'PropertyDefinition') name = nameOfKey(p.key);
      else if (p?.type === 'VariableDeclarator' && p.id?.type === 'Identifier') name = p.id.name;

      // Un método `constructor` nunca es camino caliente aunque se llame así.
      if (p?.type === 'MethodDefinition' && p.kind === 'constructor') name = null;

      // Crear un cierre dentro del camino caliente ES una alocación.
      if (stack.length > 0) note(node, 'closure');

      enter(node, name);
    }

    function onFunctionExit() {
      stack.pop();
    }

    return {
      ':function': onFunctionEnter,
      ':function:exit': onFunctionExit,

      CallExpression(node) {
        const fn = current();
        if (fn) {
          const n = calleeName(node);
          if (n) calls.get(fn).add(n);
        }
        const c = node.callee;
        if (c?.type === 'MemberExpression' && !c.computed) {
          const prop = nameOfKey(c.property);
          if (prop && ALLOCATING_METHODS.has(prop)) note(node, `.${prop}()`);
        }
      },

      NewExpression: (node) => note(node, `new ${node.callee?.name ?? ''}`.trim()),
      ArrayExpression: (node) => note(node, 'array literal'),
      ObjectExpression: (node) => note(node, 'object literal'),
      SpreadElement: (node) => note(node, 'spread'),

      'Program:exit'() {
        if (roots.length === 0) return;

        // Alcanzables: los puntos de entrada y todo lo que llaman, en cadena.
        const hot = new Set();
        const queue = [...roots];
        while (queue.length) {
          const fn = queue.pop();
          if (hot.has(fn)) continue;
          hot.add(fn);
          for (const name of calls.get(fn) ?? []) {
            const next = byName.get(name);
            if (next && !hot.has(next)) queue.push(next);
          }
          // Un cierre definido dentro también corre en el hilo de audio.
          for (const next of nested.get(fn) ?? []) {
            if (!hot.has(next)) queue.push(next);
          }
        }

        for (const { node, what, fn } of found) {
          if (!hot.has(fn)) continue;
          context.report({
            node,
            messageId: 'alloc',
            data: { what, fn: labels.get(fn) ?? 'función anónima' },
          });
        }
      },
    };
  },
};
