/**
 * El worker de la vista, ejecutado de verdad.
 *
 * Los otros tests prueban las piezas (el grabador, el repintado, el watchdog).
 * Este ejercita el ARCHIVO que corre el código del usuario: se le pone un
 * `self` de mentira con `vi.stubGlobal` —el patrón que ya usa el repo para
 * probar cosas de navegador sin DOM (ver `live-input-bend.test.ts`)— y se le
 * mandan los mismos mensajes que le manda la sesión. Lo que se comprueba:
 *
 * - que compila el plugin del usuario y le saca una lista de dibujo,
 * - que ANTES de compilarlo desarma el objeto global que le den (en producción,
 *   ese objeto es el global del worker: sin `fetch`, sin `WebSocket`, sin
 *   `postMessage`),
 * - que dentro del cuerpo del plugin los globales peligrosos están en sombra,
 * - que un `draw` que lanza devuelve los buffers igual, con su error.
 *
 * Lo que este test NO puede demostrar es el efecto del desarme sobre el global
 * REAL: aquí el global real es el de Node (el de Vitest), y desarmarlo rompería
 * el propio test. Lo que se comprueba es que el desarme se aplica, y a qué.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fillViewInput } from '../src/plugins/view-input';
import { IN_LEN, OP, VIEW_LIST_CAP } from '../src/plugins/view-protocol';

interface Posted {
  message: Record<string, unknown>;
  transfer?: unknown[];
}

const posted: Posted[] = [];

/** `self` del worker: un objeto plano, que es lo que `harden()` va a desarmar. */
const fakeSelf: Record<string, unknown> = {
  onmessage: null,
  postMessage: (message: Record<string, unknown>, transfer?: unknown[]) => {
    posted.push({ message, transfer });
  },
  // Capacidades que el worker real tiene y que `harden()` debe quitar.
  fetch: () => 'red',
  WebSocket: class {},
  indexedDB: {},
  importScripts: () => undefined,
};

function send(msg: unknown): void {
  const handler = fakeSelf['onmessage'] as ((e: { data: unknown }) => void) | null;
  if (!handler) throw new Error('el worker no instaló su onmessage');
  handler({ data: msg });
}

function last(): Posted {
  const p = posted[posted.length - 1];
  if (!p) throw new Error('el worker no contestó');
  return p;
}

/** Un frame listo para mandar, con los buffers del ping-pong. */
function frameMsg(params: Record<string, number>, keys: string[]) {
  const input = new Float32Array(IN_LEN);
  fillViewInput(input, {
    aspect: 0.5,
    sampleRate: 48000,
    paramKeys: keys,
    params,
    defaults: params,
    level: new Float32Array([0.5, 0.25]),
    spectrumDb: null,
  });
  return { type: 'frame', in: input, out: new Float32Array(VIEW_LIST_CAP) };
}

const PLUGIN = `
const name = 'Prueba';
const params = [{ key: 'gain', label: 'Gain', min: 0, max: 1, default: 0.5 }];
const view = { height: 80, needs: ['level'], labels: ['x'] };
function createEffect(sr) { return { process(l, r, n) {} }; }
function createView(sampleRate) {
  return {
    draw(d, f) {
      d.clear();
      d.color(4).line(0, 1 - f.p.gain, 1, 1 - f.p.gain);
      d.color(5).fillRect(0, 1 - f.peak, 0.1, f.peak);
      d.label(0, 0.5, 0.5, 1);
    },
  };
}`;

beforeAll(async () => {
  vi.stubGlobal('self', fakeSelf);
  await import('../src/plugins/plugin-view-worker');
});

describe('el worker de la vista, de verdad', () => {
  it('compila el plugin y devuelve una lista de dibujo', () => {
    posted.length = 0;
    send({ type: 'init', source: PLUGIN, paramKeys: ['gain'], labelCount: 1, sampleRate: 48000 });
    expect(posted).toHaveLength(0); // un init que va bien no contesta nada

    send(frameMsg({ gain: 0.75 }, ['gain']));
    const { message, transfer } = last();
    expect(message['type']).toBe('draw');
    expect(message['error']).toBeUndefined();
    expect(message['len']).toBeGreaterThan(10);
    expect(typeof message['cost']).toBe('number');
    // Los dos buffers vuelven, y vuelven transferidos: es el ping-pong.
    expect(message['in']).toBeInstanceOf(Float32Array);
    expect(message['out']).toBeInstanceOf(Float32Array);
    expect(transfer).toHaveLength(2);

    const out = message['out'] as Float32Array;
    expect(out[0]).toBe(OP.CLEAR);
  });

  it('los valores de las perillas llegan al plugin por su clave', () => {
    // La lista del plugin de prueba es: CLEAR · COLOR,4 · BEGIN · MOVE,x,y …
    // y esa `y` es `1 - f.p.gain`, así que sirve de sonda del valor recibido.
    const yDeLaLinea = (buf: Float32Array): number => buf[6]!;

    posted.length = 0;
    send(frameMsg({ gain: 0.25 }, ['gain']));
    const a = yDeLaLinea(last().message['out'] as Float32Array);
    posted.length = 0;
    send(frameMsg({ gain: 0.9 }, ['gain']));
    const b = yDeLaLinea(last().message['out'] as Float32Array);

    expect(a).toBeCloseTo(0.75, 5);
    expect(b).toBeCloseTo(0.1, 5);
  });

  it('desarma el global ANTES de compilar nada del usuario', () => {
    // El init de arriba ya corrió: si `harden()` no se hubiera aplicado, estas
    // capacidades seguirían ahí cuando corrió el top-level del plugin.
    expect(fakeSelf['fetch']).toBeUndefined();
    expect(fakeSelf['WebSocket']).toBeUndefined();
    expect(fakeSelf['indexedDB']).toBeUndefined();
    expect(fakeSelf['importScripts']).toBeUndefined();
    expect(fakeSelf['postMessage']).toBeUndefined();
    // Y no se puede volver a poner: la propiedad queda no reconfigurable.
    expect(() => {
      Object.defineProperty(fakeSelf, 'fetch', { value: () => 'red' });
    }).toThrow();
  });

  it('dentro del plugin, los globales peligrosos están en sombra', () => {
    posted.length = 0;
    send({
      type: 'init',
      source: `function createEffect(sr){return{process(){}}}
function createView() {
  const visto = [typeof fetch, typeof document, typeof window, typeof postMessage, typeof WebSocket];
  return { draw(d, f) {
    if (visto.some((t) => t !== 'undefined')) throw new Error('fuga: ' + visto.join(','));
    d.clear();
  } };
}`,
      paramKeys: [],
      labelCount: 0,
      sampleRate: 48000,
    });
    send(frameMsg({}, []));
    expect(last().message['error']).toBeUndefined();
    expect(last().message['len']).toBe(1);
  });

  it('el cuerpo del plugin corre en modo estricto (sin globales implícitos)', () => {
    posted.length = 0;
    send({
      type: 'init',
      source: `function createEffect(sr){return{process(){}}}
function createView() {
  return { draw(d) { fugado = 1; d.clear(); } };
}`,
      paramKeys: [],
      labelCount: 0,
      sampleRate: 48000,
    });
    send(frameMsg({}, []));
    // En modo laxo esto habría creado un global; aquí lanza y se reporta.
    expect(String(last().message['error'])).toContain('fugado');
    expect((globalThis as Record<string, unknown>)['fugado']).toBeUndefined();
  });

  it('un draw que lanza devuelve los buffers igual, con su error', () => {
    posted.length = 0;
    send({
      type: 'init',
      source: `function createEffect(sr){return{process(){}}}
function createView(){ return { draw() { throw new Error('reventé'); } }; }`,
      paramKeys: [],
      labelCount: 0,
      sampleRate: 48000,
    });
    send(frameMsg({}, []));
    const { message } = last();
    expect(message['error']).toBe('reventé');
    expect(message['len']).toBe(0);
    // Devolver los buffers es lo que evita que la vista se quede muda.
    expect(message['in']).toBeInstanceOf(Float32Array);
    expect(message['out']).toBeInstanceOf(Float32Array);
  });

  it('un plugin sin createView se rechaza al arrancar', () => {
    posted.length = 0;
    send({
      type: 'init',
      source: 'function createEffect(sr){return{process(){}}}',
      paramKeys: [],
      labelCount: 0,
      sampleRate: 48000,
    });
    expect(last().message['type']).toBe('error');
    expect(String(last().message['message'])).toContain('createView');
  });

  it('una vista rota devuelve los buffers en vez de tragárselos', () => {
    posted.length = 0;
    send({
      type: 'init',
      source: 'function createEffect(sr){return{process(){}}} function createView(){ return {}; }',
      paramKeys: [],
      labelCount: 0,
      sampleRate: 48000,
    });
    expect(last().message['type']).toBe('error');
    posted.length = 0;
    send(frameMsg({}, []));
    expect(last().message['type']).toBe('draw');
    expect(last().message['error']).toBe('Vista no inicializada');
    expect(last().transfer).toHaveLength(2);
  });

  it('mensajes basura no lo tumban', () => {
    posted.length = 0;
    expect(() => send(null)).not.toThrow();
    expect(() => send(42)).not.toThrow();
    expect(() => send({ type: 'lo-que-sea' })).not.toThrow();
    expect(() => send({ type: 'frame', in: 'no', out: 3 })).not.toThrow();
    expect(posted).toHaveLength(0);
  });
});
