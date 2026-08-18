# Orbit Studio

![versión](https://img.shields.io/badge/versi%C3%B3n-v1.9.0-5aa9e6)
![tests](https://img.shields.io/badge/tests-617%20passing-7ce65a)
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

**v1.9.0 — "mirar atrás y repartir".** Otras tres del "Siguiente".

**Versiones con diff musical.** El proyecto se guarda entero como versión (una
en cada Ctrl+S, y las que pidas con nombre) y cada una se despliega con **lo
que ha cambiado desde entonces contado en música**: "+3 notas en «Patrón 1» ·
Kit", "Canal nuevo «Voz»", "Tempo 140 → 76.25", "fader +2.5 dB". Las notas se
casan por id, así que mover una no se cuenta como borrarla y crearla. Y
restaurar guarda antes el estado de ahora: volver atrás no es una puerta de un
solo sentido.

**Galería de plugins.** El SDK está desde v0.7, pero compartirlos era mandarse
el `.js` por ahí. Ahora se añaden **fuentes** (un índice JSON publicado donde
quieras) y se instala de un clic. Lo que baja no se ejecuta para averiguar qué
es: se lee con el mismo parseo estático de siempre y, si no declara
`createEffect` ni `createInstrument`, no llega al disco.

**El OGG deja de estar descartado.** Lo que faltaba no era un códec: era el
**contenedor**. Un `.ogg` de Orbit es Ogg FLAC — sin pérdida, del mismo
encoder que ya sonaba bit-exacto — y ffmpeg lo decodifica muestra a muestra
igual que el original. Y el **streaming del master ya no viaja crudo**: ADPCM
propio, 192 kbit/s en vez de 768, con cada trozo independiente para que un
paquete perdido no arrastre al siguiente. (Opus entero sigue fuera: eso es un
códec completo, no un envoltorio.)

**v1.8.0 — "quién manda y qué se oye".** Las tres del "Siguiente".

**El rol ya no es lo que tú digas.** Hasta ahora cada cliente declaraba el
suyo y los demás lo creían: cambiar un campo bastaba para ascender a productor
y borrarle el proyecto a otro. Ahora **lo reparte la sala** — el primero que
entra manda y desde su lista cambia el de los demás; si se va, hereda el más
antiguo — y el **servidor vigila el log**: cada cambio se juzga con el rol que
él tiene apuntado y lo que no pasa se retira. El que lo intentó ve su propio
proyecto volver a lo que dice la sala.

**Oír el master del otro.** El proyecto converge, pero lo que suena no: cada
uno renderiza en su máquina. Con **"Emitir mi master"** tu salida final viaja a
la sala y el botón **Oír** de cada fila la reproduce en la tuya, con su propio
volumen y sin tocar nada del proyecto. Se acabó el "¿lo estás oyendo igual que
yo?".

**Packs con más cuerpo.** A las diez familias de one-shots se suman **loops de
verdad**: melódicos con progresión (la de cada género: i–VI–III–VII para el
trap, i–VII–VI–V para el drill…), breaks de batería con su bombo, su caja y sus
hats —con redoble de tresillos al cerrar en trap y drill— y líneas de 808 que
siguen los acordes con glide. Salen al tempo del estilo, con su tonalidad, y
cortados **exactos en el beat** para que encajen con cualquier proyecto.

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
| **Contraseña de sala** | El rol ya lo decide el servidor, pero entrar sigue siendo saber el código: la puerta es lo siguiente |
| **Packs con estructura entera** | Un loop de cuatro compases no es un beat: encadenar secciones (intro, drop, vuelta) es otro problema |
| **Comparar dos versiones cualesquiera** | El diff musical ya está; hoy compara contra el proyecto de ahora, y falta versión contra versión |

### Después

| Qué | Por qué |
|---|---|
| **Nodos con más que enrutado** | El graph editor recablea lo que el modelo ya sabe expresar; meter procesos propios en el grafo (splits, sumas raras) es cambiar el motor |
| **Galería con firma** | La galería ya trae plugins de terceros; que el índice vaya firmado es lo que falta para confiar en uno que no conoces |
| **Encoder Opus propio** | El `.ogg` (Ogg FLAC) cubre el formato y el ADPCM el streaming, pero con pérdida y calidad de radio: Opus sería lo bueno, y es un proyecto entero |

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
npm test           # 617 tests (core, engine, collab, claude-bridge, sound-library, ui, server, desktop)
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
