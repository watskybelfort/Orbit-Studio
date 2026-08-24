# Plan de trabajo — Orbit Studio

Plan por fases. Cada fase deja el producto **usable y coherente**; cada entrega
dentro de una fase es su propio commit. El release formal (tag + GitHub release)
se saca al final, cuando el conjunto está pulido.

---

## Estado — 23-08-2026: v3.2.0

v3.2, "el pack suena a instrumentos". Tres entregas del roadmap de la v3.1, y
van juntas porque las tres arreglan lo mismo: que Orbit sonara a muestras y no
a instrumentos.

**El pack de fábrica, en multisample.** `rootHz` era mentira: estaba en el
catálogo como metadato del manifest, pero la altura de verdad la ponía una
constante de módulo leída dentro de cada síntesis, así que los dos podían
dejar de coincidir sin que nada se enterase. Ahora es un parámetro
(`render(sr, rootHz)`) y cada instrumento se graba a tres alturas.

Threading la altura salieron cuatro cosas que solo se ven al grabar el mismo
instrumento en dos octavas, y las cuatro se oyen:

- La semilla del PRNG lleva la altura. Con la vieja —solo el slug— las tres
  tomas de un pad compartían desafinaciones, fases y frecuencias de deriva:
  juntas no sonaban a sección, sonaban a una fuente doblada.
- Los filtros de los instrumentos SINTÉTICOS siguen a la nota; los de los
  ACÚSTICOS no. El martillo del piano y el soplo de la flauta son formantes —
  no se mueven con la nota, y esa es exactamente la razón de grabar varias
  alturas en vez de estirar una.
- La cuerda pulsada se afina con retardo fraccionario. Media muestra de
  redondeo son 0,7 cents abajo y 2,6 arriba: la guitarra salía desafinada
  consigo misma y el escalón caía al cruzar de zona.
- Guardas de Nyquist donde el FM se sale (el tine 14:1 del piano eléctrico).

Y el bajo del pack ahora suena donde dice el piano roll: grabado en C2 y
colocado en la tecla 60, sonaba dos octavas más abajo que la pantalla.

El pack pasa de 22 a 41 MB, y el techo de banda de 12 a 14 kHz (existía para
dejar sitio al estiramiento, y el estiramiento es ahora la sexta parte; en PCM
el tamaño no depende del ancho de banda).

**La rueda de tono dobla el tono.** `Voice.retune()` es ahora el único sitio
donde una voz se reafina, y de él cuelgan el slide y la rueda: lo que arregle
uno no se le puede olvidar al otro. Cada instrumento lo implementa con su
moneda. El kernel guarda los semitonos POR CANAL, que es la otra mitad: una
nota tocada con la rueda sujeta nace ya doblada (`snap`) en vez de trepar sola.

**Muestras al keymap en bloque.** Payload de arrastre plural (manteniendo el
MIME de siempre, que es lo que consultan los `dragover` de todos los destinos),
selección múltiple en el Browser con su lógica aparte y probada, y cabeceras
que arrastran su grupo. Los tres destinos reparten en un solo deshacer.

**Tres fallos que estaban ahí antes**: el auto-mapa leía la nota de la RUTA
(una carpeta «Piano C3» apilaba treinta muestras en un do) y `take01/02/03` se
tomaban por las teclas 1, 2 y 3; y el generador del pack llevaba roto —le
faltaban campos que el kernel dio por obligatorios— sin que nadie pudiera
verlo, porque `packages/*/generate` no estaba en el typecheck.

**Fuera, con motivo escrito**: capas de velocidad en el pack (otras 48
grabaciones y 20 MB), soltar archivos del Explorador (el proceso principal
desconfía a propósito de las rutas del renderer: es una decisión de seguridad)
y grabar el gesto de la rueda como automatización. 1544 tests.

## Estado anterior — 23-08-2026: v3.1.0

v3.1, "el instrumento entero". Multisample: un canal de sampler con varias
muestras repartidas por teclas y por velocidad, en vez de una estirada por todo
el teclado con keytrack (un piano grabado en do sonaba a chipmunk dos octavas
arriba, porque cambiar la velocidad de lectura mueve las formantes y el ataque
con el tono).

Sale de la primera fila del roadmap de la v3.0.

**El modelo** (`core/model/keymap.ts`): una zona es un rectángulo en el plano
(tecla × velocidad) con su muestra, su raíz, su afinación fina y su ganancia.
Las zonas pueden solaparse a propósito —capas suave/fuerte, dos micros de la
misma toma— y todas las que caigan bajo la nota suenan. Viaja por `patchChannel`
como los cortes del Slicer, así que trae undo y colaboración sin comando nuevo,
y se sanea al abrir el .orbit.

**El auto-mapa** (`core/model/keymap-automap.ts`) es lo que hace que se use:
las muestras entran con su nota leída del nombre. Lo difícil no es leer
`Piano_C3.wav`, son los falsos positivos — `Bass2.wav` no es un si. Lo que no
sabe leer NO lo coloca: lo dice.

**El motor**: `MultiSamplerVoice` delega la lectura en `SamplerVoice`, una por
zona, en vez de reimplementarla — ese código tiene guardas de interpolación
bien pagadas (un NaN se queda para siempre en el limiter del master) y dos
copias se desincronizan. Las capas son UNA voz contra el tope del kernel.

**Un fallo que habría salido mudo**: el recolector de samples del render miraba
solo `ch.sampleId`, así que exportar un instrumento multisample lo habría
sacado en silencio. La decisión de qué samples hacen falta es ahora una función
pura con pruebas.

Y la tool 22 del bridge, `set_keymap`: Claude monta el multisample con las
muestras que ya tiene el proyecto.

**Fuera, con motivo escrito**: el pack de fábrica en multisample (toca el
generador, el manifest y el tamaño del instalador: su propia entrega) y soltar
muestras en bloque (el Browser arrastra una entrada cada vez). 1335 tests.

## Estado de la v3.0.0 — 23-08-2026


v3.0, "la toma en vivo". Orbit producía de maravilla y no se tocaba: esta
versión cierra el agujero por el que entra el sonido de fuera. Sale de las tres
primeras filas del roadmap, que eran las tres el mismo problema.

Es mayor y no menor por dos motivos. Uno de producto: el estudio deja de ser
una cosa en la que solo se *programa* música. Y otro técnico: cambia la forma
del motor — el nodo del kernel pasa a tener entrada, `MeterFrame` gana un campo
obligatorio (`inputPeak`) y la ruta de grabación deja de pasar por el navegador.


**El controlador MIDI, en serio.** La entrada era un `for` sobre todas las
entradas de Web MIDI, en todos los canales, con la velocidad tal cual. Ahora
cada dispositivo se enciende y se apaga por su cuenta —y apagado es sin
manejador, mudo del todo—, con filtro de canal, transposición por octavas y
curva de pulsación. La lectura de los bytes vive aparte (`midi-message.ts`) y se
prueba sin hardware: el note-on con velocidad 0 que ES un note-off, el pedal
continuo con histéresis, el pitch bend de dos bytes de 7 bits. El pedal de
sostenido (`sustain.ts`) va por dispositivo y resuelve los dos casos que dejan
notas colgando: repicar una tecla con el pedal pisado y apagar el teclado sin
levantarlo.

**MIDI learn.** Clic derecho en cualquier perilla → mueves el mando → casados.
Hizo falta la mitad que faltaba de `ParamRef`: `paramRefCommand` (core) devuelve
el Command que ESCRIBE cualquier destino, así que un mando físico pasa por el
bus y tiene undo y viaja a la sala. Volcado por frame y `mergeKey` por origen:
un barrido entero es un paso de undo, no doscientos.

**Grabar tocando.** El beat de una nota salía del último frame de medidores
(hasta 46 ms de error repartido al azar); ahora sale del `timeStamp` del evento
contra `beatAt(t)`. Rejilla elegible, sin cuantizar incluido. Y volcado al
patrón al cerrar CADA vuelta del loop, partiendo las teclas que sigan pulsadas.

**El micro entra en el kernel.** El nodo tenía `numberOfInputs: 0`. Ahora tiene
entrada y `setLiveInput` la suma a una pista ANTES de sus inserts — el monitor
suena con la cadena puesta, que es lo único que lo hace útil. Escuchar (medir) y
monitorizar (oírse) son dos interruptores: ajustar la ganancia no puede
obligarte a montar un acople.

**Y la toma se graba en crudo.** `MediaRecorder` en este Electron solo sabe
webm/opus: cada toma se comprimía con pérdida y se volvía a decodificar para
escribirla como un WAV de 24 bits que ya no los tenía. Ahora las muestras
vuelven del kernel tal cual.

**La cuenta atrás suena.** El metrónomo del kernel solo clica rodando, así que
grabar desde el compás 1 enseñaba el conteo sin sonar. La cuenta la lleva ahora
el kernel, y un beat después del último clic arranca él mismo el transporte: la
cuenta y el compás 1 comparten reloj.

**Fuera, con motivo escrito**: la rueda de tono como TONO (pide reafinar voces
vivas y de los diez instrumentos no todos saben hacerlo; a medias se notaría en
unos sonidos sí y en otros no) y las entradas de más de dos canales (la del
kernel es estéreo fija). 1261 tests.

> El detalle de las versiones entre la v1.0 y la v2.9 está en
> [FEATURES.md](FEATURES.md) y en el historial del README.

## Estado anterior — 17-08-2026: v1.0.0


v1.0, "el estudio completo". Cinco bloques cerrados de una tacada, con el
trabajo repartido en agentes en paralelo sobre archivos exclusivos y los
commits granulares de siempre.

**Orbit Nova** — el instrumento de presets (el equivalente de FLEX): 26 sonidos
en 8 categorías, cada preset una pila de capas sobre los motores que ya
existían (nada de samples: el canal guarda el id y sus macros), 8 perillas
fijas y 2 macros que toman su nombre del preset, con su browser dentro.

**Paridad FL** — compases variables y tempo por marcador (mapas en el
compilador y un índice por mapa en el kernel que avanza *y* retrocede),
historial de undo navegable que no rompe el undo por origen, herramientas
Pincel/Cortar (P·B·C), riff machine determinista por semilla (Alt+G), graph
editor de velocity, randomizar/humanizar, filtros de canal y count-in.

**Audio pro** — pitch-shift de clips sobre el mismo motor SOLA del
time-stretch, afinador de tomas por PSOLA con escala, detección de transientes
y troceado, convolución particionada no uniforme con IR sintética, vinyl/lo-fi
determinista, carriles de toma (comping) y congelar/descongelar pista.

**Instrumentos y librería** — Orbit Vox (formantes) y Orbit Slicer, plugins JS
de instrumento de punta a punta, browser con filtros combinables, favoritos y
colecciones, volumen de preview y detección automática de BPM y tonalidad al
indexar, y plantillas de proyecto (trap, boom bap, reggaetón, voz sobre beat).

**Estudio y entrega** — layouts de ventanas (tres predefinidos + los del
proyecto), escala de UI 80–150 % con su shim de coordenadas, fuentes y radios,
tema exportable a archivo, Ctrl+E, export de la selección, info del proyecto,
colaboración con modo seguidor, chat anclado al timeline y permisos por rol, y
el asistente de mezcla de Claude (`advise_mix`).

De regalo, dos bugs viejos que salieron por el camino: el reverb metía 250 ms
de retardo con predelay 0 (leía el anillo antes de escribirlo) y `add_channel`
del bridge rechazaba instrumentos que su propio esquema anunciaba.

**Fuera, con motivo escrito**: OGG (en este Electron `MediaRecorder` no admite
contenedor Ogg y grabaría en tiempo real; haría falta un encoder Opus propio),
puente CLAP/VST3 (necesita host nativo con GUI embebida) y galería de plugins
de la comunidad (necesita backend). 280 tests.

## Estado anterior — v0.9.0

v0.9, "cierra la pista": **consolidar a audio** (render de los clips de una
pista por la cadena de mixer completa → un clip de audio en su sitio, con el
WAV en userData/recordings y todo en un undo), **grabar la salida de una pista**
del mixer en vivo mediante un tap post-fader en el kernel, **EQ de 3 bandas y
separación estéreo por pista** (automatizables y con LFO) y **altura
arrastrable e icono** por pista de playlist. 145 tests.

## Estado anterior — v0.8.0

v0.8, "la mezcla se mueve sola": **LFO por parámetro** (5 formas, velocidad en
beats, cantidad bipolar y fase; oscila sobre el valor actual y sobre la curva
automatizada si la hay, con la fase derivada de la posición de la canción para
que el export salga idéntico al directo), **menú de automatización en cada
perilla y fader** (crear su clip o colgarle un LFO sin buscar el destino en tres
desplegables) y **grabación de movimientos de perillas** en vivo: al parar,
cada mando movido cae como clip con la curva simplificada por Douglas-Peucker,
todo en un solo undo. 137 tests.

## Estado anterior — v0.7.0

v0.6, "backlog fino + paridad FL": FLAC con encoder propio, sample rates y cola
configurables en el export, snap magnético y bloqueo a escala, atajos FL del
piano roll, menú de canal en el rack, espectro y curva RBJ dentro del EQ, RMS
por strip, color por pista, BPM decimal y compás editable, fix del metrónomo,
**ventanas desacoplables** y toolbar rehecha con modo Zen. v0.7, "el horizonte":
**time-stretch** de clips por SOLA en el kernel, **SDK de plugins JS** de
usuario (carpeta propia, sandbox con bypass, también en el export) y **vista
Live por escenas** (F8) con lanzamiento cuantizado con precisión de sample.

## Estado anterior — v0.5.0

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

Backlog tras v1.0 (detalle en [FEATURES.md](FEATURES.md)): graph editor del
rack por nodos, pre-count visual, agrupación de canales por carpetas, slice por
transientes dentro del Slicer, packs de sonidos generados por Claude, y el
horizonte v1+: puente CLAP/VST3, galería de plugins de la comunidad, streaming
de audio de la sesión y multi-ventana real.

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
