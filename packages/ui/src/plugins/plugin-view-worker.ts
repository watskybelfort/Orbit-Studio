/**
 * Worker de la vista de un plugin: el ÚNICO sitio donde se ejecuta el código de
 * dibujo de un plugin del usuario.
 *
 * Aquí no hay `document`, no hay `window`, no hay `window.orbit`: un worker no
 * tiene DOM. Ese es el primer motivo de que el dibujo viva aquí y no en el hilo
 * del renderer — si el plugin recibiera un contexto 2D de verdad, con
 * `ctx.canvas.ownerDocument` tendría la app entera en la mano.
 *
 * El segundo motivo es que un worker se puede MATAR. No existe forma de
 * interrumpir un `while(true)` desde fuera del hilo que lo corre: si el dibujo
 * corriera en el renderer, ningún presupuesto de tiempo lo cazaría, porque el
 * código que lo cazaría no llegaría a ejecutarse nunca. Colgado aquí, el hilo
 * de la UI sigue libre, su watchdog corre, y `terminate()` se lo lleva por
 * delante (`view-session.ts`).
 *
 * Y el tercero es que un worker es un realm aparte, así que su objeto global se
 * puede desarmar sin tocar el de la app: eso es `harden()`, más abajo.
 *
 * Lo que sale de aquí son floats. Nada más.
 */

import { DrawRecorder } from './view-recorder';
import {
  FLAG_LEVEL,
  FLAG_SPECTRUM,
  IN_ASPECT,
  IN_DT,
  IN_FLAGS,
  IN_LEVEL,
  IN_NBINS,
  IN_NPARAMS,
  IN_PARAMS,
  IN_SAMPLE_RATE,
  IN_SPECTRUM,
  IN_T,
  VIEW_MAX_PARAMS,
  VIEW_SPECTRUM_BINS,
} from './view-protocol';

// El tsconfig usa la lib DOM, así que `self` sale tipado como Window. Se
// castea al scope real del worker con lo justo que se usa (mismo apaño que
// `export/render-worker.ts`).
interface WorkerScope {
  onmessage: ((e: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/**
 * Se captura el `postMessage` ANTES de desarmar el global: es el único canal
 * que queda hacia el host, y el plugin no debe poder usarlo (ni pisarlo).
 */
const post = scope.postMessage.bind(scope);

/**
 * Desarma el objeto global del worker antes de compilar nada del usuario.
 *
 * Esto NO es un sandbox de JavaScript —no existe tal cosa dentro de un mismo
 * realm: `(function(){}).constructor` sigue devolviendo `Function`— pero sí es
 * efectivo para lo que importa, porque `Function('return globalThis')()`
 * devuelve ESTE global, que es justo el que se está desarmando. Quitar `fetch`,
 * `WebSocket`, `indexedDB` y compañía de aquí los quita de todos los caminos
 * que lleven a ellos desde este hilo.
 *
 * Es una capa más sobre las que ya hay (CSP del documento, worker sin DOM ni
 * puente), no la única. Cada `defineProperty` va envuelto porque un motor puede
 * negarse a redefinir alguna propiedad, y una vista que no arranca por eso
 * sería peor que una vista con una capa menos.
 */
const BLOCKED_GLOBALS = [
  // Salida a red (la CSP ya corta http(s), pero connect-src permite ws: por el
  // servidor de colaboración: aquí se cierra también esa puerta).
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'navigator', // sendBeacon, y de paso la huella del equipo
  'importScripts', // traerse código de fuera en caliente
  // Persistencia
  'indexedDB',
  'caches',
  'localStorage',
  'sessionStorage',
  'FileReader',
  'FileReaderSync',
  // Más hilos (otro realm sin desarmar sería la vía de escape obvia)
  'Worker',
  'SharedWorker',
  'BroadcastChannel',
  'MessageChannel',
  // Canal con el host y con el propio worker
  'postMessage',
  'close',
  'location',
];

function harden(): void {
  for (const key of BLOCKED_GLOBALS) {
    try {
      Object.defineProperty(self, key, {
        value: undefined,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    } catch {
      // Este motor no deja redefinirla: se sigue con las demás capas.
    }
  }
}

// ── Estado de la vista ───────────────────────────────────────────────────────

interface PluginView {
  draw?: (d: DrawRecorder, f: FrameData) => void;
}

/**
 * El objeto que recibe el `draw` del plugin. Se construye UNA vez y se rellena
 * en sitio cada frame: ni el objeto ni sus arrays se vuelven a reservar, así
 * que dibujar a 30 fps no genera basura para el GC.
 */
interface FrameData {
  /** Segundos desde que se abrió la vista. */
  t: number;
  /** Segundos desde el frame anterior. */
  dt: number;
  sampleRate: number;
  /** alto/ancho del área: el dibujo va en el cuadrado unidad, esto lo corrige. */
  aspect: number;
  /** Valores actuales de las perillas, por su clave. */
  p: Record<string, number>;
  /** Pico 0..1 del tap de la pista (mono), o 0 si la vista no lo pidió. */
  peak: number;
  /** RMS 0..1 del tap de la pista (mono). */
  rms: number;
  /** true si `peak`/`rms` traen datos de verdad este frame. */
  hasLevel: boolean;
  /** Espectro en dB (piso -90) por bin, si la vista lo pidió. */
  spectrum: Float32Array;
  /** Bins válidos de `spectrum` este frame (0 si no hay). */
  bins: number;
  hasSpectrum: boolean;
}

let view: PluginView | null = null;
let recorder: DrawRecorder | null = null;
let paramKeys: string[] = [];

const frame: FrameData = {
  t: 0,
  dt: 0,
  sampleRate: 48000,
  aspect: 1,
  p: {},
  peak: 0,
  rms: 0,
  hasLevel: false,
  spectrum: new Float32Array(VIEW_SPECTRUM_BINS),
  bins: 0,
  hasSpectrum: false,
};

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Compila la fuente del plugin y saca su `createView`.
 *
 * Los globales peligrosos se pasan además como PARÁMETROS con su nombre, lo que
 * los deja en `undefined` dentro del cuerpo del plugin aunque el motor no haya
 * dejado redefinir alguno en `harden()`. Y el cuerpo va en modo estricto: sin
 * globales implícitos y con `this` a `undefined` en el nivel superior.
 */
const SHADOWED = [
  'self',
  'globalThis',
  'window',
  'document',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'postMessage',
  'addEventListener',
  'removeEventListener',
  'indexedDB',
  'caches',
  'Worker',
  'navigator',
  'location',
  'close',
  'onmessage',
];

function compileView(source: string, sampleRate: number): PluginView {
  const factory = new Function(
    ...SHADOWED,
    `'use strict';\n${source}\n;return typeof createView === 'function' ? createView : null;`,
  ) as (...args: unknown[]) => unknown;
  const create = factory(...SHADOWED.map(() => undefined));
  if (typeof create !== 'function') {
    throw new Error('El plugin no declara createView()');
  }
  const made = (create as (sr: number) => unknown)(sampleRate);
  if (typeof made !== 'object' || made === null) {
    throw new Error('createView() no devolvió un objeto');
  }
  const v = made as PluginView;
  if (typeof v.draw !== 'function') {
    throw new Error('La vista no trae draw(d, f)');
  }
  return v;
}

// ── Bucle de mensajes ────────────────────────────────────────────────────────

interface InitMsg {
  type: 'init';
  source: string;
  paramKeys: string[];
  labelCount: number;
  sampleRate: number;
}

interface FrameMsg {
  type: 'frame';
  in: Float32Array;
  out: Float32Array;
}

/** Lo que puede llegar: se lee con desconfianza y campo a campo. */
type Incoming = Partial<Omit<InitMsg, 'type'>> &
  Partial<Omit<FrameMsg, 'type'>> & { type?: string };

scope.onmessage = (e: MessageEvent<unknown>) => {
  const msg = e.data as Incoming | null;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'init') {
    // Desarmar el global ANTES de compilar: el top-level del plugin corre en
    // `compileView`, así que a partir de esta línea ya no puede alcanzarlos.
    harden();
    paramKeys = Array.isArray(msg.paramKeys) ? msg.paramKeys.slice(0, VIEW_MAX_PARAMS) : [];
    for (const key of paramKeys) frame.p[key] = 0;
    frame.sampleRate = typeof msg.sampleRate === 'number' ? msg.sampleRate : 48000;
    try {
      view = compileView(String(msg.source ?? ''), frame.sampleRate);
      recorder = new DrawRecorder(new Float32Array(0), msg.labelCount ?? 0);
    } catch (err) {
      view = null;
      post({ type: 'error', message: errorText(err) });
    }
    return;
  }

  if (msg.type !== 'frame') return;
  const input = msg.in;
  const out = msg.out;
  if (!(input instanceof Float32Array) || !(out instanceof Float32Array)) return;

  // Sin vista viva se devuelven los buffers igual: el host los necesita de
  // vuelta para no quedarse sin con qué mandar el siguiente frame.
  if (!view || !recorder) {
    post({ type: 'draw', in: input, out, len: 0, cost: 0, error: 'Vista no inicializada' }, [
      input.buffer,
      out.buffer,
    ]);
    return;
  }

  // Los datos se COPIAN del buffer transferido a los campos estables del frame.
  // Así el plugin nunca sostiene una referencia a un buffer que el host va a
  // transferir de vuelta, y no hace falta crear vistas nuevas por frame.
  frame.t = input[IN_T] ?? 0;
  frame.dt = input[IN_DT] ?? 0;
  frame.sampleRate = input[IN_SAMPLE_RATE] ?? frame.sampleRate;
  frame.aspect = input[IN_ASPECT] ?? 1;
  const flags = input[IN_FLAGS] ?? 0;
  frame.hasLevel = (flags & FLAG_LEVEL) !== 0;
  frame.hasSpectrum = (flags & FLAG_SPECTRUM) !== 0;
  frame.peak = frame.hasLevel ? (input[IN_LEVEL] ?? 0) : 0;
  frame.rms = frame.hasLevel ? (input[IN_LEVEL + 1] ?? 0) : 0;

  const nParams = Math.min(paramKeys.length, input[IN_NPARAMS] ?? 0);
  for (let i = 0; i < nParams; i++) frame.p[paramKeys[i]!] = input[IN_PARAMS + i] ?? 0;

  const bins = frame.hasSpectrum
    ? Math.max(0, Math.min(VIEW_SPECTRUM_BINS, Math.floor(input[IN_NBINS] ?? 0)))
    : 0;
  frame.bins = bins;
  if (bins > 0) frame.spectrum.set(input.subarray(IN_SPECTRUM, IN_SPECTRUM + bins));

  recorder.reset(out);
  let error: string | undefined;
  const t0 = performance.now();
  try {
    view.draw?.(recorder, frame);
  } catch (err) {
    // Igual que el DSP: si el plugin lanza, esta vuelta se pierde y ya. Tres
    // seguidas y el host apaga la vista (MAX_DRAW_ERRORS).
    error = errorText(err);
  }
  const cost = performance.now() - t0;
  const len = error === undefined ? recorder.length : 0;
  post({ type: 'draw', in: input, out, len, cost, error }, [input.buffer, out.buffer]);
};
