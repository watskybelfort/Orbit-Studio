# Catálogo de funciones — Orbit Studio

Guía completa de todo lo que tiene (y tendrá) Orbit Studio. Basado en el flujo de
FL Studio, ampliado con lo nuestro: colaboración en tiempo real, Claude integrado
y el sistema de temas acrílicos. Leyenda: **v0.1** = primera versión funcional ·
**v0.x** = tras el release inicial · **v1+** = horizonte.

---

## 1. Transport y proyecto

| Función | Versión |
|---|---|
| Play / Stop / Pause, modo PAT (patrón) y SONG (canción) | v0.1 |
| BPM 20–999 con decimales, tap tempo | v0.1 |
| Compases variables (4/4, 3/4, 6/8…), cambios de tempo por marcador | v0.1 |
| Metrónomo con pre-count, count-in de grabación | v0.1 |
| Loop de reproducción sobre selección | v0.1 |
| Swing global (perilla como FL) | v0.1 |
| Undo/redo ilimitado con historial navegable | v0.1 |
| Autosave + backups rotativos del proyecto | v0.1 |
| Formato `.orbit` (JSON versionado + samples por hash), abrir/guardar/guardar como | v0.1 |
| Import MIDI (arrastrar .mid al proyecto) | v0.x |
| Info del proyecto (título, autor, notas, artwork) | v0.1 |

## 2. Channel Rack

| Función | Versión |
|---|---|
| Canales ilimitados: sintes internos, sampler o audio | v0.1 |
| Step sequencer 16 pasos (extensible a 32/64), LEDs, click izq/der pone/quita | v0.1 |
| Velocity por paso (arrastre vertical) y graph editor | v0.1 |
| Mute/solo, volumen y pan por canal | v0.1 |
| Selector de patrones + renombrar/clonar/colorear patrón | v0.1 |
| Asignación de canal → pista de mixer (número como FL) | v0.1 |
| Agrupación por filtros (All, Drums, Melódicos…) | v0.x |
| Piano roll por canal (doble click) | v0.1 |
| Randomizar/humanizar pasos | v0.x |

## 3. Piano Roll

| Función | Versión |
|---|---|
| Dibujar, pintar (brush), cortar, borrar, seleccionar, mover, duplicar | v0.1 |
| Redimensionar notas por los bordes, drag multi-nota | v0.1 |
| Velocity y pan por nota (carril inferior) | v0.1 |
| **Slide notes** (glide del 808, como FL) | v0.1 |
| Snap: línea, 1/1…1/16, tresillos, ninguno; snap magnético | v0.1 |
| Escala resaltada (elegir tónica y modo) + bloqueo a escala | v0.1 |
| Ghost notes de otros canales del patrón | v0.1 |
| Zoom H/V con rueda, minimapa | v0.1 |
| Herramientas: Quantize, Arpegiar, Strum, Humanize, Chop, Transponer ±oct | v0.1 |
| Stamp de acordes (mayor, menor, 7ª…) | v0.x |
| Riff machine (generador de motivos) | v1+ |
| Grabación MIDI en vivo desde teclado (Web MIDI) con cuantización | v0.x |

## 4. Playlist

| Función | Versión |
|---|---|
| Pistas ilimitadas con nombre, color e icono | v0.1 |
| Clips de patrón, de audio y de automatización en cualquier pista | v0.1 |
| Pintar/arrastrar/duplicar (Ctrl+B)/cortar (slip/slice)/mute por clip | v0.1 |
| Marcadores de sección con nombre (Intro, Drop…) y salto rápido | v0.1 |
| Selección de rango para loop y para export parcial | v0.1 |
| Múltiples **arrangements** por proyecto | v0.1 |
| Consolidar selección a audio (bounce in place) | v0.x |
| Pistas apiladas / carriles de toma | v1+ |

## 5. Mixer

| Función | Versión |
|---|---|
| Pistas de insert + Master, nombre/color por pista | v0.1 |
| Fader en dB reales, pan, stereo separation, mute/solo | v0.1 |
| **10 slots de efectos** por pista con on/off y dry/wet por slot | v0.1 |
| Routing libre pista→pista (grafo, como el "route to this track" de FL) | v0.1 |
| Sends con nivel por send | v0.1 |
| Sidechain (cualquier pista como fuente del compresor de otra) | v0.1 |
| Medidores peak/RMS por pista + master, clip indicator | v0.1 |
| EQ rápido de 3 bandas en el strip (como FL) | v0.x |
| Grabar la salida de una pista a audio | v0.x |
| Latencia cero de monitoreo en render interno | v0.1 |

## 6. Instrumentos incluidos

| Instrumento | Qué es | Versión |
|---|---|---|
| **Orbit Sub** | 808/sub: sine + drive tanh + glide, afinable al kick | v0.1 |
| **Orbit Synth** | Sustractivo: saw/square/tri/sine, SVF, 2 ADSR, unison | v0.1 |
| **Orbit Saw** | Supersaw 7 osciladores con detune/blend (trance/reggaetón) | v0.1 |
| **Orbit FM** | FM 2-op (bells, keys, bajos metálicos) | v0.1 |
| **Orbit Drums** | Caja de ritmos sintetizada: kick, clap, snare, hats (ruido filtrado), conga, rim, shaker, tom | v0.1 |
| **Orbit Sampler** | Reproduce WAV con pitch, ADSR, loop points | v0.1 |
| **Orbit Keys** | EP tipo Rhodes (FM) para boom bap / lo-fi | v0.x |
| **Orbit Slicer** | Trocea loops por transientes (estilo Fruity Slicer) | v0.x |
| **Orbit Vox** | Texturas vocales por formantes (ah/ooh/eh) | v0.x |

## 7. Efectos incluidos

| Efecto | Versión |
|---|---|
| EQ paramétrico (biquads RBJ: HP, LP, shelf, peak; con espectro) | v0.1 |
| Compresor (threshold, ratio, attack, release, knee, makeup) | v0.1 |
| **Compresor sidechain** (fuente = otra pista del mixer) | v0.1 |
| Limiter lookahead (para el master) | v0.1 |
| Reverb (Freeverb mejorado: size, damp, width, pre-delay) | v0.1 |
| Delay estéreo (sync al tempo, ping-pong, feedback filtrado) | v0.1 |
| Chorus / Flanger / Phaser | v0.1 |
| Distorsión (drive tanh, waveshaper) + Bitcrusher | v0.1 |
| Filtro con envolvente y LFO (auto-filter) | v0.1 |
| Gate / Expander | v0.1 |
| Utilidades: Stereo width, Pan, Gain, Mono-maker (low-end mono <110 Hz) | v0.1 |
| Análisis: espectro, osciloscopio, medidor **LUFS** | v0.1 |
| Vinyl/lo-fi (crujido + wow/flutter) | v0.x |
| Pitch shifter / vocoder | v1+ |
| Convolución (IRs) | v1+ |

## 8. Automatización

| Función | Versión |
|---|---|
| Clips de automatización en playlist con puntos y tensión de curva | v0.1 |
| Enlazar cualquier parámetro (último tocado → "create automation clip") | v0.1 |
| LFO por parámetro (forma, velocidad sync, cantidad) | v0.x |
| Grabación de movimientos de perillas en vivo | v0.x |
| Automatización de tempo | v0.x |

## 9. Browser y librería de sonidos

| Función | Versión |
|---|---|
| Árbol por categorías: Drums, 808s, Percusión latina, Melódicos, FX, Presets, Proyectos | v0.1 |
| Tags por género/mood/tonalidad/BPM en manifest JSON | v0.1 |
| Búsqueda instantánea con filtros combinables | v0.1 |
| Preview al click (con volumen de preview) | v0.1 |
| Drag & drop a Channel Rack, Playlist o slot de sampler | v0.1 |
| Contenido de fábrica generado por síntesis propia (pack Orbit) | v0.1 |
| Carpetas del usuario (añadir rutas propias, se indexan igual) | v0.1 |
| Favoritos y colecciones | v0.x |
| Detección automática de BPM/tonalidad al indexar | v1+ |

## 10. Grabación y edición de audio

| Función | Versión |
|---|---|
| Clips de audio en playlist (WAV/MP3/OGG/FLAC decode) | v0.1 |
| Grabación de entrada (micro/línea) a la playlist | v0.x |
| Editor de sample estilo Edison (recortar, fades, normalizar, reverse) | v0.x |
| Time-stretch/pitch-shift de clips | v1+ |
| Detección de transientes y slice | v0.x |

## 11. Export / render

| Función | Versión |
|---|---|
| WAV 16/24/32-bit float, sample rates 44.1–96 kHz | v0.1 |
| Render offline (más rápido que tiempo real, mismo kernel DSP) | v0.1 |
| **Stems** por pista de mixer en un solo pase | v0.1 |
| Tail de reverb/delay configurable | v0.1 |
| Normalización a **-14 LUFS** opcional (flujo streaming Orbit) | v0.1 |
| Export de la selección de playlist / solo el loop | v0.1 |
| MP3/FLAC/OGG | v0.x |
| Export MIDI multipista (flujo FL de Orbit: .mid + wav) | v0.1 |

## 12. Colaboración en tiempo real

| Función | Versión |
|---|---|
| Sesión compartida por **código de room** (crear/unirse) | v0.1 |
| Edición simultánea sin conflictos (CRDT Yjs) en todos los editores | v0.1 |
| Presencia: cursores remotos, colores por usuario, "está editando X" | v0.1 |
| Lista de conectados con avatar/nombre | v0.1 |
| Undo **por usuario** (tu Ctrl+Z no deshace lo del otro) | v0.1 |
| Servidor propio (`apps/server`) con persistencia de sesiones | v0.1 |
| Modo seguidor (ver la pantalla lógica de otro) | v0.x |
| Chat de sesión (texto), notas ancladas al timeline | v0.x |
| Permisos por rol (productor/invitado/oyente) | v0.x |
| Audio streaming de la sesión (escuchar el master remoto) | v1+ |

## 13. Claude integrado

| Función | Versión |
|---|---|
| Servidor **MCP** expuesto por la app (`.mcp.json` en el repo) | v0.1 |
| Tools: leer proyecto, editar patrones/notas, mixer, efectos, automatización, tempo, render, análisis de mezcla | v0.1 |
| Claude aparece en presencia como colaborador ("Claude") con su color | v0.1 |
| Todas sus ediciones pasan por el bus de comandos → undo normal | v0.1 |
| **Panel de Claude**: feed de actividad (qué cambió y por qué) | v0.1 |
| Campo de petición rápida ("súbeme la voz en el drop") → lanza a Claude con contexto | v0.x |
| Análisis de mezcla automatizado (balance espectral, LUFS, enmascaramiento) | v0.x |
| Claude genera contenido a la librería (packs a demanda) | v0.x |

## 14. Apariencia y temas

| Función | Versión |
|---|---|
| Tema **oscuro** (defecto) y **claro** | v0.1 |
| Tema **acrílico**: blur real del escritorio (DWM, arquitectura A del skill) | v0.1 |
| Controles de ventana estilo Windows o **semáforo macOS** (opción) | v0.1 |
| Customizador: transparencia, tinte y acento (3 perillas), picker de color | v0.1 |
| Guardar temas custom con nombre; exportar/importar tema | v0.1 |
| Iconografía SVG propia minimalista estilo Mac | v0.1 |
| Escala de UI (zoom global) | v0.x |
| Fuentes y radios configurables | v0.x |

## 15. Sistema de ventanas y atajos

| Función | Versión |
|---|---|
| Ventanas internas movibles/redimensionables/cerrables (como FL) | v0.1 |
| Recordar layout por proyecto; layouts predefinidos | v0.x |
| F5 Playlist · F6 Channel Rack · F7 Piano Roll · F8 Browser de plugins · F9 Mixer · F10 Ajustes | v0.1 |
| Space play/stop · L modo pat/song · Ctrl+Z/Y · Ctrl+B duplicar · Ctrl+E export | v0.1 |
| Paleta de comandos (Ctrl+K) con búsqueda de toda acción | v0.1 |
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
| Medidor de CPU del motor en la barra superior | v0.1 |
| Proyecto de 100 pistas sin dropouts (objetivo QA) | v0.1 |
| Golden tests del DSP (render determinista → hash estable) | v0.1 |
| Crash recovery: reabrir con el último autosave | v0.1 |
