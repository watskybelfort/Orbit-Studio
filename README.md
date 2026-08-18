# Orbit Studio

**El DAW de Orbit.** Un estudio de producción musical completo, hecho desde cero:
secuenciador, piano roll, playlist, mixer con cadenas de efectos, síntesis propia,
librería de sonidos clasificada, colaboración en tiempo real y Claude integrado
como un productor más dentro del proyecto.

![Orbit Studio — tema oscuro](docs/img/hero-dark.png)

> La escena de arriba la montó **Claude en vivo** por el bridge MCP: canales,
> steps, 808 con slide, limiter en el master, clip en la playlist y análisis de
> mezcla — cada tool call aparece en su panel (derecha) mientras la UI se
> actualiza en tiempo real.

## Tres temas, mismo estudio

| Claro | Acrílico (blur DWM real) |
|---|---|
| ![Tema claro](docs/img/hero-light.png) | ![Tema acrílico](docs/img/hero-acrylic.png) |

Minimalista, iconografía propia estilo Mac, semáforo de macOS opcional y
customizador integrado (acento, transparencia y tinte del vidrio, temas
guardables con nombre).

## Los cinco pilares

1. **Motor de audio propio** — DSP sample-accurate en un AudioWorklet: 10
   instrumentos (sustractivo, supersaw, FM, 808 con glide, drums sintetizados
   en 3 kits, sampler, slicer, formantes, y los dos de presets — Nova y Prisma)
   y 14 efectos (EQ paramétrico, compresor con sidechain
   real, limiter lookahead, reverb, delay sync, auto-filter con LFO,
   mono-maker…), con **4 inserts propios por canal** además del mixer de 26
   pistas con routing libre y sends. El ADN sonoro
   viene del engine con el que ya producimos el catálogo de El Doctor.
2. **Flujo FL Studio completo** — Channel Rack con step sequencer (16/32/64),
   Piano Roll con slide notes, escalas y ghost notes, Playlist con clips y
   arrangements, editor de automatización con curvas de tensión, Mixer con 10
   slots de efectos por pista. Export offline a WAV 16/24/32, stems por pista
   y normalización a -14 LUFS.
3. **Librería clasificada** — pack de fábrica *Orbit Essentials* (60 sonidos
   generados por síntesis propia) con categorías, tags de género/tonalidad/BPM,
   búsqueda instantánea y preview renderizado por el propio kernel.
4. **Colaboración en tiempo real** — el proyecto es un log de comandos sobre
   CRDT (Yjs): salas por código de 6 letras, servidor propio con persistencia,
   convergencia sin conflictos y undo POR USUARIO (tu Ctrl+Z no deshace lo del
   otro).
5. **Claude dentro del estudio** — la app expone un servidor MCP con 20 tools
   (`.mcp.json` en el repo): Claude lee el proyecto, escribe notas, programa
   steps, ajusta la mezcla, añade efectos, renderiza y analiza LUFS/balance —
   todo por el mismo bus de comandos, visible en vivo y deshacible.

## Instalación

Descarga `Orbit-Studio-Setup-<versión>.exe` de la [última release](https://github.com/watskybelfort/Orbit-Studio/releases)
(Windows x64, instalación en un clic, pack de sonidos incluido). Para
regenerarlo: `npm run dist` en `apps/desktop`.

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # Electron + Vite (la app)
npm run server     # servidor de colaboración (puerto 7900)
npm test           # 280 tests (core, engine, collab, claude-bridge, sound-library, ui)
```

> Si tras `npm install` Electron no arranca (allow-scripts se salta su
> postinstall): `cd node_modules/electron && node install.js`.

**Claude como colaborador:** abre la carpeta con Claude Code y la app en
marcha; el `.mcp.json` del repo conecta el bridge (stdio → WS local 7855) y las
20 tools aparecen solas. Todo lo que haga Claude sale en su panel (menú Ver →
Panel de Claude).

## Estado

**v1.4.0 — "por dónde entra la gente".** El servidor de la sala ya no es "aquí o
en todas partes": el panel trae un desplegable **"Escucha en"** con las
direcciones reales de la máquina, etiquetadas y ordenadas —Radmin VPN y demás
VPN primero, después la LAN, y al final lo virtual y el 169.254—, además de
"solo esta máquina" y "todas las redes". Se elige, se arranca, y el servidor
queda atado justo a esa dirección.

Si la IP elegida ya no está (el VPN apagado), arranca en local y lo dice en vez
de no arrancar. Y como, atado a una IP concreta, `localhost` deja de responder
hasta para quien hospeda, el panel enseña la dirección que hay que repartir, la
copia al portapapeles y ofrece dejarla también en tu propio campo Servidor.

**v1.3.0 — "que se vea quién toca".** Dos cosas que se piden solas cuando el
estudio ya funciona: saber qué está sonando y caber más de dos en una sesión.

**Las teclas se iluminan mientras suenan.** El teclado lateral del Piano Roll y
el de audición de Orbit Prisma encienden la tecla que suena: la que pulsas con
el ratón, con la fila Z/Q del PC o con el MIDI, y también las que dispara el
secuenciador durante la reproducción. El dato lo da el KERNEL (`MeterFrame.notes`,
una entrada por voz sin soltar), así que se enciende lo que suena de verdad; lo
que tienes pulsado se suma aparte para que la tecla responda en el mismo gesto,
sin esperar al siguiente frame de medidores.

**Salas de más de dos.** El aforo era una constante escondida: ahora se elige en
el panel ("Caben", 2–64) o con `ORBIT_ROOM_CAPACITY`, `/health` lo publica y el
panel dice "N conectados de M". Al que no cabe se le cierra con el motivo dentro
y el cliente deja de reintentar en silencio: se lee "La sala está llena" en
pantalla. Cada persona tiene **su color** aunque tres entren llamándose
"Productor" — quien choca con alguien de `clientId` más bajo se aparta al primer
color libre y la lista numera los nombres repetidos. Y el servidor que arranca la
app puede **abrirse a la red** (casilla, apagada por defecto) para hospedar por
LAN o VPN, enseñando las direcciones para compartir y avisando de que la sala no
lleva contraseña.

**v1.2.0 — "la casa en orden".** Auditoría extensa cerrada: aislamiento de los
plugins JS, endurecimiento del servidor y de Electron, render offline en un
worker, `mixerTrack` por carril de la playlist y botón para arrancar el servidor
desde el panel.

### v1.1.0 — "cada sonido a solas"

Lo que faltaba para trabajar un sonido sin salir de él, y tres bugs que hacían
que el estudio pareciera caprichoso.

**Orbit Prisma**, el instrumento grande de presets: **125 sonidos** en 16
categorías, hasta cuatro capas por preset sobre **nueve motores propios** (tabla
de ondas con morph, pulso PWM, ruido filtrado, FM con realimentación, cuerda
pulsada, órgano aditivo, campana inarmónica, formantes vocales y sub), filtro
con envolvente y keytrack, envolvente de modulación, LFO por voz, unísono, modo
Poly/Mono/Legato y **ocho macros por preset**. Sus 38 perillas son absolutas: el
preset las carga y a partir de ahí mandas tú.

**Editor de sonido por canal** (doble clic en el rack): las perillas del
instrumento, el recorte del sample con la onda y las marcas de start/end
arrastrables —acortar, invertir el tiempo, invertir la fase, fades, loop— y
**cuatro inserts propios del canal**, para bajarle el reverb a UN sonido sin
tocar los demás de su pista.

**Borrar patrones** desde cinco sitios (paleta, menú, atajo, vista Live y piano
roll), diciendo cuántos clips se lleva y con el patrón activo saltando solo.

**Tres bugs que se notaban a diario**: en colaboración viajaban los comandos
pero **nunca los bytes de los sonidos**, así que lo que ponía uno sonaba o no
según lo que el otro hubiera pinchado antes; los menús contextuales se
recortaban dentro de los editores (siempre en la playlist, solo en tema acrílico
en el resto) y el z-order de las ventanas crecía sin techo hasta tapar la paleta
de comandos; y el shim de escala no se instalaba al 100 %, así que desacoplar un
editor antes de tocar el zoom dejaba todos sus clics desplazados.

### v1.0.0 — "el estudio completo"

La update grande anterior: cinco bloques cerrados a la vez.

**Orbit Nova**, el instrumento de presets — 26 sonidos en 8 categorías, cada
uno una pila de capas sobre los motores propios (no hay samples que cargar: el
canal guarda el id del preset y sus macros), con 8 perillas fijas, 2 macros que
toman su nombre del preset y su browser dentro del instrumento.

**Paridad FL**: compases variables y **tempo por marcador**, **historial de undo
navegable** (saltas a cualquier punto sin romper el undo por origen),
herramientas **Pincel / Cortar** en el piano roll, **riff machine** determinista
por semilla, **graph editor de velocity**, randomizar/humanizar, filtros de
canal y **count-in**.

**Audio pro**: **pitch-shift de clips** (mismo motor SOLA que el time-stretch, y
se combinan), **afinador de tomas** por PSOLA con escala, **transientes y
troceado**, **convolución** particionada con IR sintética, **vinyl/lo-fi**,
**carriles de toma** para comping y **congelar pista**.

**Instrumentos y librería**: **Orbit Vox** (formantes) y **Orbit Slicer**,
**plugins JS de instrumento**, browser con filtros combinables, favoritos,
volumen de preview y **detección automática de BPM y tonalidad**, y
**plantillas** de trap, boom bap, reggaetón y voz sobre beat.

**Estudio y entrega**: layouts de ventanas, **escala de UI 80–150 %**, fuentes y
radios, tema exportable a archivo, **Ctrl+E**, export de la selección, info del
proyecto, colaboración con **modo seguidor**, **chat anclado al timeline** y
**permisos por rol**, y el **asistente de mezcla de Claude** (`advise_mix`), que
diagnostica LUFS, bandas y fase y propone la cadena con valores reales.

Qué entró en cada versión está auditado línea a línea en
[docs/FEATURES.md](docs/FEATURES.md); lo que se quedó fuera, con su motivo, en
[docs/PLAN.md](docs/PLAN.md).

## Documentación

| Documento | Qué contiene |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Plan por fases y estado real |
| [docs/FEATURES.md](docs/FEATURES.md) | Catálogo completo de funciones (v0.1 / v0.x / v1+) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Arquitectura técnica del monorepo |
| [docs/THEMING.md](docs/THEMING.md) | Sistema de temas: oscuro, claro, acrílico, semáforo Mac |
| [docs/COLLAB.md](docs/COLLAB.md) | Colaboración en tiempo real |
| [docs/CLAUDE-INTEGRATION.md](docs/CLAUDE-INTEGRATION.md) | Claude como colaborador (MCP) |
| [docs/PLUGINS.md](docs/PLUGINS.md) | SDK de plugins JS (efectos de usuario) con ejemplo |

## Estructura

```
orbit-studio/
├─ apps/
│  ├─ desktop/        Shell Electron (ventana, acrílico DWM, IPC, bridge host)
│  └─ server/         Servidor de colaboración (rooms, persistencia)
├─ packages/
│  ├─ core/           Modelo de proyecto, bus de comandos, undo, formato .orbit
│  ├─ engine/         Motor de audio DSP (AudioWorklet + render offline)
│  ├─ ui/             Interfaz React (rack, piano roll, playlist, mixer, browser…)
│  ├─ collab/         Sesión Yjs + protocolo y-websocket
│  ├─ claude-bridge/  Tools MCP + executor + relay stdio⇄WS
│  └─ sound-library/  Pack de fábrica generado por síntesis + manifest
├─ tools/qa/          QA en vivo: driver CDP y beat de prueba por el bridge
└─ docs/              Toda la documentación
```
