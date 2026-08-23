/**
 * Sampler multisample: qué grabación suena en cada tecla.
 *
 * Las muestras de prueba son tonos puros a frecuencias muy separadas, así que
 * "cuál sonó" se lee midiendo la frecuencia de la salida. Es la única forma de
 * comprobar de verdad que la zona elegida es la que toca — mirar el estado
 * interno probaría el `if`, no el sonido.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createKeymapZone,
  newId,
  type Note,
  type SampleRef,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 48000;

/** Tono puro de medio segundo con micro-fades (sin clicks en los bordes). */
function tone(hz: number): { left: Float32Array; right: Float32Array; rate: number } {
  const n = Math.round(0.5 * SR);
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 200) * Math.min(1, (n - i) / 200);
    left[i] = Math.sin((2 * Math.PI * hz * i) / SR) * 0.8 * env;
  }
  return { left, right: left.slice(), rate: SR };
}

/** Frecuencia por cruces por cero ascendentes. */
function estimateFreq(xs: Float32Array, from: number, to: number): number {
  let crossings = 0;
  const end = Math.min(to, xs.length);
  for (let i = from + 1; i < end; i++) if (xs[i - 1]! <= 0 && xs[i]! > 0) crossings++;
  return crossings / ((end - from) / SR);
}

/**
 * Contar cruces por cero sobre una ventana pierde el ciclo de los bordes, así
 * que se compara en RELATIVO: un 5 % separa de sobra 200 de 283, 400 y 800,
 * que es lo que hay que distinguir aquí.
 */
function expectFreq(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(0.05);
}

function rms(xs: Float32Array): number {
  let s = 0;
  for (const v of xs) s += v * v;
  return Math.sqrt(s / Math.max(1, xs.length));
}

/**
 * Monta un kernel con un canal de sampler, sus samples cargados y su keymap,
 * y devuelve la salida de tocar una nota sostenida.
 */
function playNote(
  zones: ReturnType<typeof createKeymapZone>[],
  samples: Record<string, { left: Float32Array; right: Float32Array; rate: number }>,
  key: number,
  velocity: number,
  blocks = 60,
): Float32Array {
  const project = createEmptyProject();
  const channel = createChannel('sampler', 0, 'Multi');
  applyCommand(project, { type: 'addChannel', channel });
  for (const id of Object.keys(samples)) {
    const sample: SampleRef = { id, name: id, path: 'pack:' + id, hash: id, duration: 0.5 };
    applyCommand(project, { type: 'registerSample', sample });
  }
  applyCommand(project, { type: 'patchChannel', channelId: channel.id, patch: { keymap: zones } });
  // Attack corto y release largo: la nota está sonando a tope en el bloque 10.
  applyCommand(project, {
    type: 'setChannelParam',
    channelId: channel.id,
    key: 'attack',
    value: 0.001,
  });

  const patternId = project.patternOrder[0]!;
  const note: Note = { id: newId(), start: 0, duration: 4, key, velocity, pan: 0, slide: false };
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id, notes: [note] });

  const core = new KernelCore(SR);
  for (const [id, data] of Object.entries(samples)) {
    core.handleMessage({
      type: 'loadSample',
      sampleId: id,
      left: data.left,
      right: data.right,
      sampleRate: data.rate,
    });
  }
  core.handleMessage({
    type: 'snapshot',
    project: compileProject(project, { mode: 'pattern', patternId }),
  });
  core.handleMessage({ type: 'play', fromBeat: 0 });

  const out = new Float32Array(blocks * MAX_BLOCK);
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < blocks; b++) {
    core.process(l, r, MAX_BLOCK);
    out.set(l, b * MAX_BLOCK);
  }
  return out;
}

const GRAVE = tone(200);
const AGUDO = tone(800);
const SAMPLES = { grave: GRAVE, agudo: AGUDO };

describe('sampler multisample', () => {
  it('cada mitad del teclado suena con SU grabación', () => {
    const zones = [
      createKeymapZone('grave', { keyLow: 0, keyHigh: 59, keyRoot: 48 }),
      createKeymapZone('agudo', { keyLow: 60, keyHigh: 127, keyRoot: 72 }),
    ];
    // Tocando la raíz de cada zona, el sample suena SIN transponer.
    const bajo = playNote(zones, SAMPLES, 48, 0.9);
    expectFreq(estimateFreq(bajo, 2000, 20000), 200);
    const alto = playNote(zones, SAMPLES, 72, 0.9);
    expectFreq(estimateFreq(alto, 2000, 20000), 800);
  });

  it('transpone desde la RAÍZ de su zona, no desde el do central', () => {
    // Es la diferencia con el sampler de un solo sample: una octava por encima
    // de la raíz de la zona son 400 Hz, aunque la tecla sea la 60.
    const zones = [createKeymapZone('grave', { keyLow: 0, keyHigh: 127, keyRoot: 48 })];
    const octavaArriba = playNote(zones, SAMPLES, 60, 0.9);
    expectFreq(estimateFreq(octavaArriba, 2000, 20000), 400);
  });

  it('la velocidad elige la capa', () => {
    const zones = [
      createKeymapZone('grave', { keyLow: 60, keyHigh: 60, keyRoot: 60, velLow: 0, velHigh: 0.5 }),
      createKeymapZone('agudo', { keyLow: 60, keyHigh: 60, keyRoot: 60, velLow: 0.51, velHigh: 1 }),
    ];
    expectFreq(estimateFreq(playNote(zones, SAMPLES, 60, 0.2), 2000, 20000), 200);
    expectFreq(estimateFreq(playNote(zones, SAMPLES, 60, 0.9), 2000, 20000), 800);
  });

  it('las zonas solapadas suenan A LA VEZ: eso son las capas', () => {
    const zones = [
      createKeymapZone('grave', { keyLow: 60, keyHigh: 60, keyRoot: 60 }),
      createKeymapZone('agudo', { keyLow: 60, keyHigh: 60, keyRoot: 60 }),
    ];
    const juntas = playNote(zones, SAMPLES, 60, 0.9);
    const solaGrave = playNote(
      [createKeymapZone('grave', { keyLow: 60, keyHigh: 60, keyRoot: 60 })],
      SAMPLES,
      60,
      0.9,
    );
    // Con las dos capas hay más energía que con una sola, y el agudo aparece.
    expect(rms(juntas.subarray(2000, 20000))).toBeGreaterThan(
      rms(solaGrave.subarray(2000, 20000)) * 1.2,
    );
  });

  it('una tecla en un hueco del mapa es silencio, no un crujido', () => {
    const zones = [createKeymapZone('grave', { keyLow: 0, keyHigh: 40, keyRoot: 36 })];
    const fuera = playNote(zones, SAMPLES, 90, 0.9);
    expect(rms(fuera)).toBeLessThan(1e-4);
  });

  it('la ganancia de la zona iguala tomas de volumen distinto', () => {
    const fuerte = playNote(
      [createKeymapZone('grave', { keyLow: 60, keyHigh: 60, keyRoot: 60, gain: 1 })],
      SAMPLES,
      60,
      0.9,
    );
    const floja = playNote(
      [createKeymapZone('grave', { keyLow: 60, keyHigh: 60, keyRoot: 60, gain: 0.25 })],
      SAMPLES,
      60,
      0.9,
    );
    expect(rms(floja.subarray(2000, 20000))).toBeLessThan(
      rms(fuerte.subarray(2000, 20000)) * 0.4,
    );
  });

  it('la afinación fina de la zona mueve el tono', () => {
    const afinada = playNote(
      [createKeymapZone('grave', { keyLow: 60, keyHigh: 60, keyRoot: 60, tune: 12 })],
      SAMPLES,
      60,
      0.9,
    );
    // `tune` se acota a media octava: +6 semitonos ≈ ×1,414.
    expectFreq(estimateFreq(afinada, 2000, 20000), 283);
  });

  it('sin keymap, el sampler de un solo sample sigue exactamente igual', () => {
    const project = createEmptyProject();
    const channel = createChannel('sampler', 0, 'Uno');
    channel.sampleId = 'grave';
    applyCommand(project, { type: 'addChannel', channel });
    applyCommand(project, {
      type: 'registerSample',
      sample: { id: 'grave', name: 'grave', path: 'pack:grave', hash: 'g', duration: 0.5 },
    });
    const patternId = project.patternOrder[0]!;
    applyCommand(project, {
      type: 'addNotes',
      patternId,
      channelId: channel.id,
      notes: [{ id: newId(), start: 0, duration: 4, key: 60, velocity: 0.9, pan: 0, slide: false }],
    });
    const core = new KernelCore(SR);
    core.handleMessage({
      type: 'loadSample',
      sampleId: 'grave',
      left: GRAVE.left,
      right: GRAVE.right,
      sampleRate: SR,
    });
    core.handleMessage({
      type: 'snapshot',
      project: compileProject(project, { mode: 'pattern', patternId }),
    });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    const out = new Float32Array(60 * MAX_BLOCK);
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    for (let b = 0; b < 60; b++) {
      core.process(l, r, MAX_BLOCK);
      out.set(l, b * MAX_BLOCK);
    }
    // Keytrack de siempre: la tecla 60 es el do central, sample sin transponer.
    expectFreq(estimateFreq(out, 2000, 20000), 200);
  });

  it('una zona que apunta a un sample que no está cargado no revienta', () => {
    const zones = [createKeymapZone('fantasma', { keyLow: 0, keyHigh: 127, keyRoot: 60 })];
    expect(() => playNote(zones, SAMPLES, 60, 0.9)).not.toThrow();
  });

  it('la salida no trae NaN (un NaN se queda en el master para siempre)', () => {
    const zones = [
      createKeymapZone('grave', { keyLow: 0, keyHigh: 127, keyRoot: 24 }),
      createKeymapZone('agudo', { keyLow: 0, keyHigh: 127, keyRoot: 110 }),
    ];
    for (const key of [0, 30, 60, 100, 127]) {
      const out = playNote(zones, SAMPLES, key, 1);
      expect(out.some((v) => !Number.isFinite(v))).toBe(false);
    }
  });
});
