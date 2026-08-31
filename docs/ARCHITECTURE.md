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
- **Parte en dos, y el índice lo refleja**: `src/index.ts` es browser-safe
  (`TOOLS`, `ToolExecutor`, `adviseMix`) porque el executor corre en el
  **renderer**, que es donde vive el `ProjectStore` con el proyecto abierto; el
  main solo transporta. El lado Node —host WS, relay MCP stdio, `ws`— se pide
  por subruta (`@orbit/claude-bridge/node/ws-host`) y solo lo importa
  `apps/desktop`. De ahí que `ui→claude-bridge` sea una arista normal y no una
  fuga de Node al bundle.

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

## Fronteras entre paquetes

Es la regla dura 6 de `CLAUDE.md`, y aquí está el porqué. El grafo, medido
sobre el árbol (`grep "from '@orbit/"` por paquete, v3.8):

```
                      apps/desktop  ─────────────┐
                            │                    ▼
                            ▼               apps/server
              ui ──────┬──────────┬───────────┐    │
              │        │          │           │    │
              ▼        ▼          ▼           │    │
      claude-bridge    │      sound-library    │    │
              │  ╲     │       ╱    │         │    │
              ▼   ╲    ▼      ╱     ▼      collab  │
           engine ◄─────────┘     engine      │    │
              │                     │         │    │
              └───────────► core ◄──┴─────────┴────┘
```

`core→∅` · `engine→core` · `collab→core` · `sound-library→core,engine` ·
`claude-bridge→core,engine,sound-library` ·
`ui→core,engine,collab,sound-library,claude-bridge`.
Y las hojas: `apps/server→core,collab`, `apps/desktop→` todo + `apps/server`
(el escritorio levanta el servidor de colaboración en su propio proceso, para
abrir sala sin lanzar nada aparte).

### Qué protege, capa por capa

Es un **DAG por capas**, y esa es toda la propiedad que importa: si cada
paquete solo importa paquetes de capa estrictamente menor, no hay ciclo
posible, y el orden de las capas es el orden en que se puede razonar sobre el
sistema.

- **`core` no importa a nadie.** Es la capa 0 y es lo único innegociable: el
  modelo es la única verdad y no puede depender de quien lo dibuja, lo suena o
  lo sincroniza. Verificado: `packages/core` no tiene un solo `@orbit/*`, ni en
  `src/` ni en sus tests. Si algún día lo tiene, el ciclo ya está hecho.
- **`engine` y `collab` son hermanos sobre `core`.** Ninguno de los dos sabe
  del otro, y eso es lo que permite renderizar offline sin Yjs y colaborar sin
  AudioContext (`tools/qa/listen-peer.ts` es exactamente eso).
- **`sound-library` está por encima de `engine` a propósito**: su `generate/`
  sintetiza el contenido de fábrica *con las unidades del motor*, semilla fija,
  para que los WAVs sean reproducibles. Es la razón de ser del paquete.
- **`claude-bridge` está por encima de todo lo anterior** porque su superficie
  de tools lo obliga: `render` y `analyze_mix` son el motor, `generate_pack` es
  la librería. Un puente que solo hablase con `core` solo podría editar notas.
- **`ui` es la última capa** y puede con todas, que es lo que se espera del
  renderer.

### Dos matices que el grafo no dice, y sí son la regla

1. **De `core`, `engine` usa el modelo — nunca el estado.** La regla vieja decía
   `engine→core (tipos)`, y era falso desde el primer compilador: `compile.ts`
   importa una docena de funciones puras (`anyChannelSoloOn`, `resolveSend`,
   `resolveGroupBuses`…), `dsp/voices.ts` importa `DRUM_MAP` y `midiToHz`, y
   `kernel-core.ts` importa `MAX_INPUT_CHANNELS`. Todas salen de `model/`, y
   ninguna es estado. Lo que aquel `(tipos)` quería decir, y sí se sostiene, es
   que el motor **no toca `ProjectStore`, ni el bus de comandos, ni el
   historial**: compila el proyecto, no lo edita. Medido: cero apariciones de
   `ProjectStore`/`applyCommand`/`buildTreeView` en `packages/engine/src`. En
   sus tests sí aparecen —montan el proyecto de prueba con `applyCommand` y
   luego lo compilan—, que es conducir el modelo desde fuera, no depender de él.
2. **`ui` se empaqueta para el navegador.** No importa `apps/server` ni una
   subruta `node/` de otro paquete, aunque la arista esté permitida: se traería
   `ws` y `node:http` al bundle del renderer. Es un filo real, no teórico —
   `ui→claude-bridge` es legal y necesario, y `@orbit/claude-bridge/node/ws-host`
   está a un carácter de distancia—; por eso ese paquete parte su índice (ver
   arriba) y por eso `packages/ui/src/collab/collab-state.ts` lleva escrito a
   mano por qué no importa `@orbit/server`.

### Por qué se escribió la realidad y no al revés (v3.8)

Hasta la v3.8 esta lista decía `ui→core,engine,collab · collab→core ·
engine→core (tipos) · claude-bridge→core`: cuatro paquetes, cuando el árbol
tenía seis. `sound-library` ni figuraba. Doce imports reales la incumplían.

Se eligió **corregir la doc, no el código**, y conviene dejar por qué, porque
la tentación contraria es fuerte cuando uno lee «regla dura»:

- **La propia arquitectura ya documentaba las aristas «prohibidas» en prosa.**
  `sound-library` se describe desde el principio como *«scripts Node que
  sintetizan el contenido de fábrica con las unidades de `engine`»*, treinta
  líneas por encima de una lista que no le permitía importar `engine`. No es
  que el código se saliera del diseño: es que la lista se quedó en la v0.1 y no
  se volvió a medir.
- **Ninguna de las seis es una arista hacia arriba.** Ni una sola crea un ciclo,
  ni ensucia `core`. Todas van de capa alta a capa baja, que es precisamente lo
  que la regla quería garantizar. Lo que la regla prohibía de más era
  *profundidad*, no *dirección*, y la profundidad no hace daño.
- **Cada sitio dudoso ya tenía su razón escrita al lado.** El índice
  browser-safe de `claude-bridge`, el comentario de `collab-state.ts`, la
  cabecera de `package-boundaries.js` («se escribe la realidad, porque una regla
  que no pasa sobre el árbol tal cual está no la enciende nadie»). El linter de
  reglas duras ya hacía cumplir el grafo verdadero desde `038164b`: la doc era
  el único sitio del repo que seguía diciendo otra cosa.
- **Romperlas costaba más de lo que compraba.** `ui→sound-library` son ocho
  sitios y todos son el Browser usando el vocabulario de la librería
  (`SOUND_CATEGORIES`, `SoundEntry`, `analyzeSample`); romperlo obliga a
  duplicar la taxonomía en `ui` o a subirla a `core`, que es meter clasificación
  de samples en el modelo del proyecto. Peor arquitectura por una lista.

Lo que sí se estrechó en vez de simplemente rendirse a lo que había: el
`(tipos)` de `engine→core` pasó a ser la regla de verdad (el modelo, no el
estado) y el «`ui` es el renderer» dejó de ser un comentario suelto para ser
una comprobación. Las dos se verifican solas.

### Dónde se hace cumplir

El grafo se escribe **una sola vez**, en `tools/eslint/package-graph.json`.
Lo leen dos:

- `orbit/package-boundaries` (regla de ESLint, `npm run lint`) prohíbe la
  arista que no está, tanto por alias (`@orbit/otro`) como por relativo
  (`../../otro/src/x`, el que se cuela en una revisión humana), más los dos
  matices de arriba.
- `tools/eslint/package-graph.test.ts` (`npm run test`) compara ese JSON con lo
  que dicen `CLAUDE.md` y este archivo, y con los exports reales de `core`. Si
  alguien cambia uno de los tres y no los otros, falla — que es exactamente el
  fallo que estuvo abierto desde la v0.1 hasta la v3.8 sin que nada lo notara.

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
- Los paquetes no se importan entre sí salvo: `core→∅`, `engine→core`,
  `collab→core`, `sound-library→core,engine`,
  `claude-bridge→core,engine,sound-library`,
  `ui→core,engine,collab,sound-library,claude-bridge`. El porqué de cada arista
  —y los dos matices que la lista no dice— en «Fronteras entre paquetes», más
  arriba.
- Commits granulares en español: `feat(engine): compresor sidechain`, y push
  al terminar cada pieza. Release (tag) solo al final de cada versión.
