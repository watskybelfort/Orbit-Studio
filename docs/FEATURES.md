# Catálogo de funciones — Orbit Studio

Guía completa de todo lo que tiene (y tendrá) Orbit Studio. Basado en el flujo de
FL Studio, ampliado con lo nuestro: colaboración en tiempo real, Claude integrado
y el sistema de temas acrílicos. Leyenda: **v0.1** a **v1.0** = ya publicado en
esa versión · **v0.x** = pendiente tras el release · **v1+** = horizonte.

> Actualizado al estado REAL del código tras el QA de v1.0 (17-08-2026): lo que
> lleva número de versión está implementado y probado; lo que sigue en v0.x
> existe a veces ya en el modelo o el motor, pero no tiene UI todavía.

---

## 1. Transport y proyecto

| Función | Versión |
|---|---|
| Play / Stop, modo PAT (patrón) y SONG (canción), tecla L | v0.1 |
| BPM 20–999 (scrubber de arrastre) | v0.1 |
| Pause (conserva la posición; play reanuda desde el caret) y tap tempo | v0.5 |
| BPM con decimales (arrastre entero, Shift o teclado para décimas) | v0.6 |
| Compás editable (num/den) en la barra de transporte | v0.6 |
| **Compases variables y cambios de tempo por marcador**: el kernel sigue los mapas y la regla dibuja cada compás con su medida | v1.0 |
| Metrónomo (click sintetizado en el kernel) | v0.1 |
| Metrónomo AUDIBLE con acento según el compás (fix: antes no disparaba nunca) | v0.6 |
| Count-in de 1 o 2 compases con metrónomo antes de grabar (la toma entra exacta en el caret) | v1.0 |
| Loop de reproducción (región desde la regla de la playlist) | v0.1 |
| Swing global (perilla como FL) | v0.1 |
| Undo/redo por origen (500 niveles, fusión de ráfagas de perilla) | v0.1 |
| **Historial de undo navegable**: panel con quién hizo qué y salto a cualquier punto, sin romper el undo por origen | v1.0 |
| Autosave por minuto + anillo de 5 backups + recuperación tras crash | v0.2 |
| Formato `.orbit` (JSON versionado), abrir/guardar/guardar como (Ctrl+O/S) | v0.1 |
| Import MIDI (Archivo → Importar: canales + patrón + tempo, en un undo) | v0.4 |
| Info del proyecto: título, autor, notas y recuento de todo lo que hay dentro | v1.0 |

## 2. Channel Rack

| Función | Versión |
|---|---|
| Canales ilimitados: sintes internos o sampler | v0.1 |
| Step sequencer 16/32/64 pasos, pintado con arrastre, clic der = quitar | v0.1 |
| Velocity por paso visible en el rack (se edita en el carril del Piano Roll) | v0.1 |
| **Graph editor de velocity** en el propio rack (arrastre continuo; el derecho devuelve al valor normal) | v1.0 |
| Mute + solo (Ctrl+clic), volumen y pan por canal | v0.1 |
| Selector de patrones (◀▶, añadir, renombrar, color) | v0.1 |
| Clonar patrón (notas incluidas, ⧉ en la cabecera) | v0.6 |
| ▶ propio del rack: escuchar SOLO el patrón activo | v0.6 |
| Menú de canal (clic derecho): llenar cada 2/4/todos, vaciar, renombrar, color, borrar | v0.6 |
| Filas y pasos más grandes y aireados (pase visual) | v0.6 |
| Asignación de canal → pista de mixer (número como FL) | v0.1 |
| Mini-preview de melodía que abre el Piano Roll (doble clic también) | v0.1 |
| Mantener pulsado el icono = escuchar el canal | v0.1 |
| Filtros de canal (Todos, Drums, 808/Bajos, Melódicos, Sampler, Voces) + buscador | v1.0 |
| Randomizar y humanizar pasos desde el menú del canal, en un solo undo | v1.0 |

## 3. Piano Roll

| Función | Versión |
|---|---|
| Dibujar, borrar, mover, redimensionar por bordes, drag multi-nota | v0.1 |
| Selección marquee (Ctrl+arrastre), Ctrl+A, duplicar (Ctrl+B), Supr | v0.1 |
| Herramientas **Dibujar / Pincel / Cortar** (P, B, C), con el pincel borrando en arrastre con el botón derecho | v1.0 |
| Velocity por nota (carril inferior) | v0.1 |
| Pan por nota (carril inferior conmutable Vel/Pan) | v0.3 |
| **Slide notes** (glide real del 808, como FL) | v0.1 |
| Snap: línea, 1/1, 1/2, 1/3, 1/4, 1/6, 1/8, ninguno | v0.1 |
| Snap magnético (libre, se pega a la rejilla solo cerca de la línea) | v0.6 |
| Escala resaltada (tónica + 10 modos) | v0.1 |
| Bloqueo a escala al dibujar y mover (botón Bloq) | v0.6 |
| Ghost notes de otros canales del patrón | v0.1 |
| Toggle de ghost notes + selector de patrón en la toolbar | v0.6 |
| Mover selección contra el borde conserva posiciones (clamp de grupo) | v0.6 |
| Zoom H (Ctrl+rueda) + scroll, preview audible al arrastrar | v0.1 |
| Minimapa clicable (vista completa del patrón + viewport) | v0.3 |
| Herramientas: Quantize, Transponer ±octava | v0.1 |
| Herramientas: Arpegiar, Strum, Humanize, Chop (sobre la selección o todo) | v0.3 |
| Atajos FL de herramientas: Alt+A/S/U/R, Ctrl+Q, Ctrl+Shift+↑↓ | v0.6 |
| Stamp de acordes (mayor, menor, 7ªs, sus4, power, octava) | v0.6 |
| **Riff machine** (Alt+G): motivos sobre la escala, deterministas por semilla, con densidad, rango y carácter | v1.0 |
| Tocar en vivo con controlador MIDI o el teclado del PC (filas Z y Q) | v0.5 |
| Grabación MIDI armada al patrón (cuantización de inicios a 1/16, un undo) | v0.5 |

## 4. Playlist

| Función | Versión |
|---|---|
| Pistas ilimitadas con nombre y mute, + Pista | v0.1 |
| Clips de patrón: pintar en serie, mover, redimensionar, duplicar (Ctrl+arrastre) | v0.1 |
| Clips de automatización (con su curva dibujada; doble clic abre el editor) | v0.1 |
| Clips de audio (soltar un sonido del browser en la playlist) | v0.2 |
| Snap Beat/Compás/1/2/1/4/Nada (Alt = libre) | v0.1 |
| Cortar clips (Shift+clic) y mute por clip (clic central) | v0.5 |
| Marcadores de sección: crear (doble clic en la regla), renombrar, borrar, salto exacto | v0.2 |
| Seek y región de loop desde la regla | v0.1 |
| Export del loop de la playlist (fuente Loop en el ExportPanel) | v0.5 |
| Cambiar entre **arrangements** | v0.1 |
| Crear (+, con sus pistas base) y renombrar arrangements desde la toolbar | v0.5 |
| Color editable por pista (swatch en la cabecera) | v0.6 |
| Altura de pista arrastrable (doble clic en el tirador la resetea) e icono por familia de sonido | v0.9 |
| Mini-preview de las notas dentro de cada clip | v0.1 |
| **Consolidar a audio (bounce)**: los clips de la pista se renderizan CON sus efectos y quedan como un solo clip de audio, en un undo | v0.9 |
| **Vista Live por escenas** (F8): pads por patrón, lanzamiento cuantizado al cierre del loop | v0.7 |
| **Carriles de toma (comping)**: las tomas se apilan en la pista y el clic central elige la buena | v1.0 |

## 5. Mixer

| Función | Versión |
|---|---|
| 25 pistas de insert + Master, nombre por pista | v0.1 |
| Fader en dB reales, pan, mute/solo | v0.1 |
| Separación estéreo en el panel de la pista (perilla Width, automatizable) | v0.9 |
| **10 slots de efectos** por pista con on/off y dry/wet por slot | v0.1 |
| Editor de parámetros de cada efecto inline (perillas por parámetro) | v0.1 |
| Routing libre pista→pista (clic derecho, "enrutar aquí") | v0.1 |
| Sends (Ctrl+clic) | v0.1 |
| Nivel ajustable por send (perilla + quitar, en la cadena de la pista) | v0.3 |
| Sidechain (cualquier pista como fuente del compresor de otra) | v0.1 |
| Medidores peak por strip + master | v0.1 |
| Línea de RMS en el master + LED de clip enclavado (clic = reset) | v0.3 |
| Línea de RMS en TODOS los strips (medición por pista en el kernel) | v0.6 |
| **Cadena vocal de un clic** (EQ + compresor + saturación + delay 1/4 + reverb) | v0.5 |
| Color editable por pista (clic en el chip de color) | v0.6 |
| **EQ rápido de 3 bandas** por pista (120 Hz shelf · 1 kHz campana · 6 kHz shelf), post-efectos y pre-fader; plano no toca el audio | v0.9 |
| **Grabar la salida de una pista** (post-fader) mientras suena → WAV + clip en la playlist, en un undo | v0.9 |

## 6. Instrumentos incluidos

| Instrumento | Qué es | Versión |
|---|---|---|
| **Orbit Sub** | 808/sub: sine + drive + glide + punch, afinable al kick | v0.1 |
| **Orbit Synth** | Sustractivo: saw/square/tri/sine, SVF, 2 ADSR, unison hasta 5 voces | v0.1 |
| **Orbit Saw** | Supersaw 7 osciladores con detune/blend y pan spread | v0.1 |
| **Orbit FM** | FM 2-op (bells, keys, bajos metálicos) | v0.1 |
| **Orbit Drums** | Caja de ritmos sintetizada, 3 kits: kick, snare, clap, hats, tom, conga, rim, shaker, crash | v0.1 |
| **Orbit Sampler** | Reproduce WAV con pitch, keytrack, punto de inicio y reverse | v0.1 |
| **Orbit Keys** | Cubierto por los presets de teclas de Orbit Nova (Rhodes, EP oscuro, piano lo-fi, clavi) | v1.0 |
| **Pack Instrumentos** | 24 instrumentos con altura por síntesis (pianos, EPs, guitarras Karplus-Strong, bajos, órganos, pads, campanas, leads — 3-4 variantes por familia), tocables por nota vía sampler + keytrack | v0.5 |
| **Orbit Nova** | Instrumento de presets (estilo FLEX): 26 sonidos en 8 categorías con capas de síntesis, 8 perillas y 2 macros por preset, con su browser | v1.0 |
| **Orbit Slicer** | Trocea un sample en N partes y dispara una por nota desde C3 | v1.0 |
| **Orbit Vox** | Voz sintética por formantes (A/E/I/O/U) con soplo y vibrato | v1.0 |

## 7. Efectos incluidos (14 tipos en v0.1)

| Efecto | Versión |
|---|---|
| EQ paramétrico (HP, low shelf, peak con Q, high shelf, LP — biquads RBJ) | v0.1 |
| Espectro en vivo + curva de respuesta real dentro del EQ | v0.6 |
| Compresor (threshold, ratio, attack, release, knee, makeup) | v0.1 |
| **Compresor sidechain** (fuente = otra pista del mixer) | v0.1 |
| Limiter lookahead (para el master) | v0.1 |
| Reverb (size, damp, width, pre-delay) | v0.1 |
| Delay estéreo (sync 1/32–1/2 con puntillos, ping-pong, feedback filtrado) | v0.1 |
| Chorus / Flanger / Phaser | v0.1 |
| Distorsión (soft/hard/fold) + Bitcrusher | v0.1 |
| Auto-filter (filtro con envolvente y LFO) | v0.1 |
| Gate | v0.1 |
| Utilidades estéreo: width, gain, mono-maker (low-end mono) | v0.1 |
| Medidor LUFS + análisis de mezcla (offline, en el export y `analyze_mix`) | v0.1 |
| **Orbit Scope** en tiempo real: forma de onda + espectro del master (Ver → Orbit Scope) | v0.3 |
| **Orbit Vinyl**: crujido, siseo con rumble y wow/flutter (33⅓ rpm), determinista | v1.0 |
| Pitch shifter / vocoder | v1+ |
| **Orbit Convolver**: convolución particionada no uniforme con IR sintética (size, decay, damp, predelay, width) | v1.0 |

## 8. Automatización

| Función | Versión |
|---|---|
| Clips de automatización con puntos y **tensión de curva** arrastrable | v0.1 |
| Destinos: canal (síntesis y mezcla), mixer, parámetro de efecto, tempo, swing | v0.1 |
| Valores reales mostrados en vivo (dB, Hz, %…) al editar la curva | v0.1 |
| "Último parámetro tocado" → crear su clip desde la propia perilla (clic derecho) o desde la paleta | v0.8 |
| **LFO por parámetro**: 5 formas, velocidad en beats (1/16 a 8 compases), cantidad bipolar y fase | v0.8 |
| El LFO oscila sobre el valor actual — si hay automatización en el mismo destino, ondula sobre la curva | v0.8 |
| Panel de LFOs: on/off por LFO y recorrido real del parámetro ("0.50 → 1.50") | v0.8 |
| **Grabación de movimientos de perillas** en vivo → clips con la curva simplificada, en un solo undo | v0.8 |

## 9. Browser y librería de sonidos

| Función | Versión |
|---|---|
| Árbol por categorías: Drums, 808s, Percusión latina, Melódicos, FX | v0.1 |
| Tags por género/mood/tonalidad/BPM en manifest JSON | v0.1 |
| Búsqueda instantánea (nombre, tags, subcategoría; ignora acentos) | v0.1 |
| **Filtros combinables** por género/tag, tonalidad y rango de BPM, con facetas sacadas del catálogo real | v1.0 |
| Preview al clic (renderizado por el propio kernel) | v0.1 |
| Volumen de preview ajustable (persistente) | v1.0 |
| Doble clic = añade canal sampler con el sonido | v0.1 |
| Drag & drop: al Channel Rack (canal sampler) o a la Playlist (clip de audio) | v0.2 |
| Contenido de fábrica generado por síntesis propia (pack Orbit Essentials, 60 sonidos) | v0.1 |
| Carpetas del usuario (elige carpetas propias; se escanean y funcionan igual) | v0.5 |
| **Favoritos y colecciones** con nombre, guardados en los ajustes | v1.0 |
| **Detección automática de BPM y tonalidad** al indexar (141/141 tempos sintéticos ±2 BPM; 39/40 tonalidades del pack) | v1.0 |

## 10. Grabación y edición de audio

| Función | Versión |
|---|---|
| Clips de audio en playlist (drop desde el browser; samples rehidratados al abrir) | v0.2 |
| Grabación de micro a la playlist (botón en el transport; toma → WAV + clip) | v0.4 |
| Editor de audio estilo Edison: recorte por asas, ganancia, normalizar, reverse, fades | v0.4 |
| Time-stretch de clips (SOLA por grains, pitch intacto, toggle Stretch) | v0.7 |
| **Afinador de tomas** (PSOLA): lleva cada nota a la más cercana o a una escala, con fuerza y transposición | v1.0 |
| **Pitch-shift de clips** (semitonos, sin tocar la duración; se combina con el time-stretch) | v1.0 |
| **Detección de transientes** y troceado del clip en un solo undo | v1.0 |

## 11. Export / render

| Función | Versión |
|---|---|
| WAV 16/24/32-bit float | v0.1 |
| Selector de sample rate (44.1–96 kHz) | v0.6 |
| Render offline (más rápido que tiempo real, mismo kernel DSP) | v0.1 |
| **Stems** (un WAV por pista de mixer usada, en un solo pase) | v0.1 |
| Tail de reverb/delay (2 s en el motor) | v0.1 |
| Tail configurable desde la UI (0–8 s) | v0.6 |
| Normalización a **-14 LUFS** opcional (flujo streaming Orbit) | v0.1 |
| Fuente: canción completa o patrón | v0.1 |
| Export de la selección de playlist / solo el loop | v0.x |
| MP3 a 192 kbps junto al WAV | v0.5 |
| FLAC sin pérdida (codificador propio: FIXED + Rice, bit-exacto vs ffmpeg) | v0.6 |
| OGG | v1+ |
| Export MIDI multipista junto al WAV (flujo FL de Orbit: .mid + wav) | v0.2 |

## 12. Colaboración en tiempo real

| Función | Versión |
|---|---|
| Sesión compartida por **código de room** (crear/unirse, 6 caracteres) | v0.1 |
| Edición simultánea sin conflictos (CRDT Yjs, log de comandos) | v0.1 |
| Reconexión automática con backoff | v0.1 |
| Lista de conectados con nombre y color | v0.1 |
| Cursores remotos en playlist y piano roll (caret con nombre y color) | v0.3 |
| "Está editando X" en el panel (Playlist, Piano Roll · canal, Mixer · pista…) | v0.3 |
| Undo **por usuario** (tu Ctrl+Z no deshace lo del otro) | v0.1 |
| Servidor propio (`apps/server`) con persistencia de sesiones y /health | v0.1 |
| **Modo seguidor**: tu vista sigue la de otro (editor, patrón, canal, caret) | v1.0 |
| **Chat de sesión** por el mismo documento Yjs, con notas ancladas a un compás | v1.0 |
| **Permisos por rol** (productor / invitado / oyente) aplicados en el log de comandos | v1.0 |
| Audio streaming de la sesión (escuchar el master remoto) | v1+ |

## 13. Claude integrado

| Función | Versión |
|---|---|
| Servidor **MCP** expuesto por la app (`.mcp.json` en el repo, stdio→WS) | v0.1 |
| **20 tools**: proyecto, notas, canales, steps, patrones, clips, tempo/swing, mixer, efectos, automatización, render, análisis, consejo de mezcla, undo/redo | v0.1 |
| Todas sus ediciones pasan por el bus de comandos → undo separado del tuyo | v0.1 |
| **Panel de Claude**: feed de actividad en vivo (qué tocó, con qué resultado) | v0.1 |
| Análisis de mezcla (`analyze_mix`: LUFS, peak, balance por bandas, correlación) | v0.1 |
| Claude en la lista de presencia de la sesión (fila propia bajo su usuario) | v0.3 |
| Campo de petición en el panel (viaja adjunta al siguiente get_project de Claude) | v0.5 |
| **Asistente de mezcla** (`advise_mix`): diagnóstico por tilts de banda, LUFS y fase, con cadena propuesta y opción de aplicarla | v1.0 |
| Claude genera contenido a la librería (packs a demanda) | v0.x |

## 14. Apariencia y temas

| Función | Versión |
|---|---|
| Tema **oscuro** (defecto) y **claro** | v0.1 |
| Tema **acrílico**: blur real del escritorio (DWM `backgroundMaterial`) | v0.1 |
| Controles de ventana estilo Windows o **semáforo macOS** (opción) | v0.1 |
| Customizador: acento (paleta + picker), transparencia y tinte del vidrio | v0.1 |
| Guardar/borrar temas custom con nombre (persisten en settings) | v0.1 |
| Exportar/importar tema como archivo | v0.x |
| Iconografía SVG propia minimalista estilo Mac (26 iconos) | v0.1 |
| Escala de UI (zoom global) | v0.x |
| Fuentes y radios configurables | v0.x |

## 15. Sistema de ventanas y atajos

| Función | Versión |
|---|---|
| Ventanas internas movibles/redimensionables/cerrables con z-order (como FL) | v0.1 |
| **Ventanas desacoplables**: sacar cualquier editor a una ventana nativa del OS | v0.6 |
| Toolbar con play PAT/SONG directos y botones de todas las ventanas | v0.6 |
| Modo compacto Zen (oculta librería y paneles de un clic) | v0.6 |
| **Layouts de ventanas**: tres predefinidos (Componer, Mezclar, Arreglar) y los que guardes en el proyecto | v1.0 |
| Ventana de LFOs (toolbar, menú Ver y paleta) | v0.8 |
| Botón de grabación de perillas en el transporte (armar / capturando) | v0.8 |
| F5 Playlist · F6 Channel Rack · F7 Piano Roll · F9 Mixer · F10 Ajustes | v0.1 |
| Space play/stop · L pat/song · Ctrl+Z/Y · Ctrl+O · Ctrl+S/Ctrl+Shift+S | v0.1 |
| P / B / C herramientas del piano roll · Alt+G riff machine | v1.0 |
| Ctrl+B duplicar y Ctrl+A seleccionar (en el Piano Roll) | v0.1 |
| Ctrl+E export directo | v0.x |
| Paleta de comandos (Ctrl+K): búsqueda sin acentos, grupos, teclado completo | v0.5 |
| Multi-ventana (mixer en segundo monitor) | v1+ |

## 16. Plugins de terceros

| Función | Versión |
|---|---|
| **SDK de plugins JS** (efectos): carpeta de usuario, perillas propias, sandbox del worklet con bypass anti-crash, en vivo y en el export (docs/PLUGINS.md) | v0.7 |
| **Plugins JS de instrumento** (`createInstrument`): canal propio en el rack, con bypass si falla | v1.0 |
| Galería de plugins de la comunidad en el browser | v1+ |
| Puente CLAP / VST3 vía proceso host nativo (necesita host nativo con GUI embebida: proyecto aparte) | v1+ |

## 17. Rendimiento y fiabilidad

| Función | Versión |
|---|---|
| Kernel DSP en un solo AudioWorklet, cero GC en el audio thread | v0.1 |
| Medidor de CPU en la barra de transporte (aviso por color al cargarse) | v0.2 |
| Proyecto de 100 pistas sin dropouts (objetivo QA) | v0.1 |
| Golden tests del DSP (render determinista) — 145 tests en total | v0.1 |
| Autosave + crash recovery (banner Recuperar/Descartar al reabrir) | v0.2 |
