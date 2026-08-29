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
   (tokens en `packages/ui/src/theme/`). El acrílico sigue la arquitectura A del
   skill `acrylic-theming` (alfa de ventana + DWM; `backdrop-filter` solo en
   popups). Apagar el acrílico es un teardown real.
5. **Golden tests**: `engine/test/golden` fija el sonido con 25 renders
   deterministas y 2 flujos Opus. Cualquier cambio de sonido tiene que
   actualizar su línea base **conscientemente**: `npm run golden:update` enseña
   el diff y NO escribe; escribir pide `--accept "<motivo>"`, y el commit debe
   decir qué diff de sonido se aceptó. Nunca un `--update-snapshots`. Se compara
   el hash bit a bit (medido reproducible en x64 entre win/linux y tres
   versiones mayores de V8) **y** medidas perceptuales con tolerancia, que son
   las que dicen QUÉ se movió. El porqué de cada decisión, con sus medidas, en
   `docs/GOLDEN.md`.
6. Los paquetes solo se importan así: `ui→core,engine,collab` · `collab→core` ·
   `engine→core` (tipos) · `claude-bridge→core`. Nada circular.

## Flujo de trabajo

- Commits granulares en español (`feat(engine): …`, `feat(ui): …`) y **push al
  terminar cada pieza**. Muchos commits pequeños > uno gigante.
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
npm run build        # build de producción

npm run golden:update   # diff de sonido; sin --accept NO escribe (docs/GOLDEN.md)
npm run golden:bite     # ¿algún fixture del golden dejó de medir?
```

## Contexto de producto

El usuario es productor (catálogo El Doctor); el DAW debe servir su flujo real:
trap/reggaetón/boom bap con 808 glide, export .mid+wav para FL, masters a
-14 LUFS para streaming, y su voz siempre por encima del beat en las mezclas.
