# Catálogo de funciones — Orbit Studio

Guía completa de todo lo que tiene (y tendrá) Orbit Studio. Basado en el flujo de
FL Studio, ampliado con lo nuestro: colaboración en tiempo real, Claude integrado
y el sistema de temas acrílicos. Leyenda: **v0.1** / **v0.2** / **v0.3** = ya
publicado en esa versión · **v0.x** = pendiente tras el release · **v1+** = horizonte.

> Actualizado al estado REAL del código tras el QA de v0.3 (16-08-2026): lo que
> lleva número de versión está implementado y probado; lo que sigue en v0.x
> existe a veces ya en el modelo o el motor, pero no tiene UI todavía.

---

## 1. Transport y proyecto

| Función | Versión |
|---|---|
| Play / Stop, modo PAT (patrón) y SONG (canción), tecla L | v0.1 |
| BPM 20–999 (scrubber de arrastre) | v0.1 |
| Pause, tap tempo, BPM con decimales | v0.x |
| Compases variables y cambios de tempo por marcador (el modelo ya los tiene) | v0.x |
| Metrónomo (click sintetizado en el kernel) | v0.1 |
| Pre-count / count-in de grabación | v0.x |
| Loop de reproducción (región desde la regla de la playlist) | v0.1 |
| Swing global (perilla como FL) | v0.1 |
| Undo/redo por origen (500 niveles, fusión de ráfagas de perilla) | v0.1 |
| Historial de undo navegable | v0.x |
| Autosave por minuto + anillo de 5 backups + recuperación tras crash | v0.2 |
| Formato `.orbit` (JSON versionado), abrir/guardar/guardar como (Ctrl+O/S) | v0.1 |
| Import MIDI (arrastrar .mid al proyecto) | v0.x |
| Info del proyecto (título, autor, notas — el modelo ya lo tiene) | v0.x |

## 2. Channel Rack

| Función | Versión |
|---|---|
| Canales ilimitados: sintes internos o sampler | v0.1 |
| Step sequencer 16/32/64 pasos, pintado con arrastre, clic der = quitar | v0.1 |
| Velocity por paso visible en el rack (se edita en el carril del Piano Roll) | v0.1 |
| Graph editor de velocity en el propio rack | v0.x |
| Mute + solo (Ctrl+clic), volumen y pan por canal | v0.1 |
| Selector de patrones (◀▶, añadir, renombrar, color) | v0.1 |
| Clonar patrón | v0.x |
| Asignación de canal → pista de mixer (número como FL) | v0.1 |
| Mini-preview de melodía que abre el Piano Roll (doble clic también) | v0.1 |
| Mantener pulsado el icono = escuchar el canal | v0.1 |
| Agrupación por filtros (All, Drums, Melódicos…) | v0.x |
| Randomizar/humanizar pasos | v0.x |

## 3. Piano Roll

| Función | Versión |
|---|---|
| Dibujar, borrar, mover, redimensionar por bordes, drag multi-nota | v0.1 |
| Selección marquee (Ctrl+arrastre), Ctrl+A, duplicar (Ctrl+B), Supr | v0.1 |
| Modos de herramienta brush / cortar (slice) | v0.x |
| Velocity por nota (carril inferior) | v0.1 |
| Pan por nota (carril inferior conmutable Vel/Pan) | v0.3 |
| **Slide notes** (glide real del 808, como FL) | v0.1 |
| Snap: línea, 1/1, 1/2, 1/3, 1/4, 1/6, 1/8, ninguno | v0.1 |
| Snap magnético | v0.x |
| Escala resaltada (tónica + 10 modos) | v0.1 |
| Bloqueo a escala al dibujar | v0.x |
| Ghost notes de otros canales del patrón | v0.1 |
| Zoom H (Ctrl+rueda) + scroll, preview audible al arrastrar | v0.1 |
| Minimapa clicable (vista completa del patrón + viewport) | v0.3 |
| Herramientas: Quantize, Transponer ±octava | v0.1 |
| Herramientas: Arpegiar, Strum, Humanize, Chop (sobre la selección o todo) | v0.3 |
| Stamp de acordes (mayor, menor, 7ª…) | v0.x |
| Riff machine (generador de motivos) | v1+ |
| Grabación MIDI en vivo desde teclado (Web MIDI) con cuantización | v0.x |

## 4. Playlist

| Función | Versión |
|---|---|
| Pistas ilimitadas con nombre y mute, + Pista | v0.1 |
| Clips de patrón: pintar en serie, mover, redimensionar, duplicar (Ctrl+arrastre) | v0.1 |
| Clips de automatización (con su curva dibujada; doble clic abre el editor) | v0.1 |
| Clips de audio (soltar un sonido del browser en la playlist) | v0.2 |
| Snap Beat/Compás/1/2/1/4/Nada (Alt = libre) | v0.1 |
| Cortar (slip/slice) y mute por clip | v0.x |
| Marcadores de sección: crear (doble clic en la regla), renombrar, borrar, salto exacto | v0.2 |
| Seek y región de loop desde la regla | v0.1 |
| Export parcial de la selección / el loop | v0.x |
| Cambiar entre **arrangements** | v0.1 |
| Crear/renombrar arrangements desde la UI | v0.x |
| Color, altura e icono por pista | v0.x |
| Mini-preview de las notas dentro de cada clip | v0.1 |
| Consolidar selección a audio (bounce in place) | v0.x |
| Pistas apiladas / carriles de toma | v1+ |

## 5. Mixer

| Función | Versión |
|---|---|
| 25 pistas de insert + Master, nombre por pista | v0.1 |
| Fader en dB reales, pan, mute/solo | v0.1 |
| Stereo separation en el strip (ya existe como destino de automatización) | v0.x |
| **10 slots de efectos** por pista con on/off y dry/wet por slot | v0.1 |
| Editor de parámetros de cada efecto inline (perillas por parámetro) | v0.1 |
| Routing libre pista→pista (clic derecho, "enrutar aquí") | v0.1 |
| Sends (Ctrl+clic) | v0.1 |
| Nivel ajustable por send (perilla + quitar, en la cadena de la pista) | v0.3 |
| Sidechain (cualquier pista como fuente del compresor de otra) | v0.1 |
| Medidores peak por strip + master | v0.1 |
| Línea de RMS en el master + LED de clip enclavado (clic = reset) | v0.3 |
| Color editable por pista | v0.x |
| EQ rápido de 3 bandas en el strip (como FL) | v0.x |
| Grabar la salida de una pista a audio | v0.x |

## 6. Instrumentos incluidos

| Instrumento | Qué es | Versión |
|---|---|---|
| **Orbit Sub** | 808/sub: sine + drive + glide + punch, afinable al kick | v0.1 |
| **Orbit Synth** | Sustractivo: saw/square/tri/sine, SVF, 2 ADSR, unison hasta 5 voces | v0.1 |
| **Orbit Saw** | Supersaw 7 osciladores con detune/blend y pan spread | v0.1 |
| **Orbit FM** | FM 2-op (bells, keys, bajos metálicos) | v0.1 |
| **Orbit Drums** | Caja de ritmos sintetizada, 3 kits: kick, snare, clap, hats, tom, conga, rim, shaker, crash | v0.1 |
| **Orbit Sampler** | Reproduce WAV con pitch, keytrack, punto de inicio y reverse | v0.1 |
| **Orbit Keys** | EP tipo Rhodes (FM) para boom bap / lo-fi | v0.x |
| **Orbit Slicer** | Trocea loops por transientes (estilo Fruity Slicer) | v0.x |
| **Orbit Vox** | Texturas vocales por formantes (ah/ooh/eh) | v0.x |

## 7. Efectos incluidos (14 tipos en v0.1)

| Efecto | Versión |
|---|---|
| EQ paramétrico (HP, low shelf, peak con Q, high shelf, LP — biquads RBJ) | v0.1 |
| Espectro visual dentro del EQ | v0.x |
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
| Vinyl/lo-fi (crujido + wow/flutter) | v0.x |
| Pitch shifter / vocoder | v1+ |
| Convolución (IRs) | v1+ |

## 8. Automatización

| Función | Versión |
|---|---|
| Clips de automatización con puntos y **tensión de curva** arrastrable | v0.1 |
| Destinos: canal (síntesis y mezcla), mixer, parámetro de efecto, tempo, swing | v0.1 |
| Valores reales mostrados en vivo (dB, Hz, %…) al editar la curva | v0.1 |
| "Último parámetro tocado" → crear clip desde la perilla | v0.x |
| LFO por parámetro (forma, velocidad sync, cantidad) | v0.x |
| Grabación de movimientos de perillas en vivo | v0.x |

## 9. Browser y librería de sonidos

| Función | Versión |
|---|---|
| Árbol por categorías: Drums, 808s, Percusión latina, Melódicos, FX | v0.1 |
| Tags por género/mood/tonalidad/BPM en manifest JSON | v0.1 |
| Búsqueda instantánea (nombre, tags, subcategoría; ignora acentos) | v0.1 |
| Filtros combinables por género/BPM/tonalidad | v0.x |
| Preview al clic (renderizado por el propio kernel) | v0.1 |
| Volumen de preview ajustable | v0.x |
| Doble clic = añade canal sampler con el sonido | v0.1 |
| Drag & drop: al Channel Rack (canal sampler) o a la Playlist (clip de audio) | v0.2 |
| Contenido de fábrica generado por síntesis propia (pack Orbit Essentials, 60 sonidos) | v0.1 |
| Carpetas del usuario (añadir rutas propias, se indexan igual) | v0.x |
| Favoritos y colecciones | v0.x |
| Detección automática de BPM/tonalidad al indexar | v1+ |

## 10. Grabación y edición de audio

| Función | Versión |
|---|---|
| Clips de audio en playlist (drop desde el browser; samples rehidratados al abrir) | v0.2 |
| Grabación de entrada (micro/línea) a la playlist | v0.x |
| Editor de sample estilo Edison (recortar, fades, normalizar, reverse) | v0.x |
| Time-stretch/pitch-shift de clips | v1+ |
| Detección de transientes y slice | v0.x |

## 11. Export / render

| Función | Versión |
|---|---|
| WAV 16/24/32-bit float | v0.1 |
| Selector de sample rate (44.1–96 kHz) | v0.x |
| Render offline (más rápido que tiempo real, mismo kernel DSP) | v0.1 |
| **Stems** (un WAV por pista de mixer usada, en un solo pase) | v0.1 |
| Tail de reverb/delay (2 s en el motor) | v0.1 |
| Tail configurable desde la UI | v0.x |
| Normalización a **-14 LUFS** opcional (flujo streaming Orbit) | v0.1 |
| Fuente: canción completa o patrón | v0.1 |
| Export de la selección de playlist / solo el loop | v0.x |
| MP3/FLAC/OGG | v0.x |
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
| Modo seguidor (ver la pantalla lógica de otro) | v0.x |
| Chat de sesión (texto), notas ancladas al timeline | v0.x |
| Permisos por rol (productor/invitado/oyente) | v0.x |
| Audio streaming de la sesión (escuchar el master remoto) | v1+ |

## 13. Claude integrado

| Función | Versión |
|---|---|
| Servidor **MCP** expuesto por la app (`.mcp.json` en el repo, stdio→WS) | v0.1 |
| **19 tools**: proyecto, notas, canales, steps, patrones, clips, tempo/swing, mixer, efectos, automatización, render, análisis, undo/redo | v0.1 |
| Todas sus ediciones pasan por el bus de comandos → undo separado del tuyo | v0.1 |
| **Panel de Claude**: feed de actividad en vivo (qué tocó, con qué resultado) | v0.1 |
| Análisis de mezcla (`analyze_mix`: LUFS, peak, balance por bandas, correlación) | v0.1 |
| Claude en la lista de presencia de la sesión (fila propia bajo su usuario) | v0.3 |
| Campo de petición rápida ("súbeme la voz en el drop") → lanza a Claude | v0.x |
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
| Recordar layout por proyecto; layouts predefinidos | v0.x |
| F5 Playlist · F6 Channel Rack · F7 Piano Roll · F9 Mixer · F10 Ajustes | v0.1 |
| Space play/stop · L pat/song · Ctrl+Z/Y · Ctrl+O · Ctrl+S/Ctrl+Shift+S | v0.1 |
| Ctrl+B duplicar y Ctrl+A seleccionar (en el Piano Roll) | v0.1 |
| Ctrl+E export directo | v0.x |
| Paleta de comandos (Ctrl+K) con búsqueda de toda acción | v0.x |
| Multi-ventana (mixer en segundo monitor) | v1+ |

## 16. Plugins de terceros

| Función | Versión |
|---|---|
| SDK de plugins JS/TS (instrumentos y efectos en sandbox AudioWorklet) | v0.x |
| Galería de plugins de la comunidad en el browser | v1+ |
| Puente CLAP / VST3 vía proceso host nativo | v1+ |

## 17. Rendimiento y fiabilidad

| Función | Versión |
|---|---|
| Kernel DSP en un solo AudioWorklet, cero GC en el audio thread | v0.1 |
| Medidor de CPU en la barra de transporte (aviso por color al cargarse) | v0.2 |
| Proyecto de 100 pistas sin dropouts (objetivo QA) | v0.1 |
| Golden tests del DSP (render determinista) — 43 tests en total | v0.1 |
| Autosave + crash recovery (banner Recuperar/Descartar al reabrir) | v0.2 |
