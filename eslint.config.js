/**
 * ESLint plano de Orbit Studio.
 *
 * Esto NO es un linter de estilo. El estilo del repo ya se lee bien y no hay
 * Prettier a propósito (reformatear 73k líneas ensucia el `git blame`). Lo que
 * hay aquí es la RED que vigila las reglas duras de CLAUDE.md, que son las que
 * un tipo no ve al revisar:
 *
 *   regla 2 → orbit/no-audio-thread-alloc  (cero alocaciones en el hilo de audio)
 *   regla 4 → orbit/no-hardcoded-colors    (los colores, en el tema)
 *   regla 6 → orbit/package-boundaries     (las fronteras entre paquetes)
 *
 * La 6 no se configura aquí: el grafo vive en `tools/eslint/package-graph.json`
 * porque lo leen dos —la regla y `tools/eslint/package-graph.test.ts`, que
 * comprueba que CLAUDE.md y docs/ARCHITECTURE.md sigan diciendo lo mismo—. Si
 * hay que abrir o cerrar una arista, se toca ese JSON y nada más.
 *
 * Encima de eso, el conjunto recomendado de ESLint: errores de verdad (un
 * `case` sin `break`, una clase con dos métodos iguales, un `await` dentro de
 * un `new Promise`), no gustos.
 *
 * ── Por qué el parser es el de Babel y no @typescript-eslint ──────────────
 *
 * El repo compila con `typescript@7`, que es el compilador nativo en Go: su
 * paquete de npm ya NO exporta la API de JavaScript (`import ts from
 * 'typescript'` devuelve `{ version }` y nada más). `@typescript-eslint/parser`
 * la necesita entera, declara `typescript >=4.8.4 <6.1.0` como peer y falla al
 * instalar; forzándolo, revienta al arrancar. No hay versión suya con soporte
 * de TS 7 hoy (comprobado en `latest` y en `canary`).
 *
 * `@babel/eslint-parser` parsea TypeScript y TSX sin tocar el paquete
 * `typescript` (usa `@babel/parser`, que trae su propia gramática de TS), que
 * es justo lo que hace falta: las tres reglas de arriba son sintácticas y no
 * necesitan tipos. La contrapartida es
 * que no hay reglas con información de tipos — pero de eso ya se encarga
 * `npm run typecheck`, que corre `tsc --noEmit` en estricto sobre todo el
 * árbol y es más fiable que cualquier regla de lint con tipos.
 */

import js from '@eslint/js';
import babelParser from '@babel/eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';
import orbit from './tools/eslint/index.js';

/**
 * Globales de Node para los `.js`/`.mjs` del repo (las herramientas de
 * `tools/` y este propio plugin). Se escriben a mano en vez de traer el
 * paquete `globals`: son doce nombres, y una dependencia menos es una
 * dependencia menos.
 */
const NODE_GLOBALS = Object.fromEntries(
  [
    'process',
    'console',
    'Buffer',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'performance',
    'fetch',
    'structuredClone',
    'queueMicrotask',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    '__dirname',
    '__filename',
    'require',
    'module',
    'exports',
  ].map((name) => [name, 'readonly']),
);

/**
 * Solo parseo: con `babelrc: false` + `configFile: false`, el parser de Babel
 * no busca ninguna configuración y llama a `@babel/parser` directamente con
 * los plugins de sintaxis que se le den. Por eso no hace falta
 * `@babel/preset-typescript` (los presets son de transformación, y aquí no se
 * transforma nada): basta con pedir el plugin `typescript`, y `jsx` además en
 * los `.tsx`.
 */
const tsLanguage = (isTSX) => ({
  ecmaVersion: 'latest',
  sourceType: 'module',
  parser: babelParser,
  parserOptions: {
    requireConfigFile: false,
    babelOptions: {
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: isTSX ? ['typescript', 'jsx'] : ['typescript'] },
    },
  },
});

export default [
  {
    /*
     * Las directivas sin usar no se avisan, y es consecuencia directa del
     * namespace vacío de `@typescript-eslint` (más abajo): sus dos reglas no
     * reportan nunca, así que los seis `eslint-disable` que ya traía el código
     * SIEMPRE salen como "sin usar". Avisarlos sería pedir que se borre
     * documentación correcta.
     *
     * El precio es real y conviene tenerlo escrito: un `eslint-disable` que
     * sobre en cualquier otra regla tampoco se va a avisar. Con seis
     * directivas en todo el repo el cambio sale a favor; si algún día se
     * multiplican, o si el parser de `@typescript-eslint` se vuelve viable,
     * esto se vuelve a encender.
     */
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/build/**',
      '**/.vite/**',
      '**/coverage/**',
      'apps/desktop/dist/**',
      // Ficheros de declaración: son solo tipos y el parser de Babel los ve
      // como un módulo lleno de `declare`, sin nada que un linter sintáctico
      // pueda decir. Los vigila `tsc`.
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts', '**/*.mts', '**/*.cts'],
    languageOptions: tsLanguage(false),
  },
  {
    files: ['**/*.tsx'],
    languageOptions: tsLanguage(true),
  },

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs'],
    plugins: {
      orbit,
      /*
       * Un namespace VACÍO para `@typescript-eslint`, y no es un capricho.
       *
       * El código ya traía comentarios `eslint-disable-next-line
       * @typescript-eslint/no-explicit-any` (y `no-base-to-string`) escritos
       * cuando en el repo NO había linter: eran una intención, no una
       * supresión. Ahora que sí lo hay, ESLint 10 trata un disable de una
       * regla desconocida como ERROR, así que esos seis comentarios —que
       * documentan algo real y que hay que conservar— tumbarían `npm run
       * lint`.
       *
       * Las reglas de verdad no se pueden activar: piden el parser de
       * `@typescript-eslint`, que necesita la API completa del compilador y
       * aquí `typescript@7` es el nativo en Go, que solo expone `{ version }`
       * (ver la cabecera de este archivo). Declarándolas vacías, los
       * comentarios siguen siendo válidos y siguen diciendo lo que dicen; el
       * día que el parser sea viable, se sustituye este bloque por el plugin
       * de verdad y esos seis sitios ya están marcados.
       */
      '@typescript-eslint': {
        rules: {
          'no-explicit-any': { create: () => ({}) },
          'no-base-to-string': { create: () => ({}) },
        },
      },
    },
    rules: {
      // ── Reglas duras de CLAUDE.md ──────────────────────────────────────
      'orbit/package-boundaries': 'error',

      // ── Añadidos que sí valen y no dependen de tipos ───────────────────
      'no-var': 'error',

      /*
       * ── Las dos que se apagan, y por qué ──────────────────────────────
       *
       * No es tibieza: las dos se probaron encendidas sobre el árbol entero y
       * las quince veces que dispararon fueron sobre código correcto. Un
       * linter que avisa de lo que está bien deja de leerse, y entonces
       * tampoco avisa de lo que está mal.
       *
       * `no-useless-assignment` marca el inicializador de patrones que aquí
       * son idiomáticos y hacen legible el código: `let velocity: number |
       * null = null` antes de una cadena de `if` que lo asigna en todas las
       * ramas (executor.ts), o `let reverted = false` antes de un try/finally
       * (command-log.ts). Y en el encoder Opus marca asignaciones que están
       * ahí porque están en la implementación de referencia de la RFC 6716:
       * apartarse de ella para contentar a un linter es cambiar la única cosa
       * que hace auditable ese código.
       *
       * `no-unmodified-loop-condition` no ve las mutaciones que ocurren FUERA
       * del cuerpo del bucle, que es exactamente el patrón de esta app:
       * `latency-calibration.ts` espera con `while (collected < total && ...)`
       * mientras `collected` lo incrementa el callback de audio, y además hay
       * un `deadline` que corta. La regla lo lee como bucle infinito y no lo
       * es.
       *
       * Lo que SÍ encontraron mientras estuvieron encendidas está arreglado:
       * una ruta de test corrupta (`'C:\\fake\\...'` en comillas simples, donde
       * `\\f` es un salto de página) y un `throw` sin `cause`.
       */
      'no-useless-assignment': 'off',
      'no-unmodified-loop-condition': 'off',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-throw-literal': 'error',
      'no-return-assign': ['error', 'except-parens'],
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // ── Lo que se apaga en TypeScript, y por qué ─────────────────────────────
  //
  // Las tres son la MISMA causa: el parser de Babel no sabe de tipos, así que
  // no puede distinguir un nombre de tipo de un identificador. Quien sí lo
  // hace es `tsc --noEmit` en estricto, que corre en el mismo CI dos pasos
  // antes que el lint. No son reglas «molestas»: son reglas que aquí no
  // pueden acertar, y siguen encendidas en los `.js` de verdad (más abajo).
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    rules: {
      // `function f(x: Track)` → «Track is not defined».
      'no-undef': 'off',
      // `import type { Track }` usado solo en anotaciones → «no usado».
      'no-unused-vars': 'off',
      // Las sobrecargas de TypeScript son dos declaraciones del mismo nombre.
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',
    },
  },

  // ── Regla 2: el hilo de audio ────────────────────────────────────────────
  //
  // El worklet es la entrada, pero el trabajo por muestra lo hace `dsp/`:
  // `process()` del worklet delega en `KernelCore.process`, y ese delega en
  // las voces, los filtros, los envolventes y los efectos. La regla no cruza
  // archivos, así que se enciende sobre las dos puntas del camino y en cada
  // archivo arranca por sus propias entradas.
  //
  // `kernel-core.ts` queda FUERA, y no por comodidad: su `process()` aplica el
  // proyecto encolado entre bloques (`applyQueued` → `setSnapshot`), que aloca
  // a propósito — lo dice la cabecera del propio archivo («setSnapshot()/
  // mensajes, que corren entre bloques»). Encender la regla ahí serían ~60
  // avisos que solo se pueden callar uno a uno, y un linter con sesenta
  // silencios no vigila nada. Lo que protege ese archivo hoy es el test que ya
  // existe (`packages/engine/test/input-routing-v1.test.ts`), que sustituye
  // `globalThis.Float32Array` por una subclase que cuenta y exige 0 en 32
  // bloques: eso mide el camino ENTERO en ejecución, cruzando módulos, que es
  // justo lo que un linter no puede hacer. Las dos piezas se complementan.
  {
    files: ['packages/engine/src/worklet/**/*.ts', 'packages/engine/src/dsp/**/*.ts'],
    rules: {
      'orbit/no-audio-thread-alloc': [
        'error',
        // Los puntos por donde entra una muestra o un bloque: `process` (el
        // worklet y cada efecto), `render` (rellenar un bloque de voz),
        // `tick` (el paso de muestra de envolventes y osciladores),
        // `read`/`write` (la línea de retardo) y `forward`/`inverse` (la FFT
        // del convolutor). Son 50 y pico entradas repartidas por `dsp/`.
        { entries: ['process', 'render', 'tick', 'read', 'write', 'forward', 'inverse'] },
      ],
    },
  },

  // ── React: las reglas de los hooks ───────────────────────────────────────
  //
  // La única regla de catálogo que se trae de fuera, y se trae por dos motivos
  // concretos: (a) llamar a un hook dentro de un `if` o después de un `return`
  // temprano compila perfectamente y revienta en ejecución —`tsc` no lo ve, y
  // es de los fallos que aparecen solo en una rama del componente—, y (b) el
  // árbol YA lleva comentarios `// eslint-disable-next-line
  // react-hooks/exhaustive-deps` escritos a mano, así que la regla se esperaba
  // aquí desde antes de que existiera este archivo.
  //
  // `exhaustive-deps` entró como AVISO mientras se revisaban a mano los once
  // que trajo la v3.5: acierta mucho pero no siempre, y un CI en rojo por una
  // dependencia que a propósito no está en la lista acaba con alguien
  // apagando la regla entera. Con los once ya resueltos (arreglados los que
  // faltaban de verdad, silenciados con el motivo escrito los deliberados —
  // ver PianoRoll.tsx, Playlist.tsx, HistoryPanel.tsx, HistoryBranches.tsx,
  // Browser.tsx) pasa a ERROR: lo que se cuela nuevo sin un
  // `eslint-disable-next-line` razonado ahora rompe el build en vez de
  // acumularse en silencio.
  {
    files: ['packages/ui/src/**/*.tsx', 'packages/ui/src/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // ── Regla 4: los colores ─────────────────────────────────────────────────
  //
  // Solo componentes. `packages/ui/src/theme/**` queda fuera porque es donde
  // los colores se definen — es la excepción que hace verdadera a la regla.
  //
  // También los `.ts`: el color no deja de serlo por vivir en un módulo sin
  // JSX. Se vio en `plugins/view-replay.ts`, que pintaba un `#000` que la
  // regla no miraba porque solo cubría `.tsx`.
  //
  // Los `.css` NO los ve ESLint (traería `@eslint/css` y su parser, contra el
  // «sin dependencias» de `tools/eslint/index.js`): los cubre
  // `npm run lint:css`, que corre dentro de `npm run lint`.
  {
    files: ['packages/ui/src/**/*.tsx', 'packages/ui/src/**/*.ts'],
    ignores: ['packages/ui/src/theme/**'],
    rules: { 'orbit/no-hardcoded-colors': 'error' },
  },

  // Los `.js`/`.mjs` del repo (herramientas, este propio plugin) son
  // JavaScript de verdad: ahí `no-unused-vars` no tiene por qué fallar.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all' }],
    },
  },

  // Los tests pueden pisar globales (`globalThis.Float32Array`) y usar
  // literales que en producción serían sospechosos: es su trabajo.
  {
    files: ['**/test/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      'orbit/no-hardcoded-colors': 'off',
      'orbit/no-audio-thread-alloc': 'off',
    },
  },
];
