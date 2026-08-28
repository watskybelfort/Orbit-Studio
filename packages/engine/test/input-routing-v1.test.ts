/**
 * Entrada de N canales y enrutado del canal FÍSICO a la pista.
 *
 * Es la continuación de `live-input-v1.test.ts`: allí la entrada era un par
 * estéreo fijo y lo que había que demostrar era que entra antes de los inserts.
 * Aquí lo que hay que demostrar es lo otro:
 *
 * - que con una interfaz de ocho entradas se puede **elegir el par** (la 5 y la
 *   6, no el que el sistema ponga primero),
 * - que dos entradas van a **pistas distintas a la vez**, que es grabar dos
 *   micros de una,
 * - y que un proyecto **sin enrutado declarado se comporta exactamente como
 *   antes**: el par 1-2 a su pista. Eso último es lo que hace que un `.orbit`
 *   guardado ayer suene hoy igual.
 *
 * **No hay interfaz de audio en este entorno.** Lo que entra aquí es un bloque
 * sintético de N canales, cada uno con su valor constante: basta para probar el
 * reparto —que es lo que se ha escrito— pero no sustituye a enchufar un aparato
 * de verdad y comprobar que el driver entrega los ocho canales.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, type EffectSlot } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 48000;

function kernel(): KernelCore {
  const core = new KernelCore(SR);
  const project = createEmptyProject();
  core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
  return core;
}

/**
 * Un bloque de entrada de N canales: cada valor es un canal con esa constante,
 * `null` = ese canal no viene (el aparato no lo tiene).
 */
function channels(values: (number | null)[]): (Float32Array | undefined)[] {
  return values.map((v) => (v === null ? undefined : new Float32Array(MAX_BLOCK).fill(v)));
}

function listen(core: KernelCore, monitor = true, trackIndex = 1, gain = 1): void {
  core.handleMessage({ type: 'setLiveInput', listening: true, monitor, trackIndex, gain });
}

/** Un par de buffers de salida limpios. */
function out(): [Float32Array, Float32Array] {
  return [new Float32Array(MAX_BLOCK), new Float32Array(MAX_BLOCK)];
}

function peak(xs: Float32Array): number {
  let m = 0;
  for (const v of xs) m = Math.max(m, Math.abs(v));
  return m;
}

describe('entrada de N canales', () => {
  it('elige el PAR que se le diga, no el que llegue primero', () => {
    // Ocho entradas: solo la 5 y la 6 traen señal (índices 4 y 5). Sin enrutado
    // esto no habría forma de oírlo — que es justo el problema.
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [{ srcL: 4, srcR: 5, mixerTrack: 1, gain: 1, monitor: true }],
    });
    listen(core);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0, 0, 0, 0, 0.5, 0.5, 0, 0]));
    expect(peak(l)).toBeGreaterThan(0.4);
    expect(core.meterFrame().inputPeak).toBeCloseTo(0.5, 5);
  });

  it('dos entradas a la vez, cada una en SU pista', () => {
    // El caso que no existía: un micro en la 1 a la pista 1 y otro en la 5 a la
    // pista 3, sonando los dos al mismo tiempo desde un solo aparato.
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: true },
        { srcL: 4, srcR: -1, mixerTrack: 3, gain: 1, monitor: true },
      ],
    });
    listen(core);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.6, 0, 0, 0, 0.25, 0, 0, 0]));
    const peaks = core.meterFrame().peaks;
    // Cada pista ve LO SUYO y solo lo suyo.
    expect(peaks[1]!).toBeGreaterThan(0.5);
    expect(peaks[1]!).toBeLessThan(0.7);
    expect(peaks[3]!).toBeGreaterThan(0.2);
    expect(peaks[3]!).toBeLessThan(0.35);
    // Y las que no tienen nada enrutado siguen mudas.
    expect(peaks[2]!).toBe(0);
    expect(peaks[4]!).toBe(0);
  });

  it('cada entrada trae SU pico: con dos micros se ve cuál satura', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: false },
        { srcL: 6, srcR: -1, mixerTrack: 2, gain: 1, monitor: false },
      ],
    });
    listen(core, false);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.2, 0, 0, 0, 0, 0, 0.95, 0]));
    const frame = core.meterFrame();
    expect(frame.inputPeaks).toBeDefined();
    expect(frame.inputPeaks![0]!).toBeCloseTo(0.2, 5);
    expect(frame.inputPeaks![1]!).toBeCloseTo(0.95, 5);
    // Y el número de siempre sigue siendo "está entrando algo": el mayor.
    expect(frame.inputPeak).toBeCloseTo(0.95, 5);
  });

  it('la ganancia es POR entrada (y el medidor sigue enseñando lo que trae)', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: true },
        { srcL: 1, srcR: -1, mixerTrack: 3, gain: 0.1, monitor: true },
      ],
    });
    listen(core);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.4, 0.4]));
    const frame = core.meterFrame();
    expect(frame.peaks[1]!).toBeGreaterThan(0.35);
    expect(frame.peaks[3]!).toBeLessThan(0.08);
    // Los dos micros traen lo mismo: bajarle la ganancia a uno no le cambia
    // el medidor, que es lo que dice si está saturando.
    expect(frame.inputPeaks![0]!).toBeCloseTo(0.4, 5);
    expect(frame.inputPeaks![1]!).toBeCloseTo(0.4, 5);
  });

  it('una entrada MONO llega a los dos lados', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [{ srcL: 3, srcR: -1, mixerTrack: 1, gain: 1, monitor: true }],
    });
    listen(core);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0, 0, 0, 0.3, 0, 0, 0, 0]));
    expect(peak(l)).toBeGreaterThan(0.25);
    expect(peak(r)).toBeGreaterThan(0.25);
  });

  it('el monitor de cada entrada manda: se puede grabar una sin oírla', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: false },
        { srcL: 1, srcR: -1, mixerTrack: 3, gain: 1, monitor: true },
      ],
    });
    listen(core);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.5, 0.5]));
    const peaks = core.meterFrame().peaks;
    expect(peaks[1]!).toBe(0);
    expect(peaks[3]!).toBeGreaterThan(0.4);
  });

  it('apagar el monitor MAESTRO las calla todas de un botón', () => {
    // Es lo que hace falta cuando hay altavoces delante: que no haya que
    // desmarcar entrada por entrada mientras se acopla.
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: true },
        { srcL: 1, srcR: -1, mixerTrack: 3, gain: 1, monitor: true },
      ],
    });
    listen(core, false);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.5, 0.5]));
    const frame = core.meterFrame();
    expect(peak(l)).toBe(0);
    // Pero se siguen MIDIENDO: así se ajusta la ganancia sin acoplar.
    expect(frame.inputPeak).toBeCloseTo(0.5, 5);
  });

  it('una entrada que el aparato no tiene no suena ni MUEVE a las demás', () => {
    // Un proyecto con rutas en la 5-6 abierto con el micro del portátil. Lo que
    // no puede pasar es que la segunda entrada se recoloque en el hueco de la
    // primera: su índice es lo que enlaza su toma con su pista.
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 4, srcR: 5, mixerTrack: 1, gain: 1, monitor: true },
        { srcL: 0, srcR: -1, mixerTrack: 3, gain: 1, monitor: true },
      ],
    });
    listen(core);
    const [l, r] = out();
    // Solo dos canales: la primera ruta se queda sin su par.
    expect(() => core.process(l, r, MAX_BLOCK, channels([0.4, 0.4]))).not.toThrow();
    const frame = core.meterFrame();
    expect(frame.peaks[1]!).toBe(0);
    expect(frame.peaks[3]!).toBeGreaterThan(0.3);
    expect(frame.inputPeaks![0]!).toBe(0);
    expect(frame.inputPeaks![1]!).toBeCloseTo(0.4, 5);
  });

  it('entra ANTES de los inserts de SU pista, entrada por entrada', () => {
    // La misma prueba de `live-input-v1`, pero con dos entradas: la puerta de
    // la pista 1 se come la suya y la de la pista 3 sigue pasando.
    const core = kernel();
    const project = createEmptyProject();
    const gate: EffectSlot = {
      id: 'fx-gate',
      kind: 'gate',
      enabled: true,
      mix: 1,
      params: { threshold: 0.99, attack: 0.001, release: 0.001 },
    };
    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot: gate });
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: true },
        { srcL: 1, srcR: -1, mixerTrack: 3, gain: 1, monitor: true },
      ],
    });
    listen(core);
    const [l, r] = out();
    for (let i = 0; i < 20; i++) core.process(l, r, MAX_BLOCK, channels([0.2, 0.2]));
    const peaks = core.meterFrame().peaks;
    expect(peaks[1]!).toBeLessThan(0.05);
    expect(peaks[3]!).toBeGreaterThan(0.15);
  });
});

describe('lo guardado sin enrutado se comporta como siempre', () => {
  it('un proyecto que no declara nada usa el par 1-2 y su pista', () => {
    // Aunque el aparato traiga ocho entradas: sin rutas declaradas, la 1 y la 2
    // a la pista de `setLiveInput`. Es lo que hace que un .orbit viejo abra y
    // grabe exactamente igual.
    const core = kernel();
    listen(core, true, 2);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.5, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]));
    const peaks = core.meterFrame().peaks;
    expect(peaks[2]!).toBeGreaterThan(0.4);
    expect(peaks[2]!).toBeLessThan(0.7); // los canales 3..8 NO entran
    expect(peaks[1]!).toBe(0);
  });

  it('sin rutas no manda picos por ruta (no hay nada que desglosar)', () => {
    const core = kernel();
    listen(core, false);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.5, 0.5]));
    const frame = core.meterFrame();
    expect(frame.inputPeaks).toBeUndefined();
    expect(frame.inputPeak).toBeCloseTo(0.5, 5);
  });

  it('la llamada de siempre (dos Float32Array sueltos) sigue valiendo', () => {
    // El render offline y medio banco de pruebas llaman así.
    const core = kernel();
    listen(core);
    const [l, r] = out();
    const mono = new Float32Array(MAX_BLOCK).fill(0.3);
    core.process(l, r, MAX_BLOCK, mono);
    expect(peak(l)).toBeGreaterThan(0.25);
    expect(peak(r)).toBeGreaterThan(0.25);
  });

  it('volver a la lista vacía devuelve la ruta implícita', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [{ srcL: 4, srcR: -1, mixerTrack: 3, gain: 1, monitor: true }],
    });
    core.handleMessage({ type: 'setInputRoutes', routes: [] });
    listen(core, true, 1);
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.5, 0.5, 0, 0, 0.9]));
    const frame = core.meterFrame();
    expect(frame.peaks[1]!).toBeGreaterThan(0.4);
    expect(frame.peaks[3]!).toBe(0);
    expect(frame.inputPeaks).toBeUndefined();
  });
});

describe('grabar varias entradas a la vez', () => {
  it('cada ruta trae SU audio, y la primera además por el camino de siempre', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: false },
        { srcL: 5, srcR: -1, mixerTrack: 3, gain: 1, monitor: false },
      ],
    });
    listen(core, false);
    core.handleMessage({ type: 'setInputCapture', enabled: true, routes: [0, 1] });
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.6, 0, 0, 0, 0, 0.2, 0, 0]));
    const frame = core.meterFrame();
    expect(frame.inputCaptures).toHaveLength(2);
    expect(frame.inputCaptures![0]!.routeIndex).toBe(0);
    expect(frame.inputCaptures![0]!.left[0]!).toBeCloseTo(0.6, 5);
    expect(frame.inputCaptures![1]!.routeIndex).toBe(1);
    expect(frame.inputCaptures![1]!.left[0]!).toBeCloseTo(0.2, 5);
    // El camino de siempre trae la PRIMERA, sin copiar: es el mismo array.
    expect(frame.inputCaptureL).toBe(frame.inputCaptures![0]!.left);
  });

  it('graba en CRUDO: sin la ganancia de su entrada', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [{ srcL: 2, srcR: -1, mixerTrack: 1, gain: 0.1, monitor: true }],
    });
    listen(core);
    core.handleMessage({ type: 'setInputCapture', enabled: true, routes: [0] });
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0, 0, 0.7, 0]));
    expect(core.meterFrame().inputCaptureL![0]!).toBeCloseTo(0.7, 5);
  });

  it('solo graban las rutas que se pidieron', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: false },
        { srcL: 1, srcR: -1, mixerTrack: 2, gain: 1, monitor: false },
      ],
    });
    listen(core, false);
    core.handleMessage({ type: 'setInputCapture', enabled: true, routes: [1] });
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.6, 0.2]));
    const frame = core.meterFrame();
    expect(frame.inputCaptures).toHaveLength(1);
    expect(frame.inputCaptures![0]!.routeIndex).toBe(1);
    expect(frame.inputCaptureL![0]!).toBeCloseTo(0.2, 5);
  });

  it('sin lista de rutas graba la primera: la toma de un micro de siempre', () => {
    const core = kernel();
    listen(core, false);
    core.handleMessage({ type: 'setInputCapture', enabled: true });
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.45, 0.45, 0.9]));
    const frame = core.meterFrame();
    expect(frame.inputCaptureL).toHaveLength(MAX_BLOCK);
    expect(frame.inputCaptureL![0]!).toBeCloseTo(0.45, 5);
    expect(frame.inputCaptures).toHaveLength(1);
  });

  it('encoger el enrutado apaga la grabación de las rutas que ya no existen', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: false },
        { srcL: 1, srcR: -1, mixerTrack: 2, gain: 1, monitor: false },
      ],
    });
    listen(core, false);
    core.handleMessage({ type: 'setInputCapture', enabled: true, routes: [0, 1] });
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [{ srcL: 0, srcR: -1, mixerTrack: 1, gain: 1, monitor: false }],
    });
    const [l, r] = out();
    core.process(l, r, MAX_BLOCK, channels([0.3, 0.3]));
    expect(core.meterFrame().inputCaptures).toHaveLength(1);
  });
});

describe('la regla dura: cero alocaciones en process()', () => {
  it('cuatro entradas grabando no alocan un solo buffer por bloque', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setInputRoutes',
      routes: [
        { srcL: 0, srcR: 1, mixerTrack: 1, gain: 1, monitor: true },
        { srcL: 2, srcR: -1, mixerTrack: 2, gain: 1, monitor: true },
        { srcL: 3, srcR: -1, mixerTrack: 3, gain: 1, monitor: false },
        { srcL: 7, srcR: -1, mixerTrack: 4, gain: 1, monitor: true },
      ],
    });
    listen(core);
    core.handleMessage({ type: 'setInputCapture', enabled: true, routes: [0, 1, 2, 3] });
    const block = channels([0.1, 0.1, 0.2, 0.3, 0, 0, 0, 0.4]);
    const [l, r] = out();
    // Un bloque de calentamiento fuera de la cuenta: lo que se mide es el
    // régimen, no el primero.
    core.process(l, r, MAX_BLOCK, block);

    const Real = globalThis.Float32Array;
    let allocations = 0;
    class Counting extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        allocations++;
      }
    }
    (globalThis as { Float32Array: unknown }).Float32Array = Counting;
    try {
      for (let i = 0; i < 32; i++) core.process(l, r, MAX_BLOCK, block);
    } finally {
      (globalThis as { Float32Array: unknown }).Float32Array = Real;
    }
    expect(allocations).toBe(0);
  });
});
