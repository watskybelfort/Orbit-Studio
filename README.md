# Orbit Studio

![versión](https://img.shields.io/badge/versi%C3%B3n-v2.8.0-5aa9e6)
![tests](https://img.shields.io/badge/tests-964%20passing-7ce65a)
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
   CRDT (Yjs): salas por código de 6 letras **con contraseña opcional que nunca
   viaja**, **aforo ajustable (2–64)**, servidor propio que puedes atar a la
   dirección que quieras (localhost, la IP del VPN, la de la LAN o todas),
   convergencia sin conflictos, roles que reparte y hace cumplir el servidor,
   chat anclado al timeline, modo seguidor y undo POR USUARIO (tu Ctrl+Z no
   deshace lo del otro).
5. **Claude dentro del estudio** — la app expone un servidor MCP con **21 tools**
   (`.mcp.json` en el repo): Claude lee el proyecto, escribe notas, programa
   steps, ajusta la mezcla, añade efectos, renderiza y analiza LUFS/balance —
   todo por el mismo bus de comandos, visible en vivo y deshacible.

## Lo último

**v2.8.0 — "el códec propio".** Orbit exporta `.opus` con un códec **escrito
entero en casa**: range coder, MDCT, PVQ, cuantización de energía, asignador de
bits y contenedor Ogg. Sin librerías de terceros.

La referencia es la implementación normativa de la **RFC 6716**, extraída del
propio documento y verificada por SHA-1. Las 721 constantes del formato no están
copiadas a mano: las saca un script del fuente.

Y que funciona no es una opinión: `npx tsx tools/qa/opus-verify.ts` codifica con
Orbit y le pide a **ffmpeg** que lo decodifique. Doce configuraciones —mono y
estéreo, tramas de 2,5 a 20 ms, de 32 a 256 kbps— con correlación **0,997 a
1,000** contra el original, retardo cero y ganancia 1,000.

Esa comprobación externa existe por algo concreto. Dos de los bugs más difíciles
fueron una división que redondeaba hacia −∞ donde C trunca hacia cero, y un `+1`
de más en la cuenta de bits gastados. **Los dos lados de Orbit compartían el
error**, así que la ida y vuelta contra nuestro propio decodificador pasaba en
verde mientras el archivo era ilegible para cualquier otro. Ningún test interno
los habría pillado: sólo los vio ffmpeg.

El encoder sigue tomando las decisiones conservadoras —sin postfiltro, sin
detección de transitorios, dispersión fija—, que son *decisiones* y no sintaxis:
dan un archivo válido que suena algo peor que el de libopus a igualdad de bits,
no uno roto.

## Roadmap

Lo que hay pensado a continuación. Nada de esto está prometido con fecha: se
saca cuando toca, en el mismo orden en que estorba no tenerlo. Este roadmap se
rehízo tras la **auditoría profunda de la v2.8** (diagnóstico + reparación de
todo el árbol, 6 zonas, ~40 arreglos con test): las tres primeras filas de
"Siguiente" salen justo de lo que esa revisión dejó medido y deferido.

### Siguiente

| Qué | Por qué |
|---|---|
| **Tocar y grabar con un controlador MIDI** | Web MIDI: teclado/pads físicos que iluminen las teclas ya soportadas y graben directo al patrón. Es la entrada que más se echa en falta para producir de verdad |
| **Monitor de entrada y efectos en vivo sobre el micro** | Oír la voz/instrumento con la cadena del canal puesta mientras se graba, no solo después |
| **Clic de la cuenta atrás con el transporte parado** | Grabar desde el compás 1 enseña el conteo pero no suena (el kernel solo hace clic rodando); falta un generador de clic por AudioContext durante la espera |
| **Afinar el encoder Opus** | Ya produce archivos que abre cualquiera a correlación ~1,0; le faltan las decisiones finas —postfiltro, transitorios, dispersión e intensidad estéreo adaptativas, VBR por trama— que lo acercarían a libopus en calidad por bit. (La trama de silencio desincroniza la energía en teoría, pero se midió contra ffmpeg: ~0,2 dB durante <50 ms y se auto-corrige) |
| **Instrumentos multisample (keymaps)** | Un sampler con varias muestras repartidas por el teclado y por velocidad, no una sola por canal |

### Más adelante

| Qué | Por qué |
|---|---|
| **Buses y grupos de mezcla de verdad** | Carpetas del rack que sumen a un bus con su propia cadena, además del enrutado por cables que ya hay |
| **Analizador de espectro por pista y medidor de LUFS integrado** | Ver el espectro y la sonoridad de cada strip, y normalizar el export a un objetivo (−14 LUFS y compañía) sin salir de la app |
| **Historial en árbol y biblioteca de plantillas** | Deshacer que no pierda ramas al divergir, y arrancar proyectos desde plantillas con nombre |
| **Optimizaciones del motor medidas en la auditoría** | Descargar samples que ya no usa nadie (hoy la RAM del worklet solo crece), export de stems en UNA petición al worker (hoy clona los samples por stem), suavizado de coeficientes al automatizar EQ/filtros, y flush de denormales en las colas de reverb |

### Horizonte

| Qué | Estado |
|---|---|
| **Puente CLAP / VST3** | Necesita un host nativo con GUI embebida: proyecto aparte, no un rato |
| **SDK de plugins con interfaz propia** | Que un plugin JS pueda pintar su propia UI (canvas) además de declarar perillas |
| **Export de vídeo para visuales** | Un visualizador que renderice el tema a vídeo; fuera del alcance del DAW hasta que el resto esté redondo |
| **Kernel con SIMD (WASM)** | Llevar el hilo de audio a WebAssembly con SIMD y un pool de voces para acercarse a "cero alocaciones por bloque" |

## Encoder Opus propio

Orbit exporta `.opus` con un **códec escrito entero en casa**: range coder,
MDCT, PVQ, cuantización de energía, asignador de bits y contenedor Ogg. Sin
librerías de terceros.

La referencia es la implementación normativa incluida en la **RFC 6716**
(Apéndice A), extraída del propio documento y verificada por SHA-1
(`86a927223e73d2476646a1b933fcd3fffb6ecc8c`). Las 721 constantes del formato no
están copiadas a mano: las extrae `tools/opus-tables.ts` del fuente, con
aserciones de tamaño e invariantes.

### Que funciona no es una opinión

```bash
npx tsx tools/qa/opus-verify.ts
```

Genera audio, lo codifica con Orbit y se lo da a **ffmpeg** para que lo
decodifique. Doce configuraciones —mono y estéreo, tramas de 2,5 a 20 ms, de 32
a 256 kbps— con correlación **0,997 a 1,000** contra el original, retardo cero y
ganancia 1,000.

Esa comprobación externa existe por una razón muy concreta, y hay dos bugs de
esta implementación que la justifican: una división entera que redondeaba hacia
−∞ donde C trunca hacia cero, y un `+1` de más en la cuenta de bits gastados.
Los dos lados de Orbit compartían el error, así que la ida y vuelta contra
nuestro propio decodificador pasaba en verde mientras el archivo era ilegible
para cualquier otro. Ningún test interno los habría pillado. **Sólo los vio
ffmpeg.**

### Lo que todavía no hace

El encoder toma las decisiones conservadoras: sin postfiltro, sin detección de
transitorios y con dispersión fija. Eso son **decisiones**, no sintaxis — dan un
archivo válido que suena algo peor que el de libopus a igualdad de bits, no uno
roto. Sí están el dynalloc (refuerzo a las bandas que sobresalen sobre sus
vecinas, sin el cual un tono puro suena sucio a bitrate medio) y la elección
intra/inter de la energía, que se decide **codificando las dos y quedándose con
la que menos recorta**.

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # Electron + Vite (la app) — renderer en localhost:5900
npm run server     # servidor de colaboración (puerto 7900)
npm test           # 964 tests (core, engine, collab, claude-bridge, sound-library, ui, server, desktop)
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
