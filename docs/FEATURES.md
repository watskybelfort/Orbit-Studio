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
| **Versiones del proyecto con diff musical**: instantáneas con nombre (una en cada Ctrl+S y las que pidas), cada una desplegable con lo que ha cambiado desde entonces contado en música — "+3 notas en «Patrón 1» · Kit", "Canal nuevo «Voz»", "Tempo 140 → 76.25", "fader +2.5 dB", "efecto nuevo: limiter". Las notas se casan por id, así que mover una no se cuenta como borrarla y crearla. Restaurar guarda antes el estado actual: volver atrás no es una puerta de un solo sentido | v1.9 |
| Formato `.orbit` (JSON versionado), abrir/guardar/guardar como (Ctrl+O/S) | v0.1 |
| Import MIDI (Archivo → Importar: canales + patrón + tempo, en un undo) | v0.4 |
| Info del proyecto: título, autor, notas y recuento de todo lo que hay dentro | v1.0 |
| **Proyectos recientes**: los diez últimos abiertos o guardados, en `Archivo → Abrir reciente` y en la paleta por su nombre de archivo. La lista la escribe SOLO el main y es la lista blanca de `project:open-recent` (misma regla que `userFolders`); un archivo que ya no está sale marcado y se olvida al intentar abrirlo | v2.2 |
| **Aviso antes de perder cambios**: nuevo, plantilla, abrir y abrir reciente preguntan si hay trabajo sin guardar, y cerrar la ventana lo para el MAIN —el renderer no se entera de un Alt+F4— con "Guardar y salir". El título de la ventana lleva el nombre del proyecto y un punto cuando hay cambios | v2.2 |

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
| **Borrar patrón** con su cascada: se lleva sus notas y sus clips de la playlist en UN paso de undo, avisando de cuántos clips se llevó | v1.1 |
| Borrar patrón desde donde estés: menú **Patrón** del MenuBar, paleta Ctrl+K (grupo "Patrón"), atajo **Ctrl+Shift+Supr**, clic derecho en un pad de la Vista Live y ✕ en la toolbar del Piano Roll | v1.1 |
| El último patrón nunca se borra (la opción se deshabilita sola) y el patrón activo salta al vecino en vez de quedarse colgando | v1.1 |
| ▶ propio del rack: escuchar SOLO el patrón activo | v0.6 |
| Menú de canal (clic derecho): llenar cada 2/4/todos, vaciar, renombrar, color, borrar | v0.6 |
| Filas y pasos más grandes y aireados (pase visual) | v0.6 |
| Asignación de canal → pista de mixer (número como FL) | v0.1 |
| Mini-preview de melodía que abre el Piano Roll (doble clic también) | v0.1 |
| Mantener pulsado el icono = escuchar el canal | v0.1 |
| Filtros de canal (Todos, Drums, 808/Bajos, Melódicos, Sampler, Voces) + buscador | v1.0 |
| **Carpetas de canales**: cabecera con color, plegado, contador y M/S de todo el grupo; botón + Carpeta y, en el menú del canal, mover a una carpeta, sacarlo o crear una con él. Es organización pura —no hay bus de carpeta—: el mute del grupo se le hace a sus canales en UN paso de undo, y deshacer la carpeta los deja sueltos sin borrar nada | v1.5 |
| **Arrastrar canales**: el nombre es el asa. Sobre otra fila queda encima o debajo de ella y hereda SU carpeta; sobre la cabecera de una carpeta (aunque esté plegada o vacía) entra al final; en la zona de sueltos —que aparece en cuanto empieza el arrastre— sale de la suya. Guía de inserción, fila de origen apagada, y carpeta + sitio en UN paso de undo | v1.6 |
| Randomizar y humanizar pasos desde el menú del canal, en un solo undo | v1.0 |

## 3. Piano Roll

| Función | Versión |
|---|---|
| Dibujar, borrar, mover, redimensionar por bordes, drag multi-nota | v0.1 |
| **Dibujar y arrastrar da la duración** (como en FL): al poner una nota, el arrastre horizontal la estira y esa duración queda de plantilla para las siguientes; el vertical la mueve. El tirador del borde derecho es proporcional al ancho de la nota (4–12 px) y el cursor lo delata: `ew-resize` en el borde, `move` en el cuerpo | v1.4 |
| Selección marquee (Ctrl+arrastre), Ctrl+A, duplicar (Ctrl+B), Supr | v0.1 |
| **Copiar, cortar y pegar notas** (Ctrl+C/X/V): lo copiado se guarda normalizado al beat 0 y se pega en el caret con el snap vigente, así que la separación entre notas se conserva sola; pegar antes del 0 mueve el grupo entero en vez de apelmazarlo | v2.2 |
| Herramientas **Dibujar / Pincel / Cortar** (P, B, C), con el pincel borrando en arrastre con el botón derecho | v1.0 |
| Velocity por nota (carril inferior) | v0.1 |
| **Las teclas se iluminan mientras suenan**: lo que pulsas (ratón, fila Z/Q del PC, MIDI) y también lo que dispara el secuenciador durante la reproducción. El dato sale del kernel (`MeterFrame.notes`), así que se enciende lo que suena de verdad, no lo que la UI cree | v1.3 |
| Pan por nota (carril inferior conmutable Vel/Pan) | v0.3 |
| **Slide notes** (glide real del 808, como FL) | v0.1 |
| Snap: línea, 1/1, 1/2, 1/3, 1/4, 1/6, 1/8, ninguno | v0.1 |
| Snap magnético (libre, se pega a la rejilla solo cerca de la línea) | v0.6 |
| Escala resaltada (tónica + 10 modos) | v0.1 |
| Bloqueo a escala al dibujar y mover (botón Bloq) | v0.6 |
| Ghost notes de otros canales del patrón | v0.1 |
| Toggle de ghost notes + selector de patrón en la toolbar, con ✕ para borrar el patrón que estás editando | v0.6 |
| Mover selección contra el borde conserva posiciones (clamp de grupo) | v0.6 |
| Zoom H (Ctrl+rueda) + scroll, preview audible al arrastrar | v0.1 |
| Minimapa clicable (vista completa del patrón + viewport) | v0.3 |
| Herramientas: Quantize, Transponer ±octava | v0.1 |
| Herramientas: Arpegiar, Strum, Humanize, Chop (sobre la selección o todo) | v0.3 |
| Atajos FL de herramientas: Alt+A/S/U/R, Ctrl+Q, Ctrl+Shift+↑↓ | v0.6 |
| Stamp de acordes (mayor, menor, 7ªs, sus4, power, octava) | v0.6 |
| **Aplicar el acorde a lo ya escrito** (botón Aplicar / Alt+C): convierte en acordes la selección —o todo si no hay— sin tocar las notas originales (conservan id, velocity y slide), sin repetir lo que ya hay y, con el bloqueo a escala, arrimado a la tonalidad | v2.1 |
| **Arpegiador completo** (Alt+A): panel con recorrido (arriba, abajo, ida y vuelta, alterna, aleatorio con semilla, acorde), paso, Time mul, rango de octavas normal/invertido, Gate, agrupar notas y rampas de Pan/Vel/Tono. Cada cambio se oye al momento sobre las notas de verdad; Cancelar o Esc las devuelve exactamente como estaban | v2.1 |
| **Toolbar por grupos** con etiqueta (Editando, Herramienta, Rejilla, Armonía, Notas, Generar, Ver) y nombres escritos enteros: Cuantizar, Trocear, Humanizar, Arpegiar, 8va ▲/▼ | v2.1 |
| **Riff machine** (Alt+G): motivos sobre la escala, deterministas por semilla, con densidad, rango y carácter | v1.0 |
| Tocar en vivo con controlador MIDI o el teclado del PC (filas Z y Q) | v0.5 |
| Grabación MIDI armada al patrón (cuantización de inicios a 1/16, un undo) | v0.5 |

## 4. Playlist

| Función | Versión |
|---|---|
| Pistas ilimitadas con nombre y mute, + Pista | v0.1 |
| Clips de patrón: pintar en serie, mover, redimensionar, duplicar (Ctrl+arrastre) | v0.1 |
| **Secciones del arreglo**: la forma del tema (intro, subida, drop, vuelta, outro) en su franja sobre la rejilla — arrastrar crea, agarrar mueve con sus clips, el borde derecho estira empujando lo de detrás y el clic derecho ofrece duplicar con sus clips, seleccionar los suyos, color y tres formas de borrar. Duplicar un drop copia sus clips, empuja lo posterior y mueve los marcadores (o el tempo se descuadraría), todo en un paso de undo | v2.4 |
| **Estructura de un clic**: las tres formas que reparte el generador de beats (de manual, con vuelta larga, al grano), leídas del mismo catálogo que usa él | v2.4 |
| **Copiar, cortar y pegar clips** (Ctrl+C/X/V): pega en el caret y en la pista bajo el ratón (sin ratón dentro, en la que se copió); si el grupo no cabe hacia abajo sube entero. Los puntos de automatización se clonan y `frozenFrom` no viaja —una copia que dijera ser dueña de los clips escondidos descongelaría encima del original— | v2.2 |
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
| Menú de la escena (clic derecho en un pad): renombrar, color, clonar y borrar — borrar una escena en cola la cancela antes de irse | v1.1 |
| **Carriles de toma (comping)**: las tomas se apilan en la pista y el clic central elige la buena | v1.0 |
| **Selección de clips**: clic marca, Ctrl+clic mete y saca, Ctrl+arrastre en zona vacía dibuja un rectángulo (Shift suma), Ctrl+A todo. Arrastrar un clip marcado mueve el GRUPO con clamp conjunto; Supr borra, Ctrl+B duplica, M mutea, Esc suelta. Botones a la vista en la toolbar con la cuenta | v2.1 |
| **Forma de onda real en los clips de audio**, respetando offset y time-stretch (los picos van en caché compartida con el editor de canal) | v2.1 |
| **Fundidos de entrada y salida arrastrables** (estilo CapCut): un tirador en cada esquina de arriba del clip, doble clic lo quita, y el clip dibuja la rampa que se aplica de verdad. En beats, así que siguen al tempo; cortar un clip los reparte entre cabeza y cola | v2.1 |

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
| **Graph editor del enrutado** (ventana "Enrutado"): el camino entero de la señal como nodos y cables —canales y carriles de audio a la izquierda, pistas repartidas por columnas según lo lejos que estén del master—, con la salida (línea llena) y los envíos (de puntos, con su nivel en dB) a la vista | v1.7 |
| Recablear arrastrando de un puerto a otra pista: cambia la pista del canal, el `routeTo` o añade un envío. Un cable que cerraría un BUCLE se pinta en rojo y no se guarda (el compilador tolera los ciclos, pero lo que suena entonces no es lo que nadie quería) | v1.7 |
| Doble clic en un cable lo devuelve al master (o quita el envío); el nivel del envío se arrastra desde su chapa; pan, zoom, "Ver todas" y encaje automático | v1.7 |

| **Envíos que procesan, no solo enrutan**: cada envío elige de dónde toma la señal (**pre** o post-fader), **qué parte** manda (todo, centro/mid, lados/side, solo izquierdo o solo derecho), su **polaridad** (invertida = resta en vez de sumar), su pan y su mute. Un bus de lados con su compresor, una reverb que se queda al cerrar el fader o un null test dejan de pedir pistas duplicadas | v2.6 |
| El envío marcado se ve sin abrirlo (chapa «preSø» en el strip) y **el grafo dibuja lo que lleva cada cable**: discontinuo si es pre, fino si va solo una parte, rojo si invierte | v2.6 |

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
| **Orbit Slicer: cortar por transientes** | En la pestaña Sonido del canal, la onda con los cortes numerados encima y el botón que los pone EN los golpes (tres grados de detalle). Los cortes se guardan en el canal (`slicePoints`), se editan a mano —arrastrar mueve, doble clic añade, derecho quita— y se puede volver a N partes iguales cuando quieras | v1.5 |
| **Orbit Vox** | Voz sintética por formantes (A/E/I/O/U) con soplo y vibrato | v1.0 |
| **Orbit Prisma** | El instrumento grande de presets: **125 sonidos** en 16 categorías, hasta 4 capas por preset con 9 motores propios (tabla con morph, pulso PWM, ruido, FM con realimentación, cuerda pulsada, órgano aditivo, campana inarmónica, formantes y sub), filtro LP/HP/BP/Notch con envolvente y keytrack, envolvente de modulación, LFO por voz, unísono, modo Poly/Mono/Legato y **8 macros por preset**. Sus 38 perillas son ABSOLUTAS: el preset las carga y a partir de ahí mandas tú | v1.1 |

### Orbit Prisma — parámetros de las capas

Cada capa declara su motor y su carácter (`wave` 0..1, que cada motor interpreta
a su manera), nivel, pan, transposición, multiplicadores sobre la envolvente del
canal, un pasa-bajos propio en octavas, rango de teclas, respuesta a velocidad y
fase (o fase aleatoria por nota). La perilla **Wave** del canal es un
DESPLAZAMIENTO sobre todas las capas desde su neutro (0.5), no el wave de la
primera. Y una macro **escribe** su parámetro al disparar la nota, así que su
valor de fábrica tiene que reproducir lo que muestran las perillas — si no, el
preset suena distinto de lo que enseña.

Techos del motor: 12 osciladores por voz (el unísono se reparte entre las capas)
y 48 líneas de retardo para la cuerda pulsada en todo el proceso.

## 6 bis. Editor de sonido por canal (v1.1)

Doble clic en un canal del rack, o clic derecho → *Editor de sonido…*

| Pestaña | Qué trae | Versión |
|---|---|---|
| **Sonido** | Las perillas del instrumento, generadas desde el registro de parámetros (vale para los diez kinds). En un sampler, además, el bloque de recorte con la **onda dibujada y las marcas de start/end arrastrables**, fades de entrada y salida, ganancia, reverse (invertir el tiempo), polaridad (invertir la fase) y loop | v1.1 |
| **Efectos** | Los **4 inserts propios del canal**: menú de tipo, bypass, dry/wet, sidechain del compresor y todas las perillas del efecto, cada una automatizable y con LFO por clic derecho | v1.1 |
| **Mezcla** | Volumen, pan, mute, solo y pista de mixer de destino | v1.1 |

Los inserts del canal suenan ENTRE las voces y el bus de la pista de mixer, y el
volumen y el pan del canal se aplican DESPUÉS de la cadena. Eso permite tratar un
sonido a solas —bajarle el reverb, ensuciarlo, filtrarlo— sin gastar un insert
entero del mixer ni arrastrar a los demás canales que compartan pista. Un canal
sin efectos sigue por el camino rápido de siempre, bit a bit idéntico.

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
| **Lápiz**: se dibuja la curva a mano alzada. El trazo se pinta encima mientras dura (no se toca el modelo: un barrido son cientos de eventos) y al soltar se simplifica y sustituye SOLO el tramo dibujado, en un paso de undo | v2.3 |
| **Recta**: una rampa entre dos puntos, con la misma sustitución de tramo | v2.3 |
| **Generador de formas** ("Forma…"): seno, triángulo, sierra ↗/↘, cuadrada y aleatoria con semilla, con ciclos, recorrido, fase, resolución y el tramo de beats que ocupa. La previsualización se DIBUJA (discontinua, encima de la curva) y el proyecto no se toca hasta Aplicar | v2.3 |
| **Snap del eje de valor** (1/2, 1/4, 1/8, 12, 1/16) para lápiz, recta, arrastre y doble clic, con sus alturas pintadas: con 12 divisiones una automatización de tono cae en semitonos. El redondeo va ANTES de simplificar, o una rampa recta se quedaría en sus dos extremos y el snap no se notaría | v2.3 |
| **Simplificar**: quita puntos sin cambiar lo que suena — muestrea la curva como la evalúa el motor (tensiones incluidas) en vez de podar la lista, que cambiaría la forma | v2.3 |
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
| **Packs generados en la app**: familia (kicks, snares, claps, hats, open hats, percusión, 808s, impactos, risers, downlifters) por estilo (trap, drill, boom bap, latino, house, techno, lo-fi) y cuántos quieres; se renderizan con el motor de la app, se normalizan a -1 dBFS y aparecen en su sección del browser como los de fábrica | v1.7 |
| Cada pack vive en `userData/packs/<slug>/` (WAV + manifest.json, mismo formato que el de fábrica) con su botón de abrir carpeta y de borrar; los sonidos se arrastran, se guardan en el proyecto y sobreviven a reabrirlo | v1.7 |
| Mismo encargo + misma semilla = mismo pack, siempre (variaciones por hash del índice, cero azar) | v1.7 |
| **Loops de verdad, no one-shots**: melódicos con la progresión de cada género (i–VI–III–VII en trap, i–VII–VI–V en drill, ii–V–i en boom bap…) y su ritmo por variación (acordes sostenidos, stabs a corcheas, arpegio a semicorcheas); breaks de batería con bombo, caja y hats —con redoble de tresillos al cerrar en trap y drill—; y líneas de 808 siguiendo los acordes, con glide. Salen al tempo del estilo, con su tonalidad en el manifest, y cortados EXACTOS en el beat (un loop recortado por umbral no encaja con nada) | v1.8 |
| **Beats con estructura entera** (familia `beats`): intro, subida, drop, vuelta y cierre encadenados en UN archivo, con batería, 808 y melodía sonando a la vez. Cada compás suena según dónde está —el 808 desaparece en la vuelta, los hats se doblan en la subida, el redoble anuncia el drop y el bombo se calla en el último compás, porque lo que hace entrar un drop es el silencio de antes—. Tres formas distintas, de 20 a 36 compases; tope propio de 4 por pack (cada uno pesa como veinte hats) | v2.0 |

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
| Export de la **selección** de la playlist (la región marcada en ese momento) | v1.0 |
| MP3 a 192 kbps junto al WAV | v0.5 |
| FLAC sin pérdida (codificador propio: FIXED + Rice, bit-exacto vs ffmpeg) | v0.6 |
| **OGG (Ogg FLAC)**: lo que faltaba no era un códec, era el CONTENEDOR — y ese sí se escribe. Páginas Ogg con su CRC (el del formato, no el de zip), tabla de trozos y granulado, con el mapeo de FLAC sobre Ogg: un `.ogg` de Orbit es sin pérdida y lo abre cualquier reproductor. Verificado con ffmpeg: decodifica bit a bit igual que el original | v1.9 |
| Opus propio — **en construcción**. El range coder, la MDCT con ventana de CELT, la FFT de radix mixto y el PVQ (con la enumeración normativa de la RFC) están hechos y verificados; el contenedor Ogg Opus está validado bit a bit contra ffmpeg. Falta el ensamblador de tramas de CELT y sus tablas de la RFC, así que **no hay export a Opus todavía**. El `.ogg` de arriba (Ogg FLAC) cubre el hueco de formato; el streaming de la sala se comprime con el ADPCM propio | v2.8+ |
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
| **Cuánta gente cabe en la sala, ajustable**: campo "Caben" en el panel (2-64, por defecto 16) o `ORBIT_ROOM_CAPACITY` en el servidor suelto; `/health` publica `rooms`, `conns` y `roomCapacity`, y el panel enseña "N conectados de M" | v1.3 |
| **Hospedar para otras máquinas**: casilla "Abrir a la red" en el panel (apagada por defecto). Encendida, el servidor de la app escucha en `0.0.0.0` y el panel enseña las IPv4 para compartir; apagada, solo esta máquina. Sin contraseña: entra quien llegue al puerto y sepa el código | v1.3 |
| **Elegir la dirección**: desplegable "Escucha en" con las IPv4 reales de la máquina, etiquetadas y ordenadas (Radmin VPN y demás VPN primero, luego LAN, al final lo virtual y el 169.254), más "solo esta máquina" y "todas las redes". Si la elegida ya no está, arranca en local y lo dice; con una IP concreta, el panel da la dirección a compartir, la copia y ofrece dejarla en tu propio campo Servidor (localhost deja de valer hasta para el que hospeda) | v1.4 |
| **Al que no cabe se le dice por qué**: los cierres 1013 (sala llena) y 1008 (código inválido) cortan la reconexión y suben el motivo del servidor a la pantalla, en vez de reintentar en silencio hasta el timeout | v1.3 |
| **Un color por persona aunque repitan nombre**: el color sale del nombre y todo el mundo entra como "Productor", así que quien choca con alguien de clientId más bajo se aparta al primer color libre (converge sin negociar). Los nombres repetidos se numeran en la lista | v1.3 |
| **Contraseña de sala**: la puerta, con el esquema de SCRAM reducido a lo justo. La contraseña NO viaja —el cliente firma con ella un nonce que pone el servidor, así que la prueba es distinta en cada conexión— y el servidor guarda un hash de un hash, con el que tampoco se puede entrar. Mientras alguien está en la puerta no se le mira nada más (ni sync, ni presencia, ni audio) y la sala ni siquiera se crea; una prueba por conexión, 20 s de margen, y fallar cierra con 1008 y su motivo. La pone y la quita el productor desde el panel, y cambiarla no echa a los que están dentro | v2.0 |
| **Modo seguidor**: tu vista sigue la de otro (editor, patrón, canal, caret) | v1.0 |
| **Chat de sesión** por el mismo documento Yjs, con notas ancladas a un compás | v1.0 |
| **Permisos por rol** (productor / invitado / oyente) aplicados en el log de comandos | v1.0 |
| **El rol lo reparte y lo hace cumplir el SERVIDOR**: hasta v1.7 era autodeclarado (cambiar un campo bastaba para ascender). Ahora el primero que entra es productor, los demás invitados, y el productor reparte desde la lista de la sala; si se va, hereda el más antiguo. El servidor juzga cada entrada del log con el rol que ÉL tiene apuntado y retira la que no pasa — borrar es una operación normal del CRDT, así que converge y el infractor re-deriva su proyecto | v1.8 |
| **Streaming del master de la sesión**: "Emitir mi master" manda tu salida final (por un mensaje que el servidor reparte y no guarda) y el botón **Oír** de cada fila la reproduce en tu máquina, fuera del kernel y con su propio volumen. Cierra el "¿lo estás oyendo igual que yo?"; es monitorización, la referencia sigue siendo el render | v1.8 |
| El stream va **comprimido** con el ADPCM propio (4 bits por muestra): 192 kbit/s en vez de los 768 de v1.8, con cada trozo codificado desde cero para que un paquete perdido no arrastre al siguiente. El tipo de codificación viaja en el mensaje, así que un trozo crudo sigue siendo válido | v1.9 |
| **Los sonidos viajan por la sala**: los samples se publican por hash en el mismo documento Yjs y se rehidratan en el kernel del otro. Antes solo viajaban los comandos, así que un canal sampler o un clip de audio sonaba en tu máquina y era MUDO en la suya salvo que él hubiera pinchado ese mismo sonido de fábrica antes. Topes: 16 MB por sample, 64 MB por sala; el contenido de fábrica no viaja (se resuelve por ruta en las dos) | v1.1 |
| Reconciliación al conectar, al registrar un sample y tras cada resincronización (join y replay dejaban el proyecto lleno de referencias y el kernel vacío) | v1.1 |
| **Congelar tu audio** mientras el otro trastea: los comandos remotos se siguen aplicando al modelo, pero tu motor se queda con el último snapshot hasta que lo sueltas. No silencia al otro — lo que oyes es tu propio motor tocando el proyecto común | v1.1 |
| Aviso de "N sonidos de la sala todavía no están disponibles aquí", con nombres | v1.1 |
| Audio streaming de la sesión (escuchar el master remoto) | v1+ |

| **Gente en la red local**: los que tienen Orbit abierto en la misma red salen en el panel, se guardan como amigos y se les invita de un clic; al otro le llega un aviso con el botón de entrar. Baliza UDP multicast con TTL 1 (no sale de la subred), sin servidor central ni cuentas. Escuchar es siempre —es lo que hace que lleguen las invitaciones—; anunciar tu nombre es opcional | v2.4 |
| **Invitaciones caducables**: el productor crea llaves con caducidad (15 min a 1 día) y usos (1, 3 o 10), las ve en una lista con lo que les queda y las revoca. Entrar con una no pide la contraseña. El servidor guarda SHA-256 del secreto y el token se enseña UNA vez: ni él lo puede repetir | v2.5 |
| **Invitar de un clic**: el botón de la red local adjunta un token de un uso y media hora, así que al otro le llega un aviso con «Unirme» que entra directo, sin contraseña ni código dictado | v2.5 |
| **La invitación no entra sola**: llega, se enseña quién invita y a qué sala, y decide el usuario. Lo que llega por el socket se valida entero (versión, tamaño, id, código de sala) y la URL tiene que ser ws/wss, o quien invita elegiría a qué se conecta el invitado | v2.4 |

## 13. Claude integrado

| Función | Versión |
|---|---|
| Servidor **MCP** expuesto por la app (`.mcp.json` en el repo, stdio→WS) | v0.1 |
| **21 tools**: proyecto, notas, canales, steps, patrones, clips, tempo/swing, mixer, efectos, automatización, render, análisis, consejo de mezcla, packs de sonidos, undo/redo | v0.1 |
| Todas sus ediciones pasan por el bus de comandos → undo separado del tuyo | v0.1 |
| **Panel de Claude**: feed de actividad en vivo (qué tocó, con qué resultado) | v0.1 |
| Análisis de mezcla (`analyze_mix`: LUFS, peak, balance por bandas, correlación) | v0.1 |
| Claude en la lista de presencia de la sesión (fila propia bajo su usuario) | v0.3 |
| Campo de petición en el panel (viaja adjunta al siguiente get_project de Claude) | v0.5 |
| **Asistente de mezcla** (`advise_mix`): diagnóstico por tilts de banda, LUFS y fase, con cadena propuesta y opción de aplicarla | v1.0 |
| **Claude genera packs a demanda** (`generate_pack`): "12 hats de drill" salen renderizados con el motor real y aterrizan en la librería; con `addChannels` los mete además en canales sampler del proyecto | v1.7 |

## 14. Apariencia y temas

| Función | Versión |
|---|---|
| Tema **oscuro** (defecto) y **claro** | v0.1 |
| Tema **acrílico**: blur real del escritorio (DWM `backgroundMaterial`) | v0.1 |
| Controles de ventana estilo Windows o **semáforo macOS** (opción) | v0.1 |
| Customizador: acento (paleta + picker), transparencia y tinte del vidrio | v0.1 |
| Guardar/borrar temas custom con nombre (persisten en settings) | v0.1 |
| **Exportar/importar tema** como `.orbittheme.json`, con validación que dice qué falla | v1.0 |
| Iconografía SVG propia minimalista estilo Mac (26 iconos) | v0.1 |
| **Escala de UI 80–150 %** (incluye el shim que devuelve las coordenadas de canvas a px de layout: sin él los clics caen desplazados) | v1.0 |
| Fuente de interfaz (6 pilas del sistema) y radio de esquinas por token | v1.0 |

## 15. Sistema de ventanas y atajos

| Función | Versión |
|---|---|
| Ventanas internas movibles/redimensionables/cerrables con z-order (como FL) | v0.1 |
| **Menús flotantes por portal** (`MenuPortal`): van al `body` del documento del ancla y se colocan midiéndose contra ESA ventana. Antes eran `position: fixed` dentro del editor, y cualquier ancestro con `transform`, `will-change` o `backdrop-filter` los recortaba — por eso el menú de pista de la playlist no aparecía nunca y los demás fallaban solo en tema acrílico | v1.1 |
| **Z-order acotado**: los z de las ventanas se renumeran en un rango pequeño. Antes crecían 1 por cada clic sin techo y acababan tapando los menús contextuales (1000) y la paleta de comandos (1200) | v1.1 |
| **Ventanas desacoplables**: sacar cualquier editor a una ventana nativa del OS | v0.6 |
| **Su sitio se recuerda** (monitor incluido) y se comprueba contra las pantallas de ahora: si aquel monitor ya no está, o la resolución encogió, arranca donde se vea — una ventana restaurada fuera de pantalla existe, roba el foco y no se puede agarrar | v1.6 |
| **Se restauran al arrancar**: los editores que estaban fuera vuelven a salir en su ventana | v1.6 |
| **Teclado dentro de la ventana desacoplada**: sus pulsaciones se reenvían a la principal, que es donde escuchan los atajos y las teclas del piano (no se reenvía lo que se escribe en un campo) | v1.6 |
| Barra propia de cada ventana: **siempre encima** (persistido) y **devolver** a la principal | v1.6 |
| Toolbar con play PAT/SONG directos y botones de todas las ventanas | v0.6 |
| Modo compacto Zen (oculta librería y paneles de un clic) | v0.6 |
| **Layouts de ventanas**: tres predefinidos (Componer, Mezclar, Arreglar) y los que guardes en el proyecto | v1.0 |
| **El escritorio vuelve a salir como lo dejaste**: la disposición viva (ventanas + navegador + panel de Claude) se guarda en settings.json y se restaura al arrancar, acotada al escritorio de AHORA (una ventana que se quedó en un monitor que ya no está vuelve a la vista). Interruptor y "Olvidar" en Ajustes | v2.1 |
| **Ayuda › Acerca de**: versión real de la app (de `app.getVersion()`), sistema, Electron, Chromium, Node y carpeta de datos, con un botón para copiar la ficha | v2.1 |
| Ventana de LFOs (toolbar, menú Ver y paleta) | v0.8 |
| Botón de grabación de perillas en el transporte (armar / capturando) | v0.8 |
| F5 Playlist · F6 Channel Rack · F7 Piano Roll · F9 Mixer · F10 Ajustes | v0.1 |
| Space play/stop · L pat/song · Ctrl+Z/Y · Ctrl+O · Ctrl+S/Ctrl+Shift+S | v0.1 |
| P / B / C herramientas del piano roll · Alt+G riff machine | v1.0 |
| Ctrl+B duplicar y Ctrl+A seleccionar (en el Piano Roll) | v0.1 |
| Ctrl+A / Ctrl+B / Supr / M / Esc en la **Playlist** (con el ratón encima: el Piano Roll tiene los suyos para sus notas) | v2.1 |
| Alt+C acorde sobre la selección · Alt+A abre el arpegiador (Esc lo cancela) | v2.1 |
| **Ctrl+E**: repite el último export sin diálogo, con sufijo incremental | v1.0 |
| **Ctrl+Shift+Supr**: borra el patrón activo (Supr a secas sigue siendo el de las notas del Piano Roll) | v1.1 |
| Menú **Patrón** en el MenuBar: nuevo, clonar, renombrar y borrar el activo | v1.1 |
| **Menús con submenús y marcas de estado**: las plantillas, los recientes y los layouts dejan de ser entradas sueltas del primer nivel, y lo que está abierto (ventanas, Browser, panel de Claude, Zen) lleva su ✓. `Ver` va por bloques con cabecera; `Editar` gana cortar/copiar/pegar/duplicar/seleccionar todo/borrar contra el editor con el turno, y deshacer/rehacer dicen QUÉ deshacen | v2.2 |
| **Los menús se manejan con el teclado**: Alt abre la barra, flechas recorren entradas y menús, → entra en un submenú y ← sale, Inicio/Fin, Esc, y escribir una letra salta a la entrada que empieza por ella. El recorrido mueve el foco de verdad (Enter y Espacio los sirve el `<button>` nativo). Alt "a secas" se detecta en el keyUP, para no pisar Alt+A, Alt+C ni Alt+arrastre | v2.2 |
| **Ayuda → Atajos de teclado (F1)**: la chuleta completa dentro de la app, agrupada y buscable, con dónde vale cada atajo | v2.2 |
| Paleta de comandos (Ctrl+K): búsqueda sin acentos, grupos, teclado completo | v0.5 |
| **Paleta por subsecuencia y con memoria**: "pr" encuentra "Abrir Piano Roll" (antes hacía falta el principio exacto), la puntuación premia iniciales de palabra sin penalizar el salto entre ellas, y sin escribir nada salen los últimos doce comandos usados (guardados en settings.json). Con texto manda la puntuación: la recencia solo desempata | v2.2 |
| Grupo "Patrón" en la paleta: nuevo, clonar, renombrar y borrar (con el nombre del patrón y los clips que se lleva en el propio título) | v1.1 |
| Multi-ventana (mixer en segundo monitor) | v1.6 |

## 16. Plugins de terceros

| Función | Versión |
|---|---|
| **SDK de plugins JS** (efectos): carpeta de usuario, perillas propias, sandbox del worklet con bypass anti-crash, en vivo y en el export (docs/PLUGINS.md) | v0.7 |
| **Galería de la comunidad**: se añaden fuentes (la URL de un índice JSON publicado donde sea; formato en `docs/plugin-gallery.json`), se ve qué ofrecen y se instala de un clic. La descarga la hace el main (el renderer tiene la red cortada por CSP), lo que baja NO se ejecuta para saber qué es —se lee con el mismo parseo estático— y si no declara `createEffect` ni `createInstrument` no llega al disco. Tras instalar se re-escanea: el plugin aparece sin reiniciar | v1.9 |
| **Plugins JS de instrumento** (`createInstrument`): canal propio en el rack, con bypass si falla | v1.0 |
| Galería de plugins de la comunidad en el browser | v1+ |
| Puente CLAP / VST3 vía proceso host nativo (necesita host nativo con GUI embebida: proyecto aparte) | v1+ |

| **Galería firmada** (v2.7): el índice puede ir firmado (ECDSA P-256) y la firma cubre el **hash de cada plugin**, así que al instalar se comprueba que el archivo es exactamente el que se publicó. Confianza al primer uso, como SSH: la primera clave queda aceptada y un cambio **para la galería en seco** hasta que alguien compare las huellas. `tools/gallery-sign.ts` es el otro lado (generar clave y firmar) | v2.7 |

## 17. Rendimiento y fiabilidad

| Función | Versión |
|---|---|
| Kernel DSP en un solo AudioWorklet, cero GC en el audio thread | v0.1 |
| Medidor de CPU en la barra de transporte (aviso por color al cargarse) | v0.2 |
| Proyecto de 100 pistas sin dropouts (objetivo QA) | v0.1 |
| Golden tests del DSP (render determinista) — 778 tests en total | v0.1 |
| **El cierre del loop suelta las voces del pase anterior** (y saltar el playhead, también). Una nota que acababa justo en el final del patrón no encontraba nunca su note-off, se quedaba sonando vuelta tras vuelta —el sonido se solapaba consigo mismo— y al llenarse el pool de 64 voces se robaba la más antigua: parecía que se cortaba la PRIMERA nota mientras las de más adelante sonaban | v1.4 |
| **El playhead que amanece fuera del loop vuelve dentro**. La condición de envolver exigía `posBeats < loopEnd`, imposible al pasar de la canción (beat 200) al patrón (loop de 4): el cursor subía para siempre, no se disparaba ni un evento y no volvía a sonar nada hasta reiniciar la app. Pasaba igual con un seek más allá del final y al recortar el patrón por debajo del cursor. Además PAT y SONG llevan playheads independientes, que es donde nacía el disparate | v2.1 |
| Autosave + crash recovery (banner Recuperar/Descartar al reabrir) | v0.2 |
