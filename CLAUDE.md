# Onza Studio — instrucciones del repo

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
5. **Golden tests**: cualquier cambio de sonido en `engine` debe actualizar los
   hashes de `engine/test/golden` conscientemente (es un diff de sonido).
6. Los paquetes solo se importan así: `ui→core,engine,collab` · `collab→core` ·
   `engine→core` (tipos) · `claude-bridge→core`. Nada circular.

## Flujo de trabajo

- Commits granulares en español (`feat(engine): …`, `feat(ui): …`) y **push al
  terminar cada pieza**. Muchos commits pequeños > uno gigante.
- Release (tag + GitHub release) solo al cerrar una versión, no por commit.
- `npm run typecheck && npm run build` debe pasar antes de cada commit.

## Comandos

```bash
npm install          # instala todo el workspace
npm run dev          # Vite (ui) + Electron con recarga
npm run server       # servidor de colaboración local
npm run typecheck    # TS estricto en todos los paquetes
npm run test         # unit + golden DSP
npm run build        # build de producción
```

## Contexto de producto

El usuario es productor (catálogo El Doctor); el DAW debe servir su flujo real:
trap/reggaetón/boom bap con 808 glide, export .mid+wav para FL, masters a
-14 LUFS para streaming, y su voz siempre por encima del beat en las mezclas.
