/**
 * Protocolo de la vista de un plugin JS: la FRONTERA entre código que no es
 * nuestro y la pantalla de Orbit.
 *
 * ## Por qué la frontera es de datos y no de DOM
 *
 * El SDK ya deja al usuario meter un `.js` cualquiera en `userData/plugins`, y
 * toda la app está construida alrededor de desconfiar de él: la metadata se lee
 * con un parseo estático (no se ejecuta nada al arrancar), el DSP corre en el
 * worklet (sin DOM, sin red, sin disco), el render offline corre en un worker
 * aislado, el renderer no puede salir a la red (CSP) y el main desconfía de las
 * rutas que le pasa el renderer. Darle al plugin una superficie de dibujo es
 * darle un sitio nuevo donde correr — y si esa superficie fuera un
 * `CanvasRenderingContext2D` de verdad, o peor, un nodo del árbol, el plugin
 * tendría en la mano `canvas.ownerDocument`, y con él `document`, `window`,
 * `window.orbit` y toda la app. Un solo `.canvas` de un contexto 2D echa abajo
 * todo lo anterior.
 *
 * Por eso lo que cruza esta frontera son NÚMEROS, y nada más:
 *
 * - El plugin nunca ve un canvas, ni un contexto, ni un nodo. Recibe un
 *   `DrawRecorder` (`view-recorder.ts`) cuyos métodos solo escriben floats en un
 *   `Float32Array` preasignado. Ese objeto no tiene una sola referencia a un
 *   objeto del host.
 * - El código del plugin ni siquiera corre en el hilo del renderer: corre en un
 *   Worker dedicado (`plugin-view-worker.ts`), donde `document` y `window` NO
 *   EXISTEN, y donde no llega el puente `window.orbit`.
 * - Lo que vuelve del worker es ese array de floats. El host lo relee, valida y
 *   recorta CADA valor (`view-replay.ts`) y lo repinta él mismo sobre su propio
 *   canvas. Un buffer corrupto, malicioso o simplemente lleno de `NaN` produce
 *   un dibujo feo, nunca una llamada inesperada.
 * - Los colores no son cadenas CSS sino ÍNDICES a una paleta que resuelve el
 *   host desde las variables de tema. El plugin no puede pintar un color
 *   inventado (regla 4 del repo: ningún color hardcodeado) ni colar un
 *   `url(...)` dentro de un `fillStyle`.
 * - El texto tampoco cruza en tiempo de ejecución: el plugin declara un
 *   CATÁLOGO de etiquetas de forma estática en su archivo, se sanea al
 *   parsearlo, y en el frame solo viaja el índice. Nunca hay una cadena que
 *   venga de código en ejecución.
 *
 * ## Las coordenadas
 *
 * Todo el dibujo va en el cuadrado unidad `[0,1] × [0,1]`, con (0,0) arriba a
 * la izquierda. El plugin no sabe (ni necesita saber) el tamaño en píxeles ni
 * el `devicePixelRatio`: eso lo aplica el host al repintar. Además hace trivial
 * el recorte — todo lo que no esté en [0,1] se pega al borde — y hace que el
 * mismo plugin se vea bien en el mixer, en la pestaña de canal y en una ventana
 * suelta sin enterarse.
 */

// ── Buffer de entrada (host → worker) ────────────────────────────────────────
// Un solo Float32Array preasignado con la cabecera y los datos del frame. Va y
// vuelve por transferencia (ping-pong), así que nunca se reserva memoria nueva
// para los datos: ver `view-session.ts`.

/** Tope de perillas cuyo valor viaja en el frame (espejo de MAX_PARAMS del parser). */
export const VIEW_MAX_PARAMS = 32;
/** Bins de espectro que caben en el frame (mitad de una FFT de 1024). */
export const VIEW_SPECTRUM_BINS = 512;

export const IN_T = 0; // segundos desde que se abrió la vista
export const IN_DT = 1; // segundos desde el frame anterior
export const IN_SAMPLE_RATE = 2;
export const IN_ASPECT = 3; // alto/ancho del área de dibujo
export const IN_FLAGS = 4; // bit 0: level válido · bit 1: espectro válido
export const IN_NPARAMS = 5;
export const IN_NBINS = 6;
export const IN_PARAMS = 8;
export const IN_LEVEL = IN_PARAMS + VIEW_MAX_PARAMS; // [pico, rms]
export const IN_SPECTRUM = IN_LEVEL + 2;
export const IN_LEN = IN_SPECTRUM + VIEW_SPECTRUM_BINS;

export const FLAG_LEVEL = 1;
export const FLAG_SPECTRUM = 2;

// ── Buffer de salida (worker → host): la lista de dibujo ─────────────────────

/**
 * Tope de floats de una lista de dibujo. Un plugin que se pase no rompe nada:
 * el recorder deja de anotar (`overflow`), y lo que ya escribió se pinta igual.
 * 4096 floats dan de sobra para una curva de 512 puntos (1536 floats) más
 * rejilla, medidores y etiquetas.
 */
export const VIEW_LIST_CAP = 4096;

/** Órdenes de dibujo. El valor es lo que viaja en el buffer: no reordenar. */
export const OP = {
  /** Limpia el área con el color actual (por defecto, el fondo del panel). */
  CLEAR: 1,
  /** Color activo, por ÍNDICE de paleta (0..PALETTE_SLOTS-1). */
  COLOR: 2,
  /** Opacidad 0..1. */
  ALPHA: 3,
  /** Grosor de línea en píxeles lógicos. */
  WIDTH: 4,
  /** Empieza un trazo nuevo. */
  BEGIN: 5,
  MOVE: 6,
  LINE: 7,
  CLOSE: 8,
  STROKE: 9,
  FILL: 10,
  FILL_RECT: 11,
  STROKE_RECT: 12,
  /** Círculo (cx, cy, r) añadido al trazo actual; r se escala por el lado menor. */
  CIRCLE: 13,
  /** Etiqueta del catálogo estático: (índice, x, y, alineación 0=izq 1=centro 2=der). */
  LABEL: 14,
} as const;

export type Opcode = (typeof OP)[keyof typeof OP];

/** Cuántos floats de argumento lleva cada opcode. Índice = opcode. */
export const OP_ARITY: readonly number[] = (() => {
  const a = new Array<number>(16).fill(-1);
  a[OP.CLEAR] = 0;
  a[OP.COLOR] = 1;
  a[OP.ALPHA] = 1;
  a[OP.WIDTH] = 1;
  a[OP.BEGIN] = 0;
  a[OP.MOVE] = 2;
  a[OP.LINE] = 2;
  a[OP.CLOSE] = 0;
  a[OP.STROKE] = 0;
  a[OP.FILL] = 0;
  a[OP.FILL_RECT] = 4;
  a[OP.STROKE_RECT] = 4;
  a[OP.CIRCLE] = 3;
  a[OP.LABEL] = 4;
  return a;
})();

// ── Paleta ───────────────────────────────────────────────────────────────────

/**
 * Los colores que puede pedir un plugin, por índice. Cada uno es una variable
 * de tema que resuelve el HOST al repintar: el plugin no elige colores, elige
 * papeles. Así su vista sigue el tema (claro, oscuro, acrílico, acento del
 * usuario) sin saber que existe, y no hay forma de colar una cadena CSS.
 */
export const PALETTE_VARS: readonly string[] = [
  '--surface', // 0 fondo
  '--border', // 1 marco y rejilla
  '--text-dim', // 2 líneas y textos secundarios
  '--text', // 3 texto principal
  '--accent', // 4 la curva/el dato principal
  '--meter', // 5 verde de medidor
  '--meter-hot', // 6 ámbar de medidor
  '--meter-clip', // 7 rojo de aviso
];

export const PALETTE_SLOTS = PALETTE_VARS.length;

// ── Topes de la vista ────────────────────────────────────────────────────────

export const VIEW_MIN_HEIGHT = 40;
export const VIEW_MAX_HEIGHT = 320;
export const VIEW_DEFAULT_HEIGHT = 96;

export const VIEW_MIN_FPS = 5;
export const VIEW_MAX_FPS = 60;
export const VIEW_DEFAULT_FPS = 30;

/** Etiquetas estáticas por plugin, y cuánto puede medir cada una. */
export const VIEW_MAX_LABELS = 16;
export const VIEW_MAX_LABEL_CHARS = 32;

/** Grosor de línea admitido (px lógicos). */
export const MIN_LINE_WIDTH = 0.5;
export const MAX_LINE_WIDTH = 8;

/** Opacidad mínima: 0 exacto invita a dibujar invisible y confundir. */
export const MIN_ALPHA = 0;
export const MAX_ALPHA = 1;

/**
 * Recorta a [0,1]. NaN cae a 0; los infinitos se pegan a su borde.
 *
 * El NaN se comprueba ANTES de comparar, y por eso esto no es un
 * `Math.min(1, Math.max(0, v))`: con NaN, `min`/`max` devuelven NaN, y un solo
 * NaN metido en un `lineTo` envenena el trazo ENTERO del canvas — deja de
 * pintarse todo, no solo ese punto. Un plugin con una división entre cero
 * borraría su vista sin que nadie supiera por qué.
 */
export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Recorta a [lo, hi] con la misma defensa contra NaN (cae a `lo`). */
export function clampTo(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Índice entero válido dentro de [0, n-1]; cualquier basura cae dentro. */
export function clampIndex(v: number, n: number): number {
  if (n <= 0 || Number.isNaN(v)) return 0;
  const i = Math.floor(v);
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}
