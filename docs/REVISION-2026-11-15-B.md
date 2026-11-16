# Revisión — 15-11-2026 (segunda pasada)

Continuación de [REVISION-2026-11-15.md](REVISION-2026-11-15.md). La primera
pasada dejó catorce abiertos; esta arranca por ellos y sigue con una segunda
vuelta completa sobre las mismas siete lanes —core, motor, editores,
estado/shell, colaboración/servidor/escritorio, puente/librería y el flujo de
grabación de voz— más un barrido de código muerto. **No se actualizó el golden**:
los cambios de sonido que habría que aceptar con el oído siguen en «Abiertos».

## Estado de la red

- `npm run typecheck` — limpio.
- `npm run lint` (ESLint + `lint:css`) — limpio.
- `npm run test` — **314 archivos / 3772 tests** en verde (incluye el golden: 25
  renders + 2 flujos Opus, línea base bit a bit sin tocar).
- `npm run build` — verde.

Las 3772 pruebas se midieron con el árbol de este documento. El punto de
partida eran las mismas 314 archivos / 3722 tests de la primera pasada; las 50
nuevas son las de esta.

## Lo que se corrigió

### Core

| Hallazgo | Corrección | Prueba |
|---|---|---|
| **Crítico**: `parseProject` rechazaba cualquier `.orbit` con un layout guardado — validaba `layouts` a un solo nivel y el mapa real es de dos (nombre → ventana → rect) — así que **guardar un layout dejaba el proyecto imposible de reabrir** | Validación a dos niveles: cada ventana con `x/y/w/h` numéricos | `core-audit-2026-11` (ida y vuelta de un proyecto con layout) |
| Los `restore*` de LFO y de secciones no comprobaban ids repetidos: un undo podía duplicar el orden | `assertIdsNuevos` en las dos restauraciones | idem |
| `patchMixerTrack({slots})` y `patchPattern({notes})` atravesaban la puerta: son campos que solo se cambian con su comando, y el patch los dejaba escribir a mano | `NO_PARCEABLES` en `entity-schema` | idem |
| `normalizeKeymap`/`normalizeSlicePoints` reventaban con un valor que no era lista (`keymap: 3` en un proyecto importado) | Se descarta y se normaliza a vacío | idem |
| `normalizeProjectInputRoutes` alocaba un pool por llamada | `nullPool` | idem |
| Un listener roto del bus tumbaba a los demás del mismo `emit` | `try/catch` por listener con aviso | idem |
| `insertIndex` no normalizaba: un `NaN`/negativo dejaba el canal o el patrón en un lugar arbitrario | Normalizado en `addChannel`, `addPattern` y `moveChannel` | idem |
| `addChannelGroup` aceptaba canales que ya estaban en un grupo (doble pertenencia) | Se rechaza con error explícito | idem |
| `findParamSpec` se rompía con `undefined` | Lo tolera | idem |

### Motor

| Hallazgo | Corrección | Prueba |
|---|---|---|
| **`tempo` ≤ 0, `NaN` o `Infinity` congelaba el transporte** | `safeTempo`: si el valor no es finito o no es positivo, cae a 120 | suite de motor |
| Robo de voces a base de `splice`: clic y una alocación en el hilo de audio | `removeVoiceAt` (compactación en orden, sin objeto nuevo) + `noteOff` de la voz robada + tope duro de voces | suite de motor + linter |
| `splice` no estaba en la lista de métodos que alocan del linter | Añadido a `ALLOCATING_METHODS` | `no-audio-thread-alloc` |
| `process()` no acotaba `n`: un bloque mayor que `MAX_BLOCK` escribía fuera del buffer preasignado | Acotado a `MAX_BLOCK` | suite de motor |
| `topoOrder` con un ciclo podía dejar el master antes que sus fuentes | El master cierra siempre el orden | suite de motor |
| `Allpass1.set` recalculaba el coeficiente suavizado en cada llamada | Se cachea | suite de motor |
| `clickDecay`/`ciDecay` se recalculaban por muestra | Precalculados | golden de metrónomo |
| El slide de 808 creaba una voz nueva cada vez | Reusa la ÚLTIMA voz | suite de motor |

El robo de voces se compacta **en orden** a propósito: reordenar las sumas mueve
el hash del golden y este documento no acepta cambios de sonido. Se probó y se
descartó.

### Editores

| Hallazgo | Corrección | Prueba |
|---|---|---|
| La marquesina de la Playlist seleccionaba **por fila**: con tomas apiladas se llevaba carriles de otras tomas | `laneBand` en `take-stack`: el rectángulo se recorta al carril bajo el puntero | `take-stack` |
| Ctrl+A y Ctrl+B de la Playlist actuaban con el Piano Roll enfocado | Exigen `activeEditTarget() === 'playlist'` | `ui` (lectura de fuente) |
| La selección del Piano Roll sobrevivía al cambio de patrón o de canal y borraba notas de otro | Se poda al cambiar de patrón/canal; Escape la suelta; Alt/Ctrl+Q exigen hover | `ui` |
| El Piano Roll y su minimapa no se recompaginaban al cambiar el tamaño del panel | `ResizeObserver` en los dos | `ui` |
| El hit-test de notas usaba la geometría del modelo, no el rectángulo dibujado: se erraba el clic en los bordes | Contra el rectángulo dibujado | `ui` |
| `scrollY` de la Playlist podía quedar más allá del final y dejar la vista en blanco | Acotado | `ui` |
| El clic derecho en el carril de velocity armaba el gesto y cambiaba la velocity antes del menú | Ignorado en el gesto | `ui` |
| El clic derecho sobre el asa de altura la movía | Ignorado | `ui` |
| Pintar en serie sin carril escribía en el carril `-1` | `lane ?? 0` | `ui` |
| Trocear un clip de audio no repartía los fundidos: la cabeza quedaba con el fade de cola | Fade de cabeza y de cola por pieza | `ui` |
| Recortar por la izquierda no movía `start` | `trimStartShift` | `ui` |
| El cursor `ew-resize` aparecía en todo el clip, no solo en las asas | Solo en las asas | CSS |
| Seleccionar texto dentro del Piano Roll con un arrastre | `user-select: none` | CSS |
| El asa de altura se salía del borde superior del clip | Pegada al borde | CSS |

### Shell y estado

| Hallazgo | Corrección | Prueba |
|---|---|---|
| **Arranque a 1280×720 al 150 %**: Rack y Playlist se solapaban en el primer segundo | `applyStartupLayout()` mide el área real y coloca lado a lado o apilado; si no cabe, abre solo Arreglo con aviso | `layouts-panel-area` (con el chrome real) |
| El «Acerca de» era un `div` con `role=dialog`: sin foco atrapado ni Escape nativo | `<dialog>` nativo | `ui-audit-fixes` |
| `clampResize` dejaba una ventana de 0 px o fuera de pantalla | Acotado a un mínimo y dentro del área | `window-bounds` |
| `forgetWorkspace` no cancelaba el guardado en vuelo: una escritura tardía resucitaba el espacio olvidado | Se cancela | `workspace-memory` |
| Mantener Espacio alternaba play/stop en bucle (el repeat del teclado) | Solo el primer `keydown` | `shortcut-space` |
| `SettingsPanel` montaba las cinco secciones aunque solo se viera una | Monta la visible | `ui` |
| El aviso de layout no se iba nunca y su botón vivía dentro de la región viva (se reanunciaba) | Se autodescarta a los 8 s; el botón sale de la región viva | `ui` |

### Colaboración, servidor y escritorio

| Hallazgo | Corrección | Prueba |
|---|---|---|
| Un mensaje de control o de audio gigante se decodificaba **antes** de mirar el tipo | Topes por tipo antes de decodificar (`MAX_CONTROL_BYTES`, `MAX_AUDIO_MESSAGE_BYTES`) | suite de servidor |
| El rol se perdía al reconectar: un invitado volvía como oyente | `sessionRoles` por `sid`, y se reemite el token al cambiar de rol | `session-control` |
| El documento de sala se guardaba en cada mensaje | Debounce de 1,5 s | suite de servidor |
| `handleRevokeInvite` corría fuera de `withInviteLock` | Dentro del candado | suite de servidor |
| `sessionRoles`/`sessionClients` y `inviteLocks` crecían sin poda | Se podan al cerrar y al vencer | suite de servidor |
| El escritorio abría ventanas hijas de cualquier `orbit-*` que pidiera un renderer | Lista blanca de las conocidas; el resto se deniega | suite de escritorio |
| `discovery` dejaba el `beaconTimer` vivo tras un error del socket | Se limpia | suite de escritorio |

### Puente y librería

| Hallazgo | Corrección | Prueba |
|---|---|---|
| `advise_mix`/`analyze_mix` usaban `gainToTarget` (un delta) como si fuera un objetivo: el consejo de LUFS salía desplazado | `objetivo − LUFS` | `mix-advisor` |
| Con una mezcla en silencio el consejo era «sube 40 dB» | Se rechaza con un mensaje que lo dice | idem |
| `advise_mix apply` con un efecto ya existente dejaba los defaults del efecto viejo mezclados con el plan nuevo | Reescribe defaults + plan | idem |
| `list_library` no imprimía el `id`, así que no se podía pedir el sonido que listaba | Imprime `id=` | `pack-recipes` |
| El mensaje de ambigüedad de nombre no listaba los ids | Los incluye | idem |
| Dos tools a la vez por la misma conexión del `ws-host` se pisaban | Serializadas por conexión | suite del puente |
| `slugifyName` podía pasar de 64 caracteres y romper el nombre de archivo | Recorta a 64 | `pack-recipes` |
| `generate_pack` renderizaba los 400 sonidos y **después** miraba el presupuesto: 56 MB de RAM para tirarlos | `PACK_BYTE_BUDGET` (56 MB) recorta los últimos antes de renderizar | `pack-recipes` |
| Las fuentes corruptas (mojibake) se leían con un `HEX` equivocado en `protocol.ts` y `kernel-core.ts` | Corregido en los dos | suite de motor |

### Grabación de voz

Además de los arreglos de arriba:

- **Diario de toma (crash recovery)**: mientras se graba, cada ~0,5 s se vuelca
  el PCM a `recordings/.diario/` en float32 planar, con un JSON de metadatos
  (proyecto, pista, rutas, loop, inicio). Un apéndice se valida antes de
  escribir y se corta a frames enteros; el archivo se corta a 512 MB y los
  diarios de más de 7 días se purgan al arrancar. Si la app muere a mitad de
  toma, al volver se convierte a WAV, se guarda en `recordings` y —si el
  proyecto es el mismo— se inserta una pista «Toma recuperada» en un solo undo,
  con un aviso que se puede descartar. Un fallo del diario **no** rompe la
  grabación: se avisa y se sigue.
- **Aviso de clipping al guardar**: `capture-peak` mide el pico de la toma; si
  llega a ±1 se avisa al guardar, además del medidor en vivo.
- **Voz fuerza modo Canción**: una toma en modo Patrón no tiene timeline donde
  caer.
- **La captura se corta en el acto al parar** (`setInputCapture(false)`
  inmediato): antes seguía entrando audio mientras se cerraba la sesión y el
  final de la toma llevaba cola de más.
- **El caret fuera del loop se reubica al inicio con aviso**, en vez de grabar
  donde nadie va a escuchar.
- **Deadline duro en `runCountIn`**: una cuenta atrás que no arrancaba no dejaba
  el botón colgado para siempre.
- **La latencia se compensa en TODAS las piezas del loop** (antes solo en la
  primera).
- **El solape se mide contra la unión de segmentos**, no contra el primero: con
  dos tomas encadenadas la segunda se daba por libre.
- **La pista nueva con loop sí crece de altura** al apilar tomas.
- **El nombre de la toma incluye su ruta**, para distinguir dos micros.
- **El menú de tomas muestra `sample.name` y renombra en línea** (sin
  `window.prompt`, que no existe en Electron 43).
- **Borrar la toma activa desmutea la más cercana** y la altura se recalcula
  tras compactar (`takeLaneCountCompact`).
- **Los errores del grabador se ven en `App.tsx`**: antes se perdían en la
  consola.
- **`vocalRoute` ya no secuestra una guitarra armada**: si la ruta armada no es
  de voz, prepara la suya.
- **El export se bloquea mientras `phase !== 'idle'`**: exportar a mitad de toma
  congelaba la app.

### Timeouts de la suite

Tres archivos fallaban de forma intermitente **por reloj, nunca por la
aserción**. Se les puso margen explícito, medido y con el porqué escrito al
lado, siguiendo el precedente de `render-integrity-v1.test.ts` (`292c9c5`) y
`factory-multisample.test.ts`:

| Archivo | En reposo | Bajo la suite | Margen |
|---|---|---|---|
| `sound-library/generate/dinamica.test.ts` | ~6 s (prueba más cara ~1 s) | 5,3 s medido | `vi.setConfig({ testTimeout: 20_000 })` |
| `sound-library/generate/multiroot.test.ts` | ~17 s (prueba más cara ~1,4 s) | 4,7 s medido | ídem |
| `engine/test/engine.test.ts` — «un canal Nova suena…» | 0,8 s | 5,8 s medido | `}, 20_000)` en ese test |

No se subió el timeout global. La amplificación se midió antes de decidir: p50
2 ms, p90 310 ms, p99 1 855 ms, máximo 17 287 ms, y quemar 20–60 procesos de CPU
externos **no** la reproduce —viene del reparto de workers en una máquina de 20
CPU con núcleos P/E, no de carga de fuera. Se comprobó en Vitest 4 que
`vi.setConfig({ testTimeout })` a nivel de módulo aplica a todo el archivo, que
el reporter de timeouts lo ve como el timeout efectivo y que **no** se filtra a
otros archivos del mismo worker (tres archivos scratch, ya borrados).

## Cerrado de la primera pasada

De los catorce abiertos de [REVISION-2026-11-15.md](REVISION-2026-11-15.md),
esta pasada cierra **cuatro**:

- **10. Marquesina por carril** — `laneBand` recorta la selección al carril.
- **11. Una toma en curso no se escribía a disco** — diario + recuperación.
- **12. Aviso de clipping de la toma** — `capture-peak` y aviso al guardar.
- **14. Docs** — este documento y la cabecera de `PLAN.md`.

El **13 (código muerto) sigue abierto** y se amplía con lo que encontró el
barrido de esta pasada: está en el punto 16 de abajo, símbolo por símbolo. No se
borró nada a propósito —casi todo son exportaciones de paquete o campos de tipos
serializados, y quitarlas es un cambio de API que merece su propio commit y su
propio repaso—, y decirlo es más útil que un «limpiado» que no ocurrió.

## Abiertos (documentados, no silenciosos)

Los de la primera pasada que siguen vivos (1–9) más lo que encontró esta:

1. **Escuchar con hardware** y juzgar el golden: esta revisión tampoco toca el
   sonido.
2. **La automatización de `channelParam` es inaudible en las voces internas**
   (Nova, sampler): el kernel lee la perilla al arrancar la nota y no por
   muestra. Arreglarlo pide un camino de parámetros por voz y mueve el golden.
3. **La latencia del limiter (64 muestras) y del convolver (128) no se compensa
   en el export ni en los stems**: el WAV sale corrido ~1,5 ms respecto de lo
   que se oye en vivo.
4. **`mute`/`bypass`/`mix` no tienen rampa**: conmutar en marcha hace clic.
5. **La IR del convolver se reconstruye en el hilo de audio** cuando se toca
   `size`/`decay`/`damp` — ya no se puede automatizar (primera pasada), pero el
   cambio manual sigue costando ~11 ms.
6. **Punch-in/punch-out y playlist de tomas**: hoy se graba sobre el loop
   entero.
7. **Monitor de latencia cero** (el que canta oye su voz con el retardo del
   buffer).
8. **El encode y el hash del WAV van en el hilo de UI**: una toma de diez
   minutos congela la barra un instante.
9. **Los stems renderizados por el master no suman a la mezcla** que se exporta:
   el stem de una pista con envío al master sale sin ese envío.
10. **El cliente de colaboración confía en `entry.role` y `entry.own`** que le
    llegan del servidor: un servidor hostil puede decirle a un cliente que es
    dueño. La autoría real la decide el servidor; el cliente solo la pinta.
11. **La compactación remota no recarga el snapshot**: tras un `compact`, un
    cliente que estuvo desconectado se reengancha con un estado viejo.
12. **El chat y el log del servidor no tienen tope** (el resto de mensajes sí).
13. **No hay rate limit de autenticación**: se puede probar contraseñas a la
    velocidad de la red.
14. **`CollabSession` reusada tras `disconnect()` colisiona claves** (el mapa de
    clientID no se reinicia).
15. **`window.prompt` no existe en Electron 43 (lanza)**: quedan cuatro usos
    fuera de tomas — `default-commands.ts:137`, `Browser.tsx:973`,
    `MenuBar.tsx:461/643`, `SectionLane.tsx:255`.
16. **Código muerto que queda**: `ORBIT_EXTENSION`, `CORE_VERSION`, `ownOf`,
    `BRIDGE_VERSION`, `LIBRARY_VERSION`, `withAnalysis`, `PALETTE_COUNT`,
    `topZ`, `loadAppearanceFromSettings`, `resetEditFocus`, `savePresetAs`,
    `ENGINE_VERSION`, `COLLAB_VERSION`, `isBranchReachable`, `isFollowing`,
    `stopNetwork`, `addAudioClip`, `warmGallery`, `deleteLayout`,
    `CC_MOD_WHEEL`, `scopeOwnerCount`, `getUiScale`, varios iconos sin uso,
    `compensateClipStart`, y `mode`/`bpmConfidence` del análisis que nadie lee.
    Se dejan porque son exportaciones públicas de paquete o campos de un tipo
    serializado, y quitarlas es un cambio de API, no una limpieza.
17. **`routeTo === null`**: el modelo dice «master» y el kernel lo trata como
    silencio. Los tests fijan el comportamiento actual (`sends-shaped-v1`,
    `mixer-solo`), así que se deja como está y se anota aquí.
18. **Rendimiento de la Playlist**: redibujo completo a 60 fps y un `fillRect`
    por píxel de onda.

## Cómo se verificó

- Punto de partida medido antes de tocar nada: **314 archivos / 3722 tests**,
  typecheck y lint limpios, build verde, HEAD `2e18ef0`.
- Cada corrección con lógica pura entró con su test. Las que viven en JSX se
  afirman sobre la fuente con `read-source.ts` (convención del repo) o sobre el
  estado del store sin DOM; las de servidor y escritorio, con peers WebSocket y
  un sistema de archivos reales en `%TEMP%`.
- El diario de toma se probó con un `RecordingJournal` real sobre un directorio
  temporal: apéndice válido, apéndice truncado, tope de tamaño, purga por
  antigüedad y un fallo de escritura que no rompe la grabación.
- El arranque a 1280×720 al 150 % se probó con el chrome real del layout, no con
  un mock.
- El margen de los timeouts se midió: aislado, bajo la suite completa y con el
  reporter de timeouts del repo. Los tres archivos pasan (135/135) y el reporter
  reporta `20000` para `dinamica`.
- El golden se mantiene **bit a bit**: la compactación de voces se reordenó para
  no cambiar el orden de las sumas y 33/33 siguen verdes.
- Lo que no se pudo comprobar: oído/hardware, `pointercancel` real del sistema
  operativo, un segundo monitor para los layouts, y el comportamiento de la app
  tras un crash de verdad (el diario se prueba con el archivo que dejó, no
  matando el proceso a mitad).
