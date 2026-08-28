# SDK de plugins JS — Orbit Studio

Efectos **e instrumentos** escritos por el usuario en JavaScript plano, sin
build ni dependencias: un `.js` en la carpeta de plugins y aparece en el mixer
como un efecto más —o en el Channel Rack como un instrumento más— con sus
perillas.

## Dónde va la carpeta

Los plugins viven en `userData/plugins` (en Windows, algo como
`%APPDATA%\<app>\plugins`). No hace falta buscarla a mano: en el menú de
insertar efecto del mixer (botón «+» de la cadena), la última opción es
**«Abrir carpeta de plugins…»** — la crea si no existe y la abre en el
explorador. Los `.js` se leen al arrancar la app (no recursivo); tras añadir o
editar un plugin, reinicia Orbit Studio para recargarlo.

## Contrato del archivo

Un plugin es un `.js` plano (sin `import`/`export`) que define:

- **Obligatorio** — `function createEffect(sampleRate)`: fábrica que devuelve
  la instancia del efecto:
  - `process(l, r, n)`: procesa los primeros `n` samples de los
    `Float32Array` `l` (izquierda) y `r` (derecha) **in situ**. Se llama por
    bloques desde el hilo de audio: nada de asignar arrays nuevos por bloque.
  - `setParams(p)` *(opcional)*: recibe `{ clave: número }` con los valores
    actuales de las perillas cada vez que cambian.
- **Opcional** — `const name = 'Mi efecto'`: nombre visible en el mixer
  (si falta, se usa el nombre del archivo).
- **Opcional** — `const params = [...]`: perillas del efecto, con el mismo
  shape que los efectos nativos:

  ```js
  const params = [
    { key: 'rate', label: 'Rate', min: 0.1, max: 20, default: 5 },
    // extras opcionales: unit: 'Hz', curve: 'exp' (perilla logarítmica)
  ];
  ```

- **Opcional** — `function createView(sampleRate)` + `const view = {...}`: la
  vista propia del plugin (curva, medidor, lo que quieras). Tiene su sección
  entera más abajo: **[La vista del plugin](#la-vista-del-plugin-v35)**.

El **id** del plugin es el nombre de archivo sin extensión (`tremolo.js` →
`tremolo`) y es lo que se guarda en el proyecto: renombrar el archivo rompe
los proyectos que lo usan (mostrarán «Plugin no encontrado»).

## Seguridad y robustez

> **Un plugin es código que tú ejecutas.** Instala solo `.js` de fuentes en las
> que confíes, igual que cualquier script.

- **Al arrancar**, la app lee `name`/`params` con un **parseo estático**: NO
  ejecuta el código del plugin, así que dejar un `.js` en la carpeta ya no corre
  nada por sí solo. (Por eso `params` tiene que ser un array literal en línea; si
  lo declaras con una variable o una expresión, las perillas no se leen, pero el
  plugin funciona igual.)
- **Durante la reproducción en vivo**, el DSP corre dentro del worklet de audio:
  sin DOM, sin red, sin filesystem — solo números.
- **Al exportar** (y al consolidar/congelar), el render offline —donde se
  ejecutan los plugins— corre en un **worker aislado**: sin `window`, sin DOM,
  sin acceso al puente de la app, y con la CSP del documento cortando la salida a
  red. El renderer solo recoge las entradas (bytes de samples, fuentes) y le pasa
  el cómputo. Así un plugin no puede tocar nada fuera del audio ni siquiera al
  exportar.
- **Al dibujar su vista** (v3.5), el código del plugin corre en un **worker
  aparte** que además se desarma a sí mismo antes de compilarlo (sin `fetch`,
  sin `WebSocket`, sin `indexedDB`, sin `postMessage`, sin `navigator`). Lo que
  devuelve son **números**, no llamadas a un canvas: Orbit los recorta uno a uno
  y pinta él. Un plugin que se cuelgue pintando se queda sin vista a los 500 ms
  y no arrastra a la app — el efecto sigue sonando.
- Si el plugin **lanza una excepción** (al instanciarse, en `setParams` o en
  `process`), el slot pasa a **bypass automático**: el audio sigue limpio y el
  resto de la cadena no se entera. (Un bucle infinito, en cambio, NO se
  recupera: colgaría el hilo de audio.)
- Un archivo que no compila o no define ninguna fábrica (`createEffect` /
  `createInstrument`) se ignora en el arranque (aviso en la consola), y sus
  `params` inválidos se sanean:
  entradas sin `key` o con números no finitos se descartan, y el `default`
  se recorta a `[min, max]`.
- Al **exportar**, las fuentes de los plugins usados viajan al render offline:
  el WAV suena igual que en vivo.

## Galería firmada (v2.7)

Una galería es un JSON publicado donde sea. Eso significa que el archivo viaja
por una red y se sirve desde un sitio que no controla quien lo escribió: un CDN
comprometido, un DNS envenenado o un repo con permisos de más pueden cambiar lo
que baja. Desde v2.7 el índice puede ir **firmado**.

```jsonc
{
  "name": "Galería de Ana",
  "plugins": [
    {
      "id": "tremolo",
      "name": "Tremolo suave",
      "url": "https://ana.example/tremolo.js",
      // SHA-256 del archivo, en base64. Es lo que ata la firma al código.
      "sha256": "Bdi…="
    }
  ],
  "signature": {
    "alg": "ECDSA-P256-SHA256",
    "key": "MFkwEwYHKoZIzj0…",   // clave pública (SPKI, base64)
    "sig": "MEUCIQ…",             // firma (raw r||s, base64)
    "signedAt": 1755800000000
  }
}
```

**Qué se firma.** No los bytes del JSON —reformatearlo lo rompería sin que nadie
haya hecho nada malo— sino una cadena canónica construida con los campos ya
validados y los plugins **ordenados por id**:

```
orbit-gallery-v1
name:<nombre>
description:<descripción>
plugin:<id>|<url>|<sha256>
plugin:…
```

Lo que no está en esa cadena **no está firmado**. Y como el `sha256` sí lo está,
la cadena llega hasta el código: al instalar, la app baja el archivo, lo hashea
y lo compara. Si no cuadra, no se guarda — da igual que la URL sea la correcta.

**El modelo de confianza es el de SSH.** No hay autoridad que valide a nadie:
cualquiera puede generar una clave y firmar lo suyo. Lo que aporta la firma no
es «esto es bueno», sino «esto lo publicó **el mismo de siempre**». La app
acepta la primera clave que ve, la fija, y a partir de ahí exige que no cambie.
Un cambio de clave **no es un aviso, es un alto**: la lista de plugins
desaparece hasta que una persona compare las dos huellas y decida. Una galería
que estaba firmada y llega sin firma cuenta igual, porque quitar la firma es
justo el ataque que esto corta.

> **La firma no vuelve seguro el código.** Un plugin firmado puede ser igual de
> malo que uno sin firmar: lo que garantiza es la autoría y que nadie lo tocó
> por el camino. Todo lo de «Seguridad y robustez» de arriba sigue siendo lo que
> te protege de lo que el plugin haga.

**Publicar una galería firmada:**

```bash
npx tsx tools/gallery-sign.ts keygen > mi-clave.json   # guarda esto a buen recaudo
npx tsx tools/gallery-sign.ts sign galeria.json mi-clave.json
```

`sign` baja cada plugin, calcula su hash, lo escribe en el índice y firma el
resultado — a propósito descarga: lo que se firma tiene que ser lo que hay
**ahora** en esas URLs. Publica también la **huella** de tu clave (`keygen` la
imprime) donde la gente pueda comprobarla; es lo que van a mirar la primera vez.

Para comprobar un índice sin abrir la app, con el mismo código que usa ella:

```bash
npx tsx tools/qa/gallery-verify.ts galeria.json
```

## Ejemplo completo: tremolo

Guarda esto como `tremolo.js` en la carpeta de plugins y reinicia la app:

```js
// tremolo.js — LFO sobre la ganancia (SDK de plugins de Orbit Studio)

const name = 'Tremolo';

const params = [
  { key: 'rate', label: 'Rate', min: 0.1, max: 20, default: 5, unit: 'Hz', curve: 'exp' },
  { key: 'depth', label: 'Depth', min: 0, max: 1, default: 0.6 },
];

function createEffect(sampleRate) {
  let rate = 5;
  let depth = 0.6;
  let phase = 0; // el LFO conserva la fase entre bloques

  return {
    setParams(p) {
      if (typeof p.rate === 'number') rate = p.rate;
      if (typeof p.depth === 'number') depth = p.depth;
    },
    process(l, r, n) {
      const inc = (2 * Math.PI * rate) / sampleRate;
      for (let i = 0; i < n; i++) {
        // Ganancia 1 → (1 - depth), senoidal
        const g = 1 - depth * (0.5 + 0.5 * Math.sin(phase));
        l[i] *= g;
        r[i] *= g;
        phase += inc;
        if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      }
    },
  };
}
```

En el mixer: «+» en un slot libre → sección **Plugins JS** → **Tremolo**.
Las perillas Rate y Depth salen del propio archivo, y el knob Mix del slot
hace el dry/wet como en cualquier efecto nativo.


## La vista del plugin (v3.5)

Hasta aquí, un plugin solo podía enseñar **perillas**. Un compresor no podía
enseñar su curva, un EQ no podía enseñar su respuesta, un delay no podía
enseñar sus repeticiones. Desde v3.5 un plugin puede pintar su propia vista
encima de sus perillas.

### La regla que lo gobierna todo: no tocas el DOM

Tu código no es nuestro, y toda la app está construida alrededor de eso. Así
que la superficie de dibujo **es de datos, no de DOM**:

- No recibes un canvas. No recibes un contexto 2D. No recibes un nodo. Si lo
  recibieras, con `ctx.canvas.ownerDocument` tendrías `document`, y con él
  `window.orbit` y la app entera: un solo campo echaría abajo la CSP, el
  guardián de rutas del proceso principal y el aislamiento del worklet.
- Recibes un **grabador** (`d`) cuyos métodos escriben números en un buffer.
  Eso es literalmente todo lo que hay al otro lado.
- Tu `draw` **no corre en la ventana de Orbit**: corre en un *worker* propio,
  donde `document` y `window` no existen y no llega el puente de la app. Antes
  de compilar tu archivo, ese worker se desarma a sí mismo: `fetch`,
  `XMLHttpRequest`, `WebSocket`, `importScripts`, `indexedDB`, `Worker`,
  `navigator`, `postMessage`… se quedan en `undefined`. Tu código corre además
  en modo estricto.
- Lo que devuelve tu vista es ese array de números. Orbit lo relee, **recorta
  cada valor** y lo pinta él, sobre un canvas que es suyo. Una lista corrupta,
  maliciosa o llena de `NaN` da un dibujo feo; nunca una llamada inesperada.

> Ninguna de esas capas convierte JavaScript en un lenguaje seguro: dentro de un
> mismo realm siempre hay caminos (`Function`, prototipos). Lo que hacen es
> quitarle al worker **las capacidades**: sin red, sin disco, sin DOM y sin
> canal con la app, no hay nada que alcanzar aunque se alcance el global.

### El contrato

```js
// Opcional. Sin esto, la vista existe igual con los valores por defecto.
const view = {
  height: 120,             // alto en px (40..320)
  fps: 30,                 // ritmo (5..60)
  needs: ['level'],        // 'level' y/o 'spectrum'; pedir menos es calcular menos
  labels: ['in', 'out'],   // catálogo de textos, por índice (máx 16, 32 chars)
};

function createView(sampleRate) {
  return {
    draw(d, f) { /* … */ },
  };
}
```

`draw(d, f)` se llama a `view.fps` mientras la vista está abierta.

> **Dónde aparece hoy.** En el editor de un slot de **efecto**: la cadena del
> mixer y la pestaña «Efectos» del canal. Un plugin de **instrumento** puede
> declarar su vista igual —el parser la lee y la sanea— pero el Channel Rack
> todavía no la pinta.

**Las coordenadas van en el cuadrado unidad**: `x` e `y` de 0 a 1, con (0,0)
arriba a la izquierda. No sabes el tamaño en píxeles y no te hace falta: el
mismo plugin se ve bien en el mixer, en la pestaña de canal y en una ventana
suelta. Lo que se salga de [0,1] se pega al borde.

**`d` — lo que puedes dibujar**

| Método | Qué hace |
| --- | --- |
| `d.clear()` | Limpia el área con el color activo. |
| `d.color(n)` | Color activo por **índice de paleta** (0..7). No hay colores libres. |
| `d.alpha(a)` | Opacidad 0..1. |
| `d.width(px)` | Grosor de línea, 0.5..8. |
| `d.begin()` `d.moveTo(x,y)` `d.lineTo(x,y)` `d.close()` | Trazo. |
| `d.stroke()` `d.fill()` | Pintar el trazo. |
| `d.fillRect(x,y,w,h)` `d.strokeRect(x,y,w,h)` | Rectángulos. |
| `d.circle(cx,cy,r)` | Círculo al trazo (el radio se escala por el lado menor). |
| `d.line(x1,y1,x2,y2)` | Atajo: `begin`+`moveTo`+`lineTo`+`stroke`. |
| `d.curve(fn, pasos)` | Atajo: polilínea de `y = fn(x)` con `x` de 0 a 1. |
| `d.label(i, x, y, align)` | Texto **del catálogo** `view.labels`; `align` 0/1/2. |

Los colores son índices porque tu vista tiene que seguir el tema de Orbit
(claro, oscuro, acrílico, el acento que haya elegido el usuario) sin saber que
existe — y porque una cadena CSS es una superficie de ataque más:

| # | Papel | # | Papel |
| --- | --- | --- | --- |
| 0 | fondo | 4 | el dato principal (acento) |
| 1 | marco y rejilla | 5 | verde de medidor |
| 2 | líneas y textos secundarios | 6 | ámbar de medidor |
| 3 | texto principal | 7 | rojo de aviso |

**`f` — lo que ves de la sesión**

| Campo | Qué es |
| --- | --- |
| `f.t` | segundos desde que se abrió la vista |
| `f.dt` | segundos desde el frame anterior |
| `f.sampleRate` | frecuencia de muestreo |
| `f.aspect` | alto/ancho del área (para no deformar círculos) |
| `f.p.<clave>` | valor **actual** de cada perilla, incluida la que mueve un LFO |
| `f.peak`, `f.rms` | nivel 0..1 de la pista, si pediste `needs: ['level']` |
| `f.hasLevel` | si ese nivel trae datos este frame |
| `f.spectrum`, `f.bins` | magnitudes en dB (piso −90) si pediste `'spectrum'` |
| `f.hasSpectrum` | ídem |

`f` y sus arrays son **siempre los mismos objetos**: se rellenan en sitio cada
frame. Guardarte una referencia a `f.spectrum` funciona; guardarte una copia por
frame es generar basura para nada.

### De dónde salen esos datos (y por qué no del hilo de audio)

`f.peak`, `f.rms` y `f.spectrum` **no vienen de tu `process()`**. Vienen del tap
que el kernel ya publica para el Orbit Scope, el EQ del mixer y el analizador de
pista, y que se lee en el hilo de la interfaz. Del hilo de audio al dibujo no
cruza nada nuevo, y tu `process()` sigue siendo lo que era: números, en sitio,
sin reservar memoria.

Dos consecuencias que conviene saber:

- **El nivel es mono** ((L+R)/2) y es el de la **pista**, no el de tu slot. Es
  útil para un medidor de entrada; no lo pintes como si fueran dos canales.
- Ese tap es **uno solo y compartido**. Si el Orbit Scope o el EQ de otra pista
  se lo llevan, tu vista recibe `hasLevel: false` en vez del audio de otro. Pinta
  algo razonable en ese caso.

Lo que sí es tuyo del todo es `f.p`: la curva de un compresor, la respuesta de
un EQ o el patrón de un delay salen de los parámetros, y esos llegan exactos y
en el mismo frame en que el usuario mueve la perilla.

### Si tu vista se cuelga

Es la razón de que el dibujo corra en un worker: un `while (true)` en el hilo de
la interfaz no lo caza ningún presupuesto, porque el código que lo cazaría no
llega a ejecutarse. En un worker, sí.

- Cada frame se manda con la hora. Si no vuelve en **500 ms**, Orbit da la vista
  por colgada, **mata el worker** y pinta *«La vista del plugin se colgó y se
  apagó»*. **El efecto sigue sonando**: lo que se apaga es el dibujo.
- Si tu `draw` **lanza**, se pierde ese frame. Tres seguidas y la vista se apaga
  con el mensaje del error.
- Si no se cuelga pero **cuesta**, hay presupuesto: por encima de ~4 ms de media
  se le baja el ritmo a 12 fps, y a los 12 frames de más de 30 ms se apaga.

Nada de esto toca el audio. Puedes colgar tu vista todo lo que quieras: no vas a
colgar Orbit.

### Ejemplo completo: un compresor que enseña su curva

Guarda esto como `compresor-visible.js` en la carpeta de plugins y reinicia la
app. Comprime de verdad, y dibuja su curva de transferencia, el umbral, el
punto donde cae la señal que está entrando ahora mismo y la reducción que le
está aplicando.

```js
// compresor-visible.js — compresor con curva de transferencia a la vista
// (SDK de plugins de Orbit Studio)

const name = 'Compresor visible';

const params = [
  { key: 'threshold', label: 'Umbral', min: -48, max: 0, default: -18, unit: 'dB' },
  { key: 'ratio', label: 'Ratio', min: 1, max: 20, default: 4, curve: 'exp' },
  { key: 'attack', label: 'Ataque', min: 0.5, max: 100, default: 8, unit: 'ms', curve: 'exp' },
  { key: 'release', label: 'Release', min: 10, max: 800, default: 120, unit: 'ms', curve: 'exp' },
  { key: 'makeup', label: 'Makeup', min: 0, max: 18, default: 0, unit: 'dB' },
];

const view = {
  height: 130,
  fps: 30,
  needs: ['level'],
  labels: ['-48', '0 dB', 'GR'],
};

// El suelo del dibujo: por debajo de -48 dB no hay nada que enseñar.
const FLOOR_DB = -48;

/** dB de salida para unos dB de entrada, con la curva estática del compresor. */
function transfer(inDb, threshold, ratio, makeup) {
  const over = inDb - threshold;
  const out = over <= 0 ? inDb : threshold + over / ratio;
  return out + makeup;
}

function createEffect(sampleRate) {
  let threshold = -18;
  let ratio = 4;
  let attack = 8;
  let release = 120;
  let makeup = 0;
  let env = 0; // seguidor de envolvente, en lineal

  return {
    setParams(p) {
      if (typeof p.threshold === 'number') threshold = p.threshold;
      if (typeof p.ratio === 'number') ratio = Math.max(1, p.ratio);
      if (typeof p.attack === 'number') attack = Math.max(0.5, p.attack);
      if (typeof p.release === 'number') release = Math.max(1, p.release);
      if (typeof p.makeup === 'number') makeup = p.makeup;
    },
    process(l, r, n) {
      const aCoef = Math.exp(-1 / ((attack / 1000) * sampleRate));
      const rCoef = Math.exp(-1 / ((release / 1000) * sampleRate));
      const mk = Math.pow(10, makeup / 20);
      for (let i = 0; i < n; i++) {
        const li = l[i];
        const ri = r[i];
        // Detector de pico sobre el máximo de los dos canales: así el
        // compresor no descoloca la imagen estéreo al comprimir solo uno.
        const rect = Math.max(li < 0 ? -li : li, ri < 0 ? -ri : ri);
        const coef = rect > env ? aCoef : rCoef;
        env = coef * env + (1 - coef) * rect;

        const envDb = 20 * Math.log10(env + 1e-9);
        const over = envDb - threshold;
        // La reducción es la parte del exceso que NO se deja pasar.
        const grDb = over > 0 ? over - over / ratio : 0;
        const g = Math.pow(10, -grDb / 20) * mk;
        l[i] = li * g;
        r[i] = ri * g;
      }
    },
  };
}

function createView() {
  // Estado propio de la vista: la caída del pico es de dibujo, no de audio.
  let held = 0;

  return {
    draw(d, f) {
      const threshold = f.p.threshold;
      const ratio = Math.max(1, f.p.ratio);
      const makeup = f.p.makeup;

      // dB → coordenada 0..1 (x hacia la derecha, y hacia arriba invertida).
      const toX = (db) => (db - FLOOR_DB) / -FLOOR_DB;
      const toY = (db) => 1 - (db - FLOOR_DB) / -FLOOR_DB;

      d.clear();

      // Marco y diagonal 1:1 (lo que haría no comprimir nada).
      d.color(1).width(1).strokeRect(0, 0, 1, 1);
      d.color(2).alpha(0.45).line(0, 1, 1, 0).alpha(1);

      // Umbral.
      d.color(2).alpha(0.7).line(toX(threshold), 0, toX(threshold), 1).alpha(1);

      // La curva de transferencia. `d.curve` recorre x de 0 a 1 por ti.
      d.color(4)
        .width(1.8)
        .curve((x) => toY(transfer(FLOOR_DB + x * -FLOOR_DB, threshold, ratio, makeup)), 96);
      d.width(1);

      // Dónde cae AHORA la señal de la pista, y cuánto se le está quitando.
      if (f.hasLevel) {
        const inDb = 20 * Math.log10(f.peak + 1e-9);
        held = Math.max(inDb, held - 24 * f.dt); // caída de 24 dB/s
        const shown = Math.max(FLOOR_DB, held);
        const outDb = transfer(shown, threshold, ratio, makeup);
        const gr = shown - (outDb - makeup);

        d.color(gr > 6 ? 7 : gr > 1 ? 6 : 5);
        d.begin().circle(toX(shown), toY(outDb), 0.035).fill();

        // Barra de reducción abajo a la derecha (0..12 dB).
        const w = Math.min(1, gr / 12) * 0.28;
        d.alpha(0.85).fillRect(0.7, 0.9, w, 0.06).alpha(1);
        d.color(2).label(2, 0.68, 0.96, 2);
      }

      // Etiquetas de los extremos del eje.
      d.color(2);
      d.label(0, 0.02, 0.97, 0);
      d.label(1, 0.98, 0.97, 2);
    },
  };
}
```

En el mixer: «+» en un slot libre → sección **Plugins JS** → **Compresor
visible**. La curva se mueve mientras giras Umbral y Ratio, y el punto sube y
baja con lo que esté sonando por la pista.

Un detalle del ejemplo que conviene copiar: la **caída del pico** (`held`) se
lleva en la vista, con `f.dt`, y no en el DSP. Lo que es solo para mirar se
calcula donde se mira.

## Instrumentos (v1.0)

El mismo archivo puede traer un instrumento además del efecto — o solo el
instrumento. La fábrica es `createInstrument(sampleRate)` y devuelve un objeto
con el ciclo de vida de una voz: **se crea una instancia por nota**, igual que
las voces internas del motor.

```js
const name = 'Mono Saw';
const params = [
  { key: 'cutoff', label: 'Cutoff', min: 200, max: 12000, default: 4000, curve: 'exp', unit: 'Hz' },
  { key: 'decay', label: 'Decay', min: 0.05, max: 4, default: 0.6, unit: 's' },
];

function createInstrument(sampleRate) {
  let freq = 440;
  let phase = 0;
  let env = 0;
  let releasing = false;
  let cutoff = 4000;
  let decay = 0.6;
  let lp = 0;

  return {
    setParams(p) {
      if (typeof p.cutoff === 'number') cutoff = p.cutoff;
      if (typeof p.decay === 'number') decay = p.decay;
    },
    noteOn(key, velocity) {
      freq = 440 * Math.pow(2, (key - 69) / 12);
      env = velocity;
      releasing = false;
    },
    noteOff() {
      releasing = true;
    },
    // SUMA al buffer y devuelve false cuando la voz ha terminado.
    render(outL, outR, from, to, gainL, gainR) {
      const a = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
      for (let i = from; i < to; i++) {
        phase += freq / sampleRate;
        if (phase >= 1) phase -= 1;
        const saw = 2 * phase - 1;
        lp += a * (saw - lp);
        const s = lp * env;
        outL[i] += s * gainL;
        outR[i] += s * gainR;
        env *= Math.exp(-1 / ((releasing ? decay * 0.3 : decay) * sampleRate));
      }
      return env > 0.0005;
    },
  };
}
```

**Cómo se usa**: reinicia la app y en el Channel Rack, «+ Añadir canal» trae
una sección **Plugins JS** con los archivos que declaran `createInstrument`.
El canal guarda el id del plugin y los valores de sus perillas, que llegan por
`setParams` (también cuando los mueve la automatización o un LFO).

**Reglas del contrato**:

- `render` **suma** al buffer (nunca lo pisa) y devuelve `false` cuando la voz
  terminó: el kernel la recicla en ese momento.
- Los fallos se aíslan en tres niveles: si el plugin no está registrado o su
  fábrica revienta, el canal cae a su motor interno; si revienta en
  `noteOn`/`noteOff`/`setParams`/`render`, esa voz queda muda y se recicla, sin
  tocar el resto de la mezcla.
- Una nota *slide* re-ataca con `noteOn` (el contrato todavía no tiene glide).
