# Orbit Studio

![versión](https://img.shields.io/badge/versi%C3%B3n-v3.3.0-5aa9e6)
![tests](https://img.shields.io/badge/tests-1621%20passing-7ce65a)

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

## Los seis pilares

1. **Motor de audio propio** — DSP sample-accurate en un AudioWorklet: **10
   instrumentos** (sustractivo, supersaw, FM, 808 con glide, drums sintetizados
   en 3 kits, sampler **con multisample**, slicer, formantes y los dos de
   presets, Nova y Prisma) y

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
3. **Se toca y se graba** — controladores MIDI de verdad (cada dispositivo
   aparte, canal, octava, curva de pulsación, pedal de sostenido, **rueda de
   tono que reafina la voz viva** en los diez instrumentos y **MIDI learn**
   sobre cualquier perilla), grabación al patrón con el tiempo del evento y
   overdub por vuelta, **monitor de micro con la cadena del canal puesta** y
   tomas grabadas **en crudo por el kernel**, sin códec de por medio.
4. **Librería clasificada** — pack de fábrica *Orbit Essentials* (**84 sonidos
   en 132 grabaciones**, generados por síntesis propia, con los **24
   instrumentos en multisample**: tres alturas cada uno, repartidas por el
   teclado) con categorías, tags de género/tonalidad/BPM, detección automática
   de BPM y tonalidad, búsqueda instantánea, **selección múltiple y arrastre
   por grupos**, y preview renderizado por el propio kernel.
5. **Colaboración en tiempo real** — el proyecto es un log de comandos sobre

   CRDT (Yjs): salas por código de 6 letras **con contraseña opcional que nunca
   viaja**, **aforo ajustable (2–64)**, servidor propio que puedes atar a la
   dirección que quieras (localhost, la IP del VPN, la de la LAN o todas),
   convergencia sin conflictos, roles que reparte y hace cumplir el servidor,
   chat anclado al timeline, modo seguidor y undo POR USUARIO (tu Ctrl+Z no
   deshace lo del otro).
6. **Claude dentro del estudio** — la app expone un servidor MCP con **22 tools**

   (`.mcp.json` en el repo): Claude lee el proyecto, escribe notas, programa
   steps, ajusta la mezcla, añade efectos, renderiza y analiza LUFS/balance —
   todo por el mismo bus de comandos, visible en vivo y deshacible.

## Lo último

**v3.3.0 — "el piano responde a los dedos".** Los 24 instrumentos del pack se
grababan a tres alturas y con UNA pulsación: un piano golpeado flojo salía
igual que uno golpeado fuerte, solo más bajito. Ahora cada altura trae dos
grabaciones, y el instrumento entra en el rack repartido por el teclado *y* por
la fuerza.

**Bajar el fader no es tocar flojo.** En un instrumento de verdad la fuerza
cambia el TIMBRE, y cada familia con su moneda: en un piano acústico se empina
la caída espectral y se apaga el martillo (menos energía en el golpe, menos
parciales de arriba excitados); en uno eléctrico la pulsación **es** el índice
de FM, así que al tocar flojo desaparece el diente y queda la campana redonda
de debajo; en una cuerda pulsada es lo romo de la excitación —la yema contra la
uña—; en un bajo, cuánto se abre la envolvente de filtro; en una campana, el
badajo. Y en un órgano casi nada, que es la respuesta correcta: un Hammond no
responde a la pulsación, así que solo ceden el click de los contactos, la
percusión y los drawbars de arriba.

**Lo que no cambió es lo que más importa.** La capa fuerte es la síntesis de
siempre, y no de boquilla: al regenerar el pack, de los 133 archivos que ya
estaban el único que cambió es `manifest.json`. Los 132 WAV salen byte a byte
idénticos, así que ningún proyecto guardado suena hoy distinto que ayer.

**Las dos capas son la misma cuerda.** La pulsación no entra en la semilla del
ruido, y es justo lo contrario de lo que se hizo con la altura: dos alturas
suenan JUNTAS —un acorde— y compartiendo aleatoriedad se funden en una sola
fuente, mientras que dos capas de la misma nota no suenan nunca a la vez y
comparten desafinación, fases y deriva para que cruzar el borde de velocidad
suene a pegar más fuerte y no a cambiar de piano. De ahí sale la regla al tocar
cualquier síntesis del pack: la pulsación cambia amplitudes, índices y cortes,
nunca la estructura de los bucles.

El pack pasa de 42 a 70 MB y de 132 a 204 archivos. Y esto se mide, no se
opina: la capa floja es más oscura en los 24 instrumentos y en las tres
alturas, y tocada por el kernel —con el canal y el máster puestos— la misma
tecla a velocidad 0,25 sale entre un 6 % y un 46 % menos brillante que a 0,9.

<details>
<summary><b>v3.2.0 — "el pack suena a instrumentos"</b></summary>

Tres entregas que van juntas
porque las tres arreglan la misma cosa: que Orbit sonara a *muestras* y no a
*instrumentos*.

**El pack de fábrica, en multisample.** Los 24 instrumentos eran una muestra
estirada por cinco octavas — justo lo que la v3.1 vino a arreglar y que el pack
todavía no usaba. Ahora cada uno se graba en su registro natural y una octava a
cada lado, y entra en el rack ya repartido por el teclado. Que la altura fuera
un parámetro y no una constante sacó cuatro cosas que solo se ven al grabar el
mismo instrumento en dos octavas: las tres tomas de un pad compartían las fases
y la deriva del ruido (sonaban a una fuente doblada, no a una sección); los
filtros de los sintéticos no seguían a la nota (el pad grave brillante, el
agudo apagado, y el escalón justo al cruzar de zona); la cuerda pulsada iba
desafinada consigo misma porque su retardo estaba redondeado a muestras
enteras; y el tine 14:1 del piano eléctrico doblaba por encima del muestreo en
el registro alto. **Y el bajo del pack ahora suena donde dice el piano roll** —
antes, grabado en C2 y colocado en la tecla 60, sonaba dos octavas más abajo
que lo que enseñaba la pantalla.

De regalo, el techo de banda sube de 12 a 14 kHz: existía para dejar sitio al
estiramiento, y ahora el estiramiento es la sexta parte. En PCM el tamaño
depende de la duración, no del ancho de banda, así que son 2 kHz de aire
gratis. El pack pasa de 22 a 41 MB.

**La rueda de tono dobla el tono.** Entraba como un mando más: doblaba lo que
le hubieras asignado, o nada. Ahora reafina la voz VIVA, en los diez
instrumentos — cada uno con su moneda: frecuencia los sintes, ritmo de lectura
el sampler, la fundamental de la que cuelgan las capas en Nova y Prisma, y en
el kit la parte tonal *y* el filtro, porque un hat es ruido y no tiene altura
que doblar pero su banda sí se mueve. La otra mitad del trabajo es que el
kernel se guarda los semitonos por canal: una nota tocada con la rueda sujeta
**nace ya doblada**, en vez de trepar sola durante el ataque. Rango elegible
(±1 a ±24) y zona muerta en el centro, porque una rueda con muelle no vuelve
nunca al 8192 exacto.

**Muestras al keymap en bloque.** Montar un piano de treinta muestras eran
treinta arrastres y treinta deshaceres. Ahora el Browser tiene selección
múltiple (Ctrl y Mayús) y las cabeceras arrastran su grupo entero — una
categoría, una carpeta tuya, un pack generado — y el drop cae en un solo
deshacer, reparta zonas de keymap, canales del rack o clips de la playlist.
Por el camino salieron dos falsos positivos del auto-mapa que soltar una
carpeta habría vuelto lo normal: la nota se buscaba en la RUTA entera (una
carpeta llamada «Piano C3» colocaba las treinta muestras en el mismo do) y
`take01/02/03` se leían como las teclas 1, 2 y 3.

Y un tercero que no era de esta entrega: **el generador del pack llevaba roto**
y nadie podía verlo, porque `packages/*/generate` no estaba en el typecheck.

</details>

<details>
<summary><b>v3.1.0 — "el instrumento entero"</b></summary>

Un canal de sampler tenía UN sample y lo
estiraba por todo el teclado con keytrack: un piano grabado en do sonaba a
chipmunk dos octavas arriba y a monstruo dos abajo, porque cambiar la
velocidad de lectura mueve las formantes y el tiempo del ataque con el tono.

Ahora el canal admite un **keymap**: varias muestras repartidas por teclas y
por velocidad, cada una sonando a su nota real. Una zona es un rectángulo
(tecla × velocidad) con su muestra, su raíz, su afinación fina y su ganancia, y
las zonas **pueden solaparse a propósito** — así se hacen las capas suave/fuerte
y así se apilan dos micros de la misma toma.

Lo que hace que se use es el **auto-mapa**: se sueltan las muestras en el editor
y entran con su nota leída del nombre del archivo, repartiéndose los rangos
solas. Lo difícil ahí no es leer `Piano_C3.wav`, son los falsos positivos —
`Bass2.wav` no es un si y `Deep4.wav` no es un re—, y lo que no sabe leer lo
dice en vez de colocarlo a bulto: una nota en el sitio equivocado no se ve, se
descubre tocando. Claude lo monta también, con la tool `set_keymap`.

De regalo, un fallo que habría salido mudo: el recolector de samples del
**export** miraba solo el sample del canal, así que un instrumento multisample
se habría renderizado en silencio. Ahora esa decisión es una función pura con
sus pruebas.

</details>

<details>
<summary><b>v3.0.0 — "la toma en vivo"</b></summary>

 Orbit producía de maravilla y no se tocaba.
Esta versión cierra el agujero por el que entra el sonido de fuera: el
controlador MIDI, el micro y el clic de la cuenta.

Es un salto de versión mayor porque el estudio deja de ser una cosa en la que
solo se *programa* música: ahora se toca y se graba dentro. Y por debajo cambia
la forma del motor — el nodo del kernel tiene entrada, el protocolo de
medidores lleva la señal que entra, y la grabación ya no pasa por el navegador.

**El controlador, en serio.** Cada dispositivo se enciende y se apaga por su
cuenta, con su canal, su transposición por octavas y su curva de pulsación;
pedal de sostenido con los dos casos que dejan notas colgando resueltos
—repicar una tecla con el pedal pisado, apagar el teclado sin levantarlo—; y
**MIDI learn** sobre cualquier perilla o fader del programa: clic derecho,
mueves el mando y quedan casados. El mando escribe por el bus de comandos, así
que tiene undo y viaja a la sala, y un barrido entero es UN paso de undo.

**Grabar tocando cuadra donde tocaste.** La nota caía donde estaba el playhead
cuando la UI se enteraba, no cuando la tocaste: hasta 46 ms repartidos al azar.
Ahora se usa el sello del evento. La rejilla se elige (sin cuantizar incluido) y
lo tocado cae al patrón al cerrar CADA vuelta del loop, sin parar.

**El micro se oye con su cadena puesta.** El nodo del kernel tenía
`numberOfInputs: 0` —no había por dónde meter audio de fuera—. Ahora la entrada
se suma a su pista de mixer *antes* de los inserts: cantar oyendo el reverb y el
compresor que va a llevar la toma, no la voz seca. Medir el nivel y oírse son
dos interruptores distintos, que ajustar la ganancia no puede obligarte a montar
un acople.

**Y la toma se graba en crudo.** Esto era una pérdida de calidad escondida a
plena vista: la grabación la hacía `MediaRecorder`, que en este Electron solo
sabe **webm/opus**. Cada toma se comprimía con pérdida y se volvía a decodificar
para escribirla como un WAV de 24 bits que ya no tenía 24 bits de información.
Ahora las muestras vuelven del kernel tal cual —antes de la ganancia y de la
cadena— y van directas a WAV.

**La cuenta atrás suena.** El metrónomo del kernel solo clica rodando, así que
grabar desde el compás 1, donde no hay sitio por delante para el pre-roll,
enseñaba el conteo en pantalla y no sonaba nada. Ahora la cuenta la lleva el
kernel, con clics sample-accurate, y un beat después del último arranca él
mismo: la cuenta y el compás 1 comparten reloj.

</details>

## Roadmap

Lo que hay pensado a continuación. Nada de esto está prometido con fecha: se
saca cuando toca, en el mismo orden en que estorba no tenerlo. Las tres filas de
entrada en vivo que abrían este roadmap —controlador MIDI, monitor del micro y
clic de la cuenta— salieron en la **v3.0**; el multisample, en la **v3.1**; el
pack de fábrica en multisample, en la **v3.2**; y sus capas de fuerza, en la
**v3.3**. Lo de abajo es lo que dejaron detrás.

> **Ya en `main`, pendiente de release**: soltar archivos sueltos del
> Explorador al keymap, al rack y a la playlist —resultó no necesitar la
> decisión de seguridad que lo tenía parado, porque un arrastre de verdad trae
> los bytes y el proceso principal no ve ninguna ruta nueva— y **la rueda de
> tono grabada**, que ahora es un parámetro del canal con su curva de
> automatización.


### Siguiente

| Qué | Por qué |
|---|---|
| **Seguir afinando el encoder Opus** | La inclinación del reparto ya sale del espectro y con eso la distancia media a libopus bajó de −2,06 a −1,21 dB (ver `tools/qa/opus-quality.ts`). Queda el agujero tonal, −7,9 dB en el peor caso, y ahí lo que ayuda es el **postfiltro** — un predictor de tono que pide correr el decodificador dentro del encoder para no perder la sincronía del estado. Detrás van los transitorios, la intensidad estéreo y el VBR por trama. La dispersión adaptativa se implementó y NO entró: la SNR no ve lo que hace, salió neutra y sin poder demostrar la mejora no se sube — para decidirla hace falta una medida perceptual, no una de error. (La trama de silencio desincroniza la energía en teoría, pero se midió contra ffmpeg: ~0,2 dB durante <50 ms y se auto-corrige) |
| **Entradas de más de dos canales** | La entrada del kernel es estéreo fija: con una interfaz de 8 entradas se coge el par que el sistema ponga primero. Elegir el canal —o grabar varios a la vez— pide un nodo con más entradas y un enrutado por pista |

### Más adelante

| Qué | Por qué |
|---|---|
| **Una tercera capa de fuerza en el pack** | Con dos, el salto de flojo a fuerte cae en un sitio y se puede oír si buscas: una capa de en medio lo repartiría en dos escalones más pequeños. Son otras 72 grabaciones y otros 28 MB de instalador, y el salto que se gana de dos a tres es más pequeño que el que se ganó de una a dos — por eso está aquí y no arriba |
| **Buses y grupos de mezcla de verdad** | Carpetas del rack que sumen a un bus con su propia cadena, además del enrutado por cables que ya hay |
| **Analizador de espectro por pista y medidor de LUFS integrado** | Ver el espectro y la sonoridad de cada strip, y normalizar el export a un objetivo (−14 LUFS y compañía) sin salir de la app |
| **Historial en árbol y biblioteca de plantillas** | Deshacer que no pierda ramas al divergir, y arrancar proyectos desde plantillas con nombre |
| **Optimizaciones del motor medidas en la auditoría** | Descargar samples que ya no usa nadie (hoy la RAM del worklet solo crece), export de stems en UNA petición al worker (hoy clona los samples por stem), suavizado de coeficientes al automatizar EQ/filtros, y flush de denormales en las colas de reverb |
| **Compensación de latencia de la toma** | La toma entra por el mismo reloj de audio que el transporte, pero entre el micro y el kernel hay el buffer del sistema. Medirlo (bucle de calibración) y correr el clip esa cantidad dejaría la voz clavada sin tocar nada a mano |

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

Le faltan tres decisiones: **postfiltro**, **detección de transitorios** y
**dispersión adaptativa**. Eso son *decisiones*, no sintaxis — dan un archivo
válido que suena algo peor que el de libopus a igualdad de bits, no uno roto.

Sí están el dynalloc (refuerzo a las bandas que sobresalen sobre sus vecinas,
sin el cual un tono puro suena sucio a bitrate medio), la elección intra/inter
de la energía —que se decide **codificando las dos y quedándose con la que
menos recorta**— y la **inclinación del reparto**, que sale de la pendiente del
espectro en vez de estar fija en neutro.

### Cuánto se pierde por bit

```bash
npx tsx tools/qa/opus-quality.ts
```

La misma señal codificada con Orbit y con libopus al mismo bitrate, las dos
decodificadas con ffmpeg y comparadas con el original. Cuatro señales elegidas
por lo que ponen a prueba, cinco combinaciones de canales y bitrate. Hoy:

| | Orbit | libopus | distancia |
|---|---|---|---|
| Media de las 20 medidas | 15,53 dB | 16,74 dB | **−1,21 dB** |
| La peor (tonal, estéreo 96k) | 26,05 dB | 33,91 dB | −7,86 dB |

Lo tonal es el agujero que queda, y es donde ayudaría el postfiltro. En ruido y
en mezcla salimos por delante, y eso **no** es buena noticia: quiere decir que
gastamos bits donde libopus ya sabe que no hacen falta.

Y por eso el banco lleva escrito que la SNR es un apaño. Opus es perceptual: un
archivo con menos SNR puede sonar mejor. Vale para comparar dos versiones del
mismo encoder y para ver si la distancia se acorta, no como nota de calidad.
Cuando se probó la dispersión adaptativa, la medida salió neutra (−0,02 dB, que
es ruido) porque la SNR no ve lo que hace la dispersión — así que esa decisión
no entró: no se pudo demostrar que mejorase.

## Arranque rápido (desarrollo)

```bash
npm install
npm run dev        # Electron + Vite (la app) — renderer en localhost:5900
npm run server     # servidor de colaboración (puerto 7900)
npm test           # 1621 tests (core, engine, collab, claude-bridge, sound-library, ui, server, desktop)

npm run typecheck  # tsc --noEmit sobre todo el monorepo
```

> Si tras `npm install` Electron no arranca (allow-scripts se salta su
> postinstall): `cd node_modules/electron && node install.js`.

> El dev server usa el puerto **5900**: el 5173 de Vite cae dentro de un rango
> que Windows reserva para Hyper-V en algunas máquinas y moría con `EACCES`.

**Claude como colaborador:** abre la carpeta con Claude Code y la app en
marcha; el `.mcp.json` del repo conecta el bridge (stdio → WS local 7855) y las
22 tools aparecen solas. Todo lo que haga Claude sale en su panel (menú Ver →
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
<summary><b>v2.9.0 — "la casa revisada de arriba a abajo"</b></summary>

Auditoría profunda del árbol entero, zona por zona, con arreglo y test de cada
cosa encontrada: suplantación y borrado de pistas ajenas en la sala, SSRF y
escapes por enlace en el shell de escritorio, cotas del bridge y ReDoS del
parser de la galería, un stop que en realidad era pausa, undo que perdía datos,
batch no atómico, MIDI sin cambios de tempo, audio fantasma, loop que se moría,
pan de nota muerto, limiter que dejaba pasar picos, foldback en contrafase y un
notch que amplificaba.

</details>

<details>
<summary><b>v2.8.0 — "el códec propio"</b></summary>

Orbit exporta `.opus` con un códec escrito entero en casa — range coder, MDCT,
PVQ, cuantización de energía, asignador de bits y contenedor Ogg — con la
RFC 6716 como referencia y verificado contra ffmpeg. La sección **Encoder Opus
propio**, más abajo, lo cuenta entero (incluidos los dos bugs que solo vio un
decodificador ajeno).

</details>

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
