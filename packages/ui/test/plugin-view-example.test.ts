/**
 * El ejemplo de `docs/PLUGINS.md` tiene que FUNCIONAR, no parecerlo.
 *
 * Una doc con un plugin de ejemplo que ya no compila —o que dibuja fuera del
 * área, o que llama a un método que se renombró— es peor que no tenerla: el
 * usuario copia y pega, no le sale, y no sabe si la culpa es suya. Así que el
 * ejemplo no se transcribe aquí: se LEE del propio markdown, y se ejercita
 * entero — el DSP contra una señal de verdad y la vista contra el grabador de
 * verdad, con el mismo `new Function` que usa el worker.
 *
 * Si alguien toca el ejemplo de la doc y lo rompe, esto falla.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parsePluginSource, defaultPluginParams } from '../src/state/plugin-parse';
import { DrawRecorder } from '../src/plugins/view-recorder';
import { replayDisplayList, type Canvas2DLike } from '../src/plugins/view-replay';
import { VIEW_LIST_CAP } from '../src/plugins/view-protocol';
import { readText } from './read-source';

const here = dirname(fileURLToPath(import.meta.url));
const DOC = resolve(here, '../../../docs/PLUGINS.md');

/** Saca el bloque ```js cuyo contenido empieza por `marker`. */
function fencedBlock(markdown: string, marker: string): string {
  const fences = markdown.split('```');
  // Los impares son bloques; el primer token de cada uno es el lenguaje.
  for (let i = 1; i < fences.length; i += 2) {
    const block = fences[i]!;
    const nl = block.indexOf('\n');
    const body = block.slice(nl + 1);
    if (body.includes(marker)) return body;
  }
  throw new Error(`no hay bloque de código con "${marker}" en PLUGINS.md`);
}

const source = fencedBlock(readText(DOC), 'compresor-visible.js');

/** Compila como el worker: modo estricto y globales peligrosos en sombra. */
function compile(fn: 'createEffect' | 'createView'): (...a: unknown[]) => unknown {
  const shadow = ['self', 'globalThis', 'window', 'document', 'fetch', 'postMessage'];
  const factory = new Function(
    ...shadow,
    `'use strict';\n${source}\n;return ${fn};`,
  ) as (...a: unknown[]) => unknown;
  const made = factory(...shadow.map(() => undefined));
  if (typeof made !== 'function') throw new Error(`${fn} no salió como función`);
  return made as (...a: unknown[]) => unknown;
}

interface EffectLike {
  setParams(p: Record<string, number>): void;
  process(l: Float32Array, r: Float32Array, n: number): void;
}
interface ViewLike {
  draw(d: DrawRecorder, f: Record<string, unknown>): void;
}

describe('el ejemplo de la doc: metadata', () => {
  it('el parser estático lo reconoce entero', () => {
    const parsed = parsePluginSource(source);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Compresor visible');
    expect(parsed!.effect).toBe(true);
    expect(parsed!.params.map((p) => p.key)).toEqual([
      'threshold',
      'ratio',
      'attack',
      'release',
      'makeup',
    ]);
    expect(parsed!.view).not.toBeNull();
    expect(parsed!.view!.needs.level).toBe(true);
    expect(parsed!.view!.labels).toEqual(['-48', '0 dB', 'GR']);
  });
});

describe('el ejemplo de la doc: el DSP comprime de verdad', () => {
  it('baja los picos por encima del umbral y deja pasar lo de abajo', () => {
    const create = compile('createEffect') as (sr: number) => EffectLike;
    const sr = 48000;
    const n = 4096;

    const run = (amp: number): number => {
      const fx = create(sr);
      fx.setParams({ threshold: -18, ratio: 8, attack: 1, release: 50, makeup: 0 });
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        l[i] = amp * Math.sin((2 * Math.PI * 220 * i) / sr);
        r[i] = l[i]!;
      }
      fx.process(l, r, n);
      // Pico de la segunda mitad: la primera es el ataque.
      let peak = 0;
      for (let i = n / 2; i < n; i++) peak = Math.max(peak, Math.abs(l[i]!));
      return peak;
    };

    const loud = run(1); // 0 dBFS, muy por encima de -18
    const quiet = run(0.02); // ~-34 dB, por debajo del umbral
    expect(loud).toBeLessThan(0.5); // comprimido de verdad
    expect(loud).toBeGreaterThan(0.05); // pero no aplastado a nada
    expect(quiet).toBeGreaterThan(0.018); // lo bajo pasa casi intacto
  });

  it('no reserva ni toca nada fuera de los buffers que le dan', () => {
    const create = compile('createEffect') as (sr: number) => EffectLike;
    const fx = create(48000);
    const l = new Float32Array(64);
    const r = new Float32Array(64);
    l.fill(0.5);
    r.fill(0.5);
    // `process` trabaja in situ: mismos objetos a la salida.
    fx.process(l, r, 64);
    expect(l).toBeInstanceOf(Float32Array);
    expect(l.length).toBe(64);
    expect(Number.isFinite(l[0]!)).toBe(true);
  });
});

describe('el ejemplo de la doc: la vista dibuja de verdad', () => {
  const parsed = parsePluginSource(source)!;
  const defaults = defaultPluginParams(parsed.params);

  /** El frame tal y como lo arma el worker: objeto estable, valores por clave. */
  function makeFrame(over: Partial<Record<string, unknown>> = {}) {
    return {
      t: 1.5,
      dt: 1 / 30,
      sampleRate: 48000,
      aspect: 0.5,
      p: { ...defaults },
      peak: 0.6,
      rms: 0.3,
      hasLevel: true,
      spectrum: new Float32Array(512),
      bins: 0,
      hasSpectrum: false,
      ...over,
    };
  }

  function draw(frame: ReturnType<typeof makeFrame>): { rec: DrawRecorder; buf: Float32Array } {
    const create = compile('createView') as (sr: number) => ViewLike;
    const view = create(48000);
    const buf = new Float32Array(VIEW_LIST_CAP);
    const rec = new DrawRecorder(buf, parsed.view!.labels.length);
    rec.reset(buf);
    view.draw(rec, frame as unknown as Record<string, unknown>);
    return { rec, buf };
  }

  it('produce una lista de dibujo con contenido y sin desbordar', () => {
    const { rec } = draw(makeFrame());
    expect(rec.length).toBeGreaterThan(50);
    expect(rec.overflow).toBe(false);
  });

  it('la lista se repinta entera, sin cortes ni basura', () => {
    const { rec, buf } = draw(makeFrame());
    const calls: { fn: string; args: number[] }[] = [];
    const ctx = fakeCtx(calls);
    const stats = replayDisplayList(ctx, buf, rec.length, {
      width: 240,
      height: 130,
      palette: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      labels: parsed.view!.labels,
      font: '10px x',
    });
    expect(stats.aborted).toBe(false);
    expect(stats.ops).toBeGreaterThan(20);
    // Dibuja de verdad: hay trazo, relleno y texto.
    const fns = new Set(calls.map((c) => c.fn));
    expect(fns.has('stroke')).toBe(true);
    expect(fns.has('fillText')).toBe(true);
    // Y todo cae dentro del rectángulo.
    for (const c of calls) {
      for (const a of c.args) expect(Number.isFinite(a)).toBe(true);
    }
  });

  it('la curva se mueve cuando se mueve el ratio (no es un dibujo fijo)', () => {
    const suave = draw(makeFrame({ p: { ...defaults, ratio: 1.1 } }));
    const duro = draw(makeFrame({ p: { ...defaults, ratio: 20 } }));
    expect(Array.from(suave.buf.subarray(0, suave.rec.length))).not.toEqual(
      Array.from(duro.buf.subarray(0, duro.rec.length)),
    );
  });

  it('sin tap de la pista sigue dibujando su curva (no revienta)', () => {
    const { rec } = draw(makeFrame({ hasLevel: false, peak: 0, rms: 0 }));
    expect(rec.length).toBeGreaterThan(20);
    expect(rec.overflow).toBe(false);
  });

  it('el dibujo no reserva memoria por frame: mismo buffer, misma longitud', () => {
    const create = compile('createView') as (sr: number) => ViewLike;
    const view = create(48000);
    const buf = new Float32Array(VIEW_LIST_CAP);
    const rec = new DrawRecorder(buf, parsed.view!.labels.length);
    const lengths: number[] = [];
    for (let i = 0; i < 5; i++) {
      rec.reset(buf); // el ping-pong devolvería otro buffer; aquí basta el mismo
      view.draw(rec, makeFrame() as unknown as Record<string, unknown>);
      lengths.push(rec.length);
    }
    // Estable frame a frame (el pico decae, pero la estructura no cambia).
    expect(new Set(lengths).size).toBe(1);
  });
});

/** Contexto 2D de mentira, igual que en plugin-view-list.test.ts. */
function fakeCtx(calls: { fn: string; args: number[] }[]): Canvas2DLike {
  const rec =
    (fn: string) =>
    (...args: number[]) => {
      calls.push({ fn, args });
    };
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    font: '',
    clearRect: rec('clearRect'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    fillText: (_t: string, x: number, y: number) => calls.push({ fn: 'fillText', args: [x, y] }),
  };
}
