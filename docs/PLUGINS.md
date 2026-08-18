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

El **id** del plugin es el nombre de archivo sin extensión (`tremolo.js` →
`tremolo`) y es lo que se guarda en el proyecto: renombrar el archivo rompe
los proyectos que lo usan (mostrarán «Plugin no encontrado»).

## Seguridad y robustez

> **Un plugin es código que tú ejecutas.** Instala solo `.js` de fuentes en las
> que confíes, igual que cualquier script. Ahora mismo el aislamiento NO es
> total (ver abajo): un plugin malicioso podría, al arrancar la app o al
> exportar, hacer cosas fuera del audio.

- **Durante la reproducción en vivo**, el DSP corre dentro del worklet de audio:
  sin DOM, sin red, sin filesystem — solo números.
- **Al arrancar** (para leer `name`/`params`) y **al exportar**, hoy el código
  del plugin se evalúa en el hilo del renderer, que sí tiene acceso a APIs del
  navegador. Es una limitación conocida en vías de cerrarse (leer la metadata
  con parseo estático y mover el export a un worker aislado); hasta entonces, la
  frase de arriba es la que manda.
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
