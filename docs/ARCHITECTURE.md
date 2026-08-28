# Arquitectura — Orbit Studio

## Visión general

```
┌────────────────────────────  apps/desktop (Electron)  ───────────────────────────┐
│  main process: ventana+DWM acrílico · IPC · FS (samples, .orbit) · claude-bridge  │
│  ┌──────────────────────────  renderer (packages/ui)  ─────────────────────────┐ │
│  │  React: Playlist · Piano Roll · Channel Rack · Mixer · Browser · Claude     │ │
│  │  Estado UI (zustand)  ←→  packages/core (modelo + bus de comandos)          │ │
│  │           │                        │                                        │ │
│  │           │                packages/collab (Yjs ⇄ modelo)                   │ │
│  │           ▼                        ▼                                        │ │
│  │  AudioContext ── MessagePort ── packages/engine (AudioWorklet DSP kernel)   │ │
│  └─────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────┘
            ▲ WebSocket (rooms, presencia)                ▲ MCP (WS)
            │                                             │
     apps/server (colaboración)                    Claude Code / agentes
```

## Decisiones clave (y por qué)

1. **Electron + TypeScript + React.** Es la única vía que cumple a la vez: temas
   acrílicos reales en Windows (skill acrylic-theming, arquitectura A), UI muy
   pulida y rápida de iterar, colaboración web-native y multiplataforma después.
2. **Un solo AudioWorklet como kernel DSP.** No usamos el grafo de nodos de Web
   Audio para el motor: todo (voces, efectos, mixer, scheduler) corre dentro de
   un `AudioWorkletProcessor` propio. Ventajas: timing sample-accurate, routing
   libre sin límites del grafo, cero GC si preasignamos buffers, y el mismo
   kernel sirve para render offline (OfflineAudioContext).
3. **El modelo es la única verdad; toda mutación es un comando.** UI, atajos,
   colaboración y Claude usan el mismo bus de comandos (`core`). Cada comando
   tiene inverso (undo) y se aplica sobre el doc Yjs, así la colaboración y el
   undo por usuario salen del mismo mecanismo.
4. **Yjs para colaboración.** CRDT probado, tipos Y.Map/Y.Array mapean el modelo
   1:1 y awareness para presencia. El undo por usuario NO es de Yjs: el scoping
   por origen lo hace `ProjectStore` (ver `docs/HISTORY.md`).
5. **Claude entra por MCP, no por hacks.** `packages/claude-bridge` expone tools
   MCP que emiten comandos al mismo bus. Claude es, a efectos del sistema, un
   colaborador más con presencia propia.

## Paquetes

### `packages/core`
- `model/`: tipos del proyecto. Todas las entidades con `id` (nanoid).
- `commands/`: comandos serializables `{type, payload}` con `apply/invert`.
- `store.ts`: estado del proyecto + suscripciones granulares.
- `orbit-format.ts`: guardar/cargar `.orbit` (JSON con `formatVersion`).
- Sin dependencias de DOM ni de Electron: corre en renderer, server y tests.

### `packages/engine`
- `dsp/`: unidades puras (osciladores, filtros SVF/biquad RBJ, envolventes,
  reverb, delay…). Funciones sobre `Float32Array`, sin alocaciones en proceso.
- `worklet/processor.ts`: el kernel — recibe el **snapshot compilado** del
  proyecto (patrones→eventos absolutos), agenda con lookahead, renderiza bloques
  de 128 samples, aplica cadenas de efectos y routing, y postea medidores.
- `render/offline.ts`: mismo kernel sobre OfflineAudioContext (export).
- `protocol.ts`: mensajes UI⇄worklet tipados (transport, params, meters).
- Regla heredada del engine de producción: low-end mono < 110 Hz en master,
  hats por ruido filtrado (nunca osciladores a frecuencias altas), `tanh` con
  moderación.

### `packages/ui`
- React 18 + zustand. Canvas 2D para piano roll/playlist (rendimiento), DOM
  para racks y mixer. Ninguna librería de componentes pesada: los widgets
  (perilla, fader, LED) son nuestros, tematizables por CSS variables.

### `packages/collab`
- `bindProject(ydoc, store)`: mapea el modelo a Y.Map/Y.Array y aplica cambios
  remotos al store. Awareness → presencia. El undo por origen lo hace el store
  de core, no Yjs.

### `packages/claude-bridge`
- Servidor MCP (WebSocket) dentro del main process. Tools → comandos de core.
- Feed de actividad: cada tool call se registra y la UI lo muestra en el panel.

### `packages/sound-library`
- `manifest.json` clasificado (categoría/género/tonalidad/BPM/tags).
- `generate/`: scripts Node que sintetizan el contenido de fábrica con las
  unidades de `engine` (determinista, semilla fija) → WAVs reproducibles.

### `apps/desktop`
- `main.ts`: BrowserWindow frameless; acrílico por `backgroundMaterial` DWM
  (arquitectura A del skill); IPC tipado (`preload.ts` con contextBridge);
  diálogos de archivo; watcher de carpetas del usuario para el browser.
- `windows.ts`: opción semáforo Mac ⇄ botones Windows (los dibuja la UI, el
  main solo ejecuta minimize/maximize/close).

### `apps/server`
- Node + `ws` + y-websocket protocol: rooms por código, persistencia snapshot
  del doc en disco, tokens simples, lista de presencia.

## Flujo de datos del audio

1. La UI edita el modelo → comando → store (+ Yjs si hay sesión).
2. Un **compilador de proyecto** (core) convierte patrones+playlist+automatización
   en una lista de eventos con tiempo absoluto en PPQ y curvas muestreadas.
3. El snapshot compilado se postea al worklet (transferable). Ediciones en vivo
   → snapshots incrementales por entidad (no se recompila todo).
4. El worklet agenda por bloque: convierte PPQ→samples con el tempo map, dispara
   voces, procesa cadenas de efectos por pista en orden topológico del grafo de
   routing, aplica sends, sidechain y master chain.
5. Cada ~50 ms postea meters (peak/RMS por pista, CPU, posición) a la UI.

## Testing

- **Golden DSP**: render determinista (semilla fija) de proyectos de prueba →
  hash del WAV; cualquier cambio de sonido es un diff visible en el commit.
- Unit tests de core (comandos: apply+invert = identidad).
- Test de convergencia collab: N clientes aplican comandos aleatorios → estados
  finales idénticos.

## Convenciones

- TypeScript `strict`, ESM en todos los paquetes.
- Los paquetes no se importan entre sí salvo: `ui→core,engine,collab`,
  `collab→core`, `engine→core` (tipos), `claude-bridge→core`.
- Commits granulares en español: `feat(engine): compresor sidechain`, y push
  al terminar cada pieza. Release (tag) solo al final de cada versión.
