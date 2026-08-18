# Orbit Studio

![versión](https://img.shields.io/badge/versi%C3%B3n-v1.7.0-5aa9e6)
![tests](https://img.shields.io/badge/tests-545%20passing-7ce65a)
![plataforma](https://img.shields.io/badge/Windows-x64-b45ae6)
![stack](https://img.shields.io/badge/Electron%20%2B%20React%20%2B%20AudioWorklet-e6935a)

**El DAW de Orbit.** Un estudio de producción musical completo, hecho desde cero:
secuenciador, piano roll, playlist, mixer con cadenas de efectos, síntesis propia,
librería de sonidos clasificada, colaboración en tiempo real y Claude integrado
como un productor más dentro del proyecto.

![Orbit Studio — tema oscuro](docs/img/hero-dark.png)

> La escena de arriba la montó **Claude en vivo** por el bridge MCP: canales,
> steps, 808 con slide, limiter en el master, clip en la playlist y análisis de
> mezcla — cada tool call aparece en su panel (derecha) mientras la UI se
> actualiza en tiempo real.

## Descargar

**[→ Última release](https://github.com/watskybelfort/Orbit-Studio/releases/latest)** —
`Orbit-Studio-Setup-<versión>.exe`, Windows x64, instalación en un clic y con el
pack de sonidos dentro. No hay nada que configurar después.

El instalador no lleva firma de editor, así que SmartScreen avisa la primera vez:
*Más información → Ejecutar de todas formas*. Para regenerarlo tú mismo,
`npm run dist` en `apps/desktop`.

## Tres temas, mismo estudio

| Claro | Acrílico (blur DWM real) |
|---|---|
| ![Tema claro](docs/img/hero-light.png) | ![Tema acrílico](docs/img/hero-acrylic.png) |

Minimalista, iconografía propia estilo Mac, semáforo de macOS opcional y
customizador integrado (acento, transparencia y tinte del vidrio, temas
guardables con nombre).

## Los cinco pilares

1. **Motor de audio propio** — DSP sample-accurate en un AudioWorklet: **10
   instrumentos** (sustractivo, supersaw, FM, 808 con glide, drums sintetizados
   en 3 kits, sampler, slicer, formantes y los dos de presets, Nova y Prisma) y
   **16 efectos** (EQ paramétrico, compresor con sidechain real, limiter
   lookahead, reverb, convolución, delay sync, auto-filter con LFO, vinyl,
   gate, mono-maker…), con **4 inserts propios por canal** además del mixer de
   26 pistas con routing libre y sends. El ADN sonoro viene del engine con el
   que ya producimos el catálogo de El Doctor.
2. **Flujo FL Studio completo** — Channel Rack con step sequencer (16/32/64),
   Piano Roll con slide notes, escalas, ghost notes y **teclas que se iluminan
   con lo que suena**, Playlist con clips y arrangements, editor de
   automatización con curvas de tensión y LFOs, Mixer con 10 slots por pista.
   Export offline a WAV 16/24/32, FLAC, MP3, stems por pista y normalización a
   -14 LUFS.
3. **Librería clasificada** — pack de fábrica *Orbit Essentials* (**84 sonidos**
   generados por síntesis propia) con categorías, tags de género/tonalidad/BPM,
   detección automática de BPM y tonalidad, búsqueda instantánea y preview
   renderizado por el propio kernel.
4. **Colaboración en tiempo real** — el proyecto es un log de comandos sobre
   CRDT (Yjs): salas por código de 6 letras, **aforo ajustable (2–64)**,
   servidor propio que puedes atar a la dirección que quieras (localhost, la IP
   del VPN, la de la LAN o todas), convergencia sin conflictos, roles, chat
   anclado al timeline, modo seguidor y undo POR USUARIO (tu Ctrl+Z no deshace
   lo del otro).
5. **Claude dentro del estudio** — la app expone un servidor MCP con **21 tools**
   (`.mcp.json` en el repo): Claude lee el proyecto, escribe notas, programa
   steps, ajusta la mezcla, añade efectos, renderiza y analiza LUFS/balance —
   todo por el mismo bus de comandos, visible en vivo y deshacible.

## Lo último

**v1.7.0 — "el cable y el sonido".** Se vacía el "Siguiente" del roadmap.

**El enrutado, como grafo.** Ventana **Enrutado**: el camino entero de la
señal a la vista —canales y carriles de audio a la izquierda, pistas de mixer
repartidas por columnas según lo lejos que estén del master, la salida de cada
una en línea llena y sus envíos de puntos con su nivel—. Y se recablea
arrastrando: del puerto de un canal a otra pista para cambiarlo de sitio, del
▸ de una pista para cambiar a dónde desemboca, del ⇢ para añadir un envío. Si
el cable cerraría un **bucle**, se pinta en rojo y no se guarda — el compilador
tolera los ciclos, pero lo que suena entonces no es lo que nadie quería.

**Packs de sonidos a medida.** "Dame 12 hats de drill" y salen: se
**renderizan con el mismo motor que suena en vivo**, se normalizan y aterrizan
en la librería, listos para arrastrar al rack o a la playlist. Diez familias
(kicks, snares, claps, hats, open hats, percusión, 808s, impactos, risers,
downlifters) por siete estilos, con las variaciones repartidas por todo el
rango de la familia —de lo más oscuro a lo más brillante— y deterministas: el
mismo encargo da siempre el mismo pack. Se pide desde el browser o dándoselo a
Claude por su tool nueva (`generate_pack`), que además puede meterte cada
sonido en su canal.

**v1.6.0 — "cada ventana en su monitor".** Las otras dos del roadmap.

**Multi-ventana de verdad.** Sacar un editor a su propia ventana ya no es un
apaño: **recuerda dónde estaba** (monitor incluido) y vuelve a salir ahí al
abrir la app al día siguiente, así que el mixer se queda a vivir en la segunda
pantalla. Si ese monitor ya no está, arranca donde se vea —una ventana
restaurada fuera de pantalla existe, roba el foco y no hay forma de agarrarla—.
Cada una trae su barra con **siempre encima** y **devolver**, y sobre todo: el
**teclado funciona dentro**. Antes, un piano roll en el segundo monitor era un
editor mudo (espacio, Ctrl+Z, F5, la fila Z/Q del piano… todo escuchaba en la
ventana principal); ahora sus teclas se reenvían allí, salvo lo que estés
escribiendo en un campo de texto.

**Arrastrar canales entre carpetas.** El nombre del canal es el asa: suéltalo
sobre otra fila y queda encima o debajo de ella **con la carpeta de esa fila**;
sobre la cabecera de una carpeta, entra al final; y en la zona de sueltos —que
se dibuja sola en cuanto empiezas a arrastrar— sale de la suya. Guía de
inserción mientras arrastras y **un solo Ctrl+Z** para deshacerlo entero,
carpeta y sitio.

**v1.5.0 — "cada cosa en su sitio".** Dos del roadmap, terminadas.

**El Slicer trocea por los golpes.** En la pestaña Sonido de un canal Slicer
tienes la onda con los cortes numerados encima y el botón que los pone **en los
transientes** (tres grados de detalle, del golpe gordo al hi-hat). Los cortes
son del canal, se guardan con el proyecto y se retocan a mano: arrastrar mueve
uno, doble clic añade, el derecho quita. Sin cortes propios el motor reparte en
partes iguales exactamente como siempre.

**Carpetas en el Channel Rack.** Cabecera con su color, plegado, contador y
M/S de todo el grupo; el menú del canal mueve, saca o crea carpeta con él. Es
organización pura —no hay bus de carpeta—: el mute del grupo se le hace a sus
canales en un solo paso de undo, y deshacer la carpeta los deja sueltos sin
borrar nada.

**v1.4.1 — el loop ya no se pisa a sí mismo.** Una nota que acababa justo en el
final del patrón no encontraba nunca su note-off: seguía sonando vuelta tras
vuelta, el sonido se solapaba consigo mismo y, al llenarse el pool de 64 voces,
se robaba la más antigua — parecía que se cortaba la **primera** nota mientras
las de más adelante sonaban. Ahora el cierre del loop (y el salto del playhead)
sueltan lo del pase anterior, con release: las colas siguen sonando. Además, al
dibujar una nota, **el arrastre horizontal le da la duración como en FL** y esa
duración queda de plantilla; el tirador del borde derecho es más fácil de
agarrar y el cursor lo delata.

Historial completo en [Releases](https://github.com/watskybelfort/Orbit-Studio/releases)
y, auditado línea a línea, en [docs/FEATURES.md](docs/FEATURES.md).

## Roadmap

Lo que hay pensado a continuación. Nada de esto está prometido con fecha: se
saca cuando toca, en el mismo orden en que estorba no tenerlo.

### Siguiente

| Qué | Por qué |
|---|---|
| **El servidor valida los roles** | Hoy el rol es autodeclarado (mismo modelo de confianza que el código de sala): que sea inviolable exige validar el log en el servidor |
| **Streaming del master de la sesión** | Cada cliente renderiza lo suyo; oír el master del otro cierra el "¿lo estás oyendo igual que yo?" |
| **Packs generados con más cuerpo** | Las familias de v1.7 son one-shots; los loops (melodías, breaks) piden armonía y estructura, no solo variación de parámetros |

### Después

| Qué | Por qué |
|---|---|
| **Historial de versiones con diff musical** | "¿Qué cambió en el drop?" respondido con música, no con bytes |
| **Galería de plugins de la comunidad** | El SDK de plugins JS ya está ([docs/PLUGINS.md](docs/PLUGINS.md)); falta el sitio donde compartirlos |
| **Nodos con más que enrutado** | El graph editor de v1.7 recablea lo que el modelo ya sabe expresar; meter procesos propios en el grafo (splits, sumas raras) es cambiar el motor |

### Horizonte

| Qué | Estado |
|---|---|
| **Puente CLAP / VST3** | Necesita un host nativo con GUI embebida: proyecto aparte, no un rato |
| **Export a OGG** | **Descartado con medida**: este Electron no admite contenedor Ogg en `MediaRecorder` y grabaría en tiempo real. El camino sensato es un encoder Opus propio, como se hizo con el FLAC |
| **Export de vídeo para visuales** | Fuera del alcance del DAW hasta que el resto esté redondo |

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # Electron + Vite (la app) — renderer en localhost:5900
npm run server     # servidor de colaboración (puerto 7900)
npm test           # 545 tests (core, engine, collab, claude-bridge, sound-library, ui, server, desktop)
npm run typecheck  # tsc --noEmit sobre todo el monorepo
```

> Si tras `npm install` Electron no arranca (allow-scripts se salta su
> postinstall): `cd node_modules/electron && node install.js`.

> El dev server usa el puerto **5900**: el 5173 de Vite cae dentro de un rango
> que Windows reserva para Hyper-V en algunas máquinas y moría con `EACCES`.

**Claude como colaborador:** abre la carpeta con Claude Code y la app en
marcha; el `.mcp.json` del repo conecta el bridge (stdio → WS local 7855) y las
21 tools aparecen solas. Todo lo que haga Claude sale en su panel (menú Ver →
Panel de Claude).

## Documentación

| Documento | Qué contiene |
|---|---|
| [docs/FEATURES.md](docs/FEATURES.md) | Catálogo completo de funciones, versión a versión |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitectura técnica del monorepo |
| [docs/COLLAB.md](docs/COLLAB.md) | Colaboración en tiempo real (salas, aforo, roles, samples) |
| [docs/CLAUDE-INTEGRATION.md](docs/CLAUDE-INTEGRATION.md) | Claude como colaborador (MCP) |
| [docs/PLUGINS.md](docs/PLUGINS.md) | SDK de plugins JS (efectos e instrumentos) con ejemplo |
| [docs/THEMING.md](docs/THEMING.md) | Sistema de temas: oscuro, claro, acrílico, semáforo Mac |
| [docs/PLAN.md](docs/PLAN.md) | Plan por fases, con lo que se quedó fuera y su motivo |

## Estructura

```
orbit-studio/
├─ apps/
│  ├─ desktop/        Shell Electron (ventana, acrílico DWM, IPC, bridge host)
│  └─ server/         Servidor de colaboración (rooms, aforo, persistencia)
├─ packages/
│  ├─ core/           Modelo de proyecto, bus de comandos, undo, formato .orbit
│  ├─ engine/         Motor de audio DSP (AudioWorklet + render offline)
│  ├─ ui/             Interfaz React (rack, piano roll, playlist, mixer, browser…)
│  ├─ collab/         Sesión Yjs + protocolo y-websocket
│  ├─ claude-bridge/  Tools MCP + executor + relay stdio⇄WS
│  └─ sound-library/  Pack de fábrica generado por síntesis + manifest
├─ tools/qa/          QA en vivo: driver CDP, peer de presencia, beat por el bridge
└─ docs/              Toda la documentación
```

## Historial

<details>
<summary><b>v1.2.0 — "la casa en orden"</b></summary>

Auditoría extensa cerrada: aislamiento de los plugins JS (parseo estático, CSP y
worker), endurecimiento del servidor y de Electron, token por sesión en el bridge,
render offline en un worker aislado, `mixerTrack` por carril de la playlist y
botón para arrancar el servidor desde el panel.

</details>

<details>
<summary><b>v1.1.0 — "cada sonido a solas"</b></summary>

**Orbit Prisma**, el instrumento grande de presets: **125 sonidos** en 16
categorías, hasta cuatro capas por preset sobre **nueve motores propios** (tabla
de ondas con morph, pulso PWM, ruido filtrado, FM con realimentación, cuerda
pulsada, órgano aditivo, campana inarmónica, formantes vocales y sub), filtro con
envolvente y keytrack, LFO por voz, unísono, modo Poly/Mono/Legato y **ocho
macros por preset**.

**Editor de sonido por canal** (doble clic en el rack): las perillas del
instrumento, el recorte del sample con la onda y las marcas de start/end
arrastrables —acortar, invertir el tiempo, invertir la fase, fades, loop— y
**cuatro inserts propios del canal**, para bajarle el reverb a UN sonido sin
tocar los demás de su pista.

Y tres bugs que se notaban a diario: en colaboración viajaban los comandos pero
**nunca los bytes de los sonidos**, los menús contextuales se recortaban dentro
de los editores, y el shim de escala no se instalaba al 100 %.

</details>

<details>
<summary><b>v1.0.0 — "el estudio completo"</b></summary>

**Orbit Nova** (26 presets sobre los motores propios), **paridad FL** (compases
variables, tempo por marcador, historial de undo navegable, pincel/cortar, riff
machine determinista, graph editor de velocity, count-in), **audio pro**
(pitch-shift de clips, afinador PSOLA, transientes, convolución particionada,
vinyl/lo-fi, carriles de toma y congelar pista), **Orbit Vox** y **Orbit
Slicer**, plugins JS de instrumento, detección de BPM y tonalidad, plantillas, y
el **asistente de mezcla de Claude** (`advise_mix`), que diagnostica LUFS, bandas
y fase y propone la cadena con valores reales.

</details>
