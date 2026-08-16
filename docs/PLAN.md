# Plan de trabajo — Orbit Studio

Plan por fases. Cada fase deja el producto **usable y coherente**; cada entrega
dentro de una fase es su propio commit. El release formal (tag + GitHub release)
se saca al final, cuando el conjunto está pulido.

---

## Estado — 16-08-2026: v0.5.0

v0.5, "toca y despacha": **tocable en vivo** (Web MIDI + teclado del PC,
grabación MIDI armada al patrón con cuantización, pause real y tap tempo),
**flujo diario** (paleta Ctrl+K, cortar y mutear clips, gestión de
arrangements, export del loop y MP3, carpetas del usuario en el browser),
**el toque Orbit** (cadena vocal de un clic y campo de petición a Claude en
su panel) y **el pack crece a 84 sonidos** con la categoría Instrumentos:
24 instrumentos con altura por síntesis (pianos, guitarras Karplus-Strong,
bajos, órganos, pads, campanas, leads) tocables por nota en el piano roll
vía sampler + keytrack. 107 tests.

## Estado anterior — v0.4.0

v0.4, "graba tu voz": **grabación de micro a la playlist** (botón en el
transport; la toma se guarda como WAV en userData/recordings, se registra
con el esquema `recording:` y cae como clip donde empezó, con rehidratación
al reabrir), **editor de audio estilo Edison** (recorte por asas no
destructivo, ganancia, normalizar/reverse/fades como sample nuevo con undo)
e **import MIDI** (decodificador SMF con round-trip contra el export;
Archivo → Importar crea canales, patrón y tempo en un undo). 79 tests.

## Estado anterior — v0.3.0

v0.1: fases 0–7 completas con QA real contra la app viva. v0.2: fiabilidad
diaria (CI, CPU visible, autosave + crash recovery) y flujo real (export MIDI
multipista, marcadores, drag & drop, clips de audio, rehidratación de samples).
v0.3, "el estudio se siente vivo": **piano roll pro** (arpegiar, strum,
humanize y chop de note-tools, pan por nota en el carril conmutable, minimapa
clicable), **colaboración visible** (cursores remotos con nombre y color en
playlist y piano roll, actividad por peer en el panel y Claude como
colaborador en la presencia) y **mixer fino** (nivel por send con perilla,
línea de RMS + LED de clip enclavado, Orbit Scope real con forma de onda y
espectro del master). 65 tests en verde. Instalador NSIS por release.

Backlog v0.x (detalle en [FEATURES.md](FEATURES.md)): pause/tap tempo,
slice/mute por clip, gestión de arrangements desde la UI, paleta de comandos
Ctrl+K, export de selección y sample rates, carpetas del usuario en el
browser, snap magnético y bloqueo a escala, graph editor del rack.

---

## Fase 0 — Fundaciones (docs + esqueleto)

**Objetivo:** el proyecto existe, está documentado y compila.

- [x] Documentación maestra: PLAN, FEATURES, ARCHITECTURE, THEMING, COLLAB, CLAUDE-INTEGRATION.
- [x] Monorepo npm workspaces con TypeScript estricto: `apps/desktop`, `apps/server`,
      `packages/{core,engine,ui,collab,claude-bridge,sound-library}`.
- [x] Repo GitHub privado `Orbit-Studio`.
- [x] CI mínimo (typecheck + tests + build) en GitHub Actions.

**Criterio de salida:** `npm run dev` abre una ventana Electron con la UI base.

---

## Fase 1 — El corazón: modelo + motor de audio

**Objetivo:** suena. Un proyecto en memoria se reproduce con precisión de sample.

### 1a. `packages/core` — el modelo de proyecto
- Tipos completos: proyecto, patrones, canales (instrumentos), notas, playlist
  (pistas y clips), mixer (pistas de insert, slots de efectos, routing, sends),
  automatización, marcadores, arrangements.
- **Bus de comandos**: toda mutación pasa por un comando con inverso → undo/redo
  ilimitado, y la misma vía sirve luego para colaboración y para Claude.
- IDs estables (nanoid) en todas las entidades → merge CRDT sin ambigüedad.
- Serialización `.orbit` (JSON versionado; samples referenciados por hash).

### 1b. `packages/engine` — el motor DSP
- Un AudioWorklet único con el kernel completo (sin latencia de grafo Web Audio):
  - **Transport**: play/stop/loop, PPQ 96, tempo y compás variables, metrónomo.
  - **Scheduler**: eventos con precisión de sample, lookahead de un bloque.
  - **Voces**: sustractiva (saw/square/tri/sine + filtro SVF + ADSR), supersaw
    (7 osc detune), FM 2-op, **808** (sine + drive tanh + glide), sampler
    (pitch-shift por velocidad), drums sintetizados (kick, clap, snare, hats por
    ruido filtrado — regla del engine: nunca osciladores para hats), percusión
    latina (conga, rim, shaker).
  - **Efectos** (por slot de mixer): EQ paramétrico 3+ bandas (biquads RBJ),
    compresor, limiter lookahead, reverb (Freeverb/FDN), delay estéreo con
    feedback filtrado, chorus/flanger/phaser, distorsión/bitcrush, filtros con
    envolvente, gate, utilidades estéreo (width, pan), **sidechain** por routing.
  - **Mixer**: N pistas de insert + master, ganancia/pan/mute/solo, sends,
    routing libre (grafo dirigido), medidores peak/RMS enviados a la UI.
- Golden tests de DSP (render determinista con semilla fija → comparar hash).

**Criterio de salida:** un proyecto demo (trap con 808) suena idéntico al render
offline y el CPU se mantiene bajo.

---

## Fase 2 — El shell: ventana, temas, layout

**Objetivo:** se ve como Orbit Studio. Minimalista, iconos estilo Mac, tres temas.

- `apps/desktop`: ventana frameless con **arquitectura A** del skill de acrílico
  (la ventana compone con alfa; el acrílico lo pone DWM con `backgroundMaterial`;
  el CSS deja de pintar opaco; `backdrop-filter` solo en menús/modales/tooltips).
- Temas **oscuro** (defecto), **claro** y **acrílico** por CSS variables.
- Controles de ventana: estilo Windows por defecto, **semáforo de macOS** como
  opción (posición izquierda, hover con glifos, colores exactos).
- Layout: barra superior (menús + transport + CPU/level meter), sistema de
  **ventanas internas** movibles/redimensionables (como FL) sobre un fondo de
  trabajo, barra lateral del Browser, panel de Claude acoplable a la derecha.
- Atajos: F5 playlist, F6 channel rack, F7 piano roll, F9 mixer, F10 ajustes,
  Space play/stop, Ctrl+Z/Y undo/redo… (catálogo completo en FEATURES).

**Criterio de salida:** ciclo ON→OFF→ON del acrílico verificado con captura real
(regla del skill: traer la ventana al frente antes de capturar).

---

## Fase 3 — Los cuatro editores

**Objetivo:** el flujo FL completo: componer → secuenciar → arreglar → mezclar.

1. **Channel Rack**: lista de canales con step sequencer de 16 pasos (extensible),
   LEDs por paso, mute/solo, vol/pan por canal, selector de patrón, swing global,
   click derecho = piano roll del canal, asignación a pista de mixer.
2. **Piano Roll**: dibujar/pintar (brush)/cortar/seleccionar/duplicar notas,
   velocidad y pan por nota, slide notes (para el 808), snap configurable (línea,
   1/2… 1/16, tresillos, none), escala resaltada, ghost notes, zoom H/V,
   herramientas: quantize, arpegiar, strum, humanize, chop, transponer.
3. **Playlist**: pistas ilimitadas; clips de patrón, de audio y de automatización;
   cortar (slip), duplicar (Ctrl+B), pintar clips, marcadores de sección con
   nombre, loop de reproducción, múltiples arrangements.
4. **Mixer**: strips verticales con fader (dB real), pan, mute/solo, 10 slots de
   efectos, routing por click (como FL), sends al master y entre pistas,
   medidores en tiempo real, UI de cada efecto en ventana propia con perillas.

**Criterio de salida:** producir un beat completo de principio a fin sin tocar
código.

---

## Fase 4 — Librería, automatización, export

1. **Browser + sound library**: árbol por categorías (Drums, 808s, Percusión
   latina, Melódicos, FX, Presets, Proyectos), tags (género, mood, tonalidad,
   BPM), búsqueda instantánea, preview al click, drag & drop a channel rack o
   playlist. Contenido de fábrica **generado por síntesis** (port del ADN de
   engine.py) con manifest JSON — todo clasificado, nada suelto.
2. **Automatización**: clips con curvas editables (puntos + tensión), enlazar
   cualquier parámetro ("link to controller" del último tocado), LFO por
   parámetro, grabación de movimientos de perillas.
3. **Export**: render offline (mismo kernel DSP, más rápido que tiempo real) a
   WAV 16/24/32f; master o **stems por pista de mixer**; tail de reverb;
   normalización opcional a -14 LUFS (flujo de streaming de Orbit).

---

## Fase 5 — Colaboración en tiempo real

- El proyecto vive en un **doc Yjs**; los comandos de core mutan el doc y todos
  los clientes convergen sin conflictos.
- `apps/server`: WebSocket propio con **rooms por código** (estilo "entra con
  este código a mi sesión"), persistencia del doc, auth simple por token.
- Presencia: cursores de otros usuarios en playlist/piano roll, colores por
  usuario, "X está editando el Mixer", lista de conectados con avatar.
- Undo **por usuario** (Yjs UndoManager con origin scoping).
- Modo seguidor: ver la vista de otro usuario en vivo.

---

## Fase 6 — Claude dentro del estudio

- `packages/claude-bridge`: la app expone un **servidor MCP** (WebSocket/stdio)
  con herramientas: `get_project`, `add_notes`, `edit_pattern`, `set_mixer`,
  `add_effect`, `set_automation`, `render`, `analyze_mix`…
- Claude Code se conecta con el `.mcp.json` del repo y trabaja **como un
  colaborador más**: sus ediciones pasan por el mismo bus de comandos → se ven
  en tiempo real, tienen undo y aparecen en la presencia como "Claude".
- **Panel de Claude** en la app: feed de actividad (qué tocó y por qué), y campo
  de petición rápida que lanza a Claude con contexto del proyecto.

---

## Fase 7 — Pulido y release

- Theme customizer completo (perillas transparencia/tinte/acento, picker de
  color, guardar temas con nombre, exportar/importar tema).
- Iconos propios minimalistas estilo Mac (SVG), splash, sonidos de UI sutiles.
- QA del flujo entero: crear → mezclar → automatizar → exportar → colaborar →
  Claude. Rendimiento: proyecto de 100 pistas sin dropouts.
- README con capturas, CHANGELOG, **tag v0.1.0 + GitHub release** (solo al final).

---

## Después de v0.1 (backlog priorizado)

- Grabación de audio (micro/línea) con editor de sample estilo Edison.
- Time-stretch / pitch-shift de clips de audio (fase vocoder / elastique-like).
- SDK de plugins JS (instrumentos y efectos de terceros en sandbox) y puente
  CLAP/VST3 vía proceso nativo.
- Import/export MIDI completo, export MP3/FLAC, export de video para visuales.
- Vista "Live" por escenas (lanzar clips), controladores MIDI hardware
  (Web MIDI ya en v0.x para teclado), macros de mezcla.
- Chat de voz/texto en sesiones colaborativas; historial de versiones del
  proyecto con diff musical ("¿qué cambió en el drop?").
