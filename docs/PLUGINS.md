# SDK de plugins JS — Orbit Studio

Efectos de audio escritos por el usuario en JavaScript plano, sin build ni
dependencias: un `.js` en la carpeta de plugins y aparece en el mixer como un
efecto más, con sus perillas.

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

- El DSP corre **dentro del sandbox del worklet de audio**: sin DOM, sin red,
  sin filesystem — solo números.
- Si el plugin **lanza una excepción** (al instanciarse, en `setParams` o en
  `process`), el slot pasa a **bypass automático**: el audio sigue limpio y el
  resto de la cadena no se entera.
- Un archivo que no compila o no define `createEffect` se ignora en el
  arranque (aviso en la consola), y sus `params` inválidos se sanean:
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
