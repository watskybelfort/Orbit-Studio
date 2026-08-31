# Orbit Studio — instrucciones del repo

DAW propio (estilo FL Studio) en Electron + TypeScript. Lee `docs/PLAN.md` para
el estado por fases y `docs/ARCHITECTURE.md` antes de tocar el motor o el modelo.

## Reglas duras

1. **Toda mutación del proyecto pasa por el bus de comandos de `packages/core`.**
   Nunca mutar el store/Yjs directo desde UI, MCP o collab: rompe undo y merge.
2. **Cero alocaciones en el audio thread.** En `packages/engine/worklet` no se
   crea ningún objeto/array dentro de `process()`; buffers preasignados.
3. **DSP con carácter, sin artefactos**: hats/cymbals por ruido filtrado (nunca
   osciladores a frecuencias altas — alias), `tanh` con moderación, low-end mono
   < 110 Hz en el master.
4. **Temas**: ningún color hardcodeado en componentes — todo por CSS variables
   (tokens en `packages/ui/src/theme/`). Un `var(--x, #hex)` con fallback
   también es un color hardcodeado: si el token puede faltar, lo que falta es el
   token. **Una sola excepción, y es técnica**: los editores que pintan en
   `<canvas>` (`editors/automation`, `editors/pianoroll`, `editors/playlist`)
   mantienen su paleta por tema (`--au-*`, `--pr-*`, `--pl-*`) declarada en el
   `.css` del propio editor y con valores LITERALES —nada de `var()` ni
   `color-mix()`—, porque el canvas los lee con `getComputedStyle()` y una
   custom property que referencia otra no se resuelve así: `--b: var(--a)`
   vuelve como el texto `"var(--a)"`, no como un color. Esa paleta declara los
   tres temas, igual que `theme/tokens.css`, y lleva escrito el porqué en su
   cabecera. Misma familia: `plugins/view-replay.ts`, que es un módulo puro sin
   DOM y cuyo `fillStyle` tampoco resuelve `var()`. Lo hacen cumplir
   `orbit/no-hardcoded-colors` (los `.tsx` y `.ts`) y `npm run lint:css` (los
   `.css`). El acrílico sigue la arquitectura A del skill `acrylic-theming`
   (alfa de ventana + DWM; `backdrop-filter` solo en popups). Apagar el acrílico
   es un teardown real.
5. **Golden tests**: `engine/test/golden` fija el sonido con 25 renders
   deterministas y 2 flujos Opus. Cualquier cambio de sonido tiene que
   actualizar su línea base **conscientemente**: `npm run golden:update` enseña
   el diff y NO escribe; escribir pide `--accept "<motivo>"`, y el commit debe
   decir qué diff de sonido se aceptó. Nunca un `--update-snapshots`. Se compara
   el hash bit a bit (medido reproducible en x64 entre win/linux y tres
   versiones mayores de V8) **y** medidas perceptuales con tolerancia, que son
   las que dicen QUÉ se movió. El porqué de cada decisión, con sus medidas, en
   `docs/GOLDEN.md`.
6. **Las dependencias entre paquetes van en un solo sentido**, y son estas —el
   grafo real, medido, no el de la v0.1—: `core→∅` · `engine→core` ·
   `collab→core` · `sound-library→core,engine` ·
   `claude-bridge→core,engine,sound-library` ·
   `ui→core,engine,collab,sound-library,claude-bridge`. Es un DAG por capas, así
   que nada circular: `core` no importa ningún `@orbit/*`. Dos matices que la
   lista no dice y que también son la regla: de `core`, `engine` usa el
   **modelo** (tipos, constantes y funciones puras de `model/`) y nunca el
   store, el bus de comandos ni el historial —el motor compila el proyecto, no
   lo edita—; y `ui` es el renderer, así que no importa `apps/server` ni ninguna
   subruta `node/` de otro paquete (arrastraría `ws`/`node:http` al bundle): el
   lado Node lo monta `apps/desktop`. Lo hace cumplir
   `orbit/package-boundaries`; el grafo se escribe UNA vez, en
   `tools/eslint/package-graph.json`, y `tools/eslint/package-graph.test.ts`
   falla si esta lista deja de coincidir con él o con `docs/ARCHITECTURE.md`.

## Flujo de trabajo

- Commits granulares en español (`feat(engine): …`, `feat(ui): …`) y **push al
  terminar cada pieza**. Muchos commits pequeños > uno gigante.
- **Después de cada push, `npm run ci:status`** para ver en una línea cómo
  quedó (verde / roja / en curso / sin ejecución todavía) sin acordarse de la
  sintaxis de `gh run list`. Nace de que la v3.8.0 se taggeó y publicó con
  `CI` en rojo desde seis pushes antes y nadie lo miró — el comando existe
  para que mirarlo no dependa de acordarse de mirarlo. `Release` (al taguear)
  hace esta misma consulta sola y la anuncia en el cuerpo de la GitHub
  Release y como aviso del job — no bloquea el tag (ver el porqué en el
  comentario de `.github/workflows/release.yml`), así que un hotfix sigue
  pudiendo salir con la CI roja, pero ya no en silencio.
- Release (tag + GitHub release) solo al cerrar una versión, no por commit.
- `npm run typecheck && npm run build` debe pasar antes de cada commit.
- **Tests de `packages/ui`: extraer lógica a módulos puros y probar eso, sin
  jsdom ni `@testing-library/react`.** Es lo que ya hace el repo (`selection.ts`,
  `filters.ts`, `plugin-parse.ts`): un componente `.tsx` se queda con el dibujo
  y los gestos, y la aritmética/las reglas que puede romper una regresión
  silenciosa viven en un módulo hermano sin React, importable desde Vitest tal
  cual (`environment: 'node'`, el que ya usa todo el repo — no hay `vitest.config`
  ni dependencia de DOM en ningún paquete). Cuando la regla que hay que cubrir
  vive en el propio JSX de un `.tsx` (un manejador de evento, el orden de un
  `await`), en vez de montar el componente se lee su código fuente de verdad
  con `fs.readFileSync` y se comprueba la propiedad sobre el texto (ver
  `packages/ui/test/drop-handlers-sync.test.ts`), o se ejercitan sus estados
  internos (zustand, `store.dispatch`, un `window`/`navigator` de mentira con
  `vi.stubGlobal`) sin DOM real (ver `packages/ui/test/live-input-bend.test.ts`,
  `run-export.test.ts`). Añadir jsdom sería la vía obvia para probar un
  componente montado, pero arrastra una dependencia nueva y una clase de test
  (snapshots de render, `act()`, timers de React) que envejece peor que la
  aritmética aislada — se prefiere extraer salvo que la lógica sea inseparable
  de un ciclo de render real.

## Comandos

```bash
npm install          # instala todo el workspace
npm run dev          # Vite (ui) + Electron con recarga
npm run server       # servidor de colaboración local
npm run typecheck    # TS estricto en todos los paquetes
npm run test         # unit + golden DSP
npm run lint         # reglas duras + hooks; exhaustive-deps es error, rompe la CI
                     # (encadena lint:css: la regla 4 sobre los .css)
npm run lint:css     # solo los colores: ningún literal fuera de theme/
npm run build        # build de producción

npm run golden:update   # diff de sonido; sin --accept NO escribe (docs/GOLDEN.md)
npm run golden:bite     # ¿algún fixture del golden dejó de medir?
npm run listen:kit      # renderiza a out/escucha lo que hay que juzgar con el oído
npm run ci:status       # cómo quedó el último push (o cualquier SHA), en una línea
```

## Contexto de producto

Orbit no aspira a ser un DAW genérico: se diseña contra un flujo de producción
concreto — trap/reggaetón/boom bap con 808 glide, export .mid+wav para seguir
en FL, masters a -14 LUFS para streaming, y mezclas con la voz siempre por
encima del beat. Cuando una decisión quede entre lo general y lo que le sirve a
ese flujo, gana ese flujo.
