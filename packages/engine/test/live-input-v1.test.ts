/**
 * Entrada en vivo por la entrada del nodo del kernel.
 *
 * Lo que hay que demostrar es que el micro entra ANTES de los inserts de su
 * pista: si entrara después, el monitor sonaría seco y no serviría para nada
 * (cantar con el reverb y el compresor puestos es justo la gracia). Y que
 * medir el nivel no obliga a oírse, que es como se ajusta la ganancia sin
 * montar un acople.
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

/** Bloque de entrada con un valor constante (fácil de seguir por la mesa). */
function block(value: number): Float32Array {
  return new Float32Array(MAX_BLOCK).fill(value);
}

function peak(xs: Float32Array): number {
  let m = 0;
  for (const v of xs) m = Math.max(m, Math.abs(v));
  return m;
}

describe('entrada en vivo', () => {
  it('sin escuchar, lo que entre no sale ni se mide', () => {
    const core = kernel();
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.5), block(0.5));
    expect(peak(l)).toBe(0);
    expect(core.meterFrame().inputPeak).toBe(0);
  });

  it('escuchando sin monitor: se mide pero NO se oye', () => {
    // Es como se ajusta la ganancia del micro sin montar un acople con los
    // altavoces puestos.
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.4), block(0.4));
    expect(peak(l)).toBe(0);
    expect(core.meterFrame().inputPeak).toBeCloseTo(0.4, 5);
  });

  it('con monitor sale por la pista que se le diga', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: true,
      trackIndex: 1,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.3), block(0.3));
    expect(peak(l)).toBeGreaterThan(0.2);
  });

  it('la ganancia se aplica al monitor pero NO al medidor', () => {
    // El medidor enseña lo que trae el micro: un micro que satura se ve aunque
    // le hayas bajado la ganancia de entrada.
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: true,
      trackIndex: 1,
      gain: 0.25,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.8), block(0.8));
    expect(core.meterFrame().inputPeak).toBeCloseTo(0.8, 5);
    expect(peak(l)).toBeLessThan(0.5);
  });

  it('entra ANTES de los inserts: el efecto de la pista lo procesa', () => {
    const core = kernel();
    const project = createEmptyProject();
    // Una puerta con umbral altísimo cierra TODO lo que pase por la pista.
    const slot: EffectSlot = {
      id: 'fx-gate',
      kind: 'gate',
      enabled: true,
      mix: 1,
      params: { threshold: 0.99, attack: 0.001, release: 0.001 },
    };
    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: true,
      trackIndex: 1,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    // Varios bloques: la puerta tiene su envolvente.
    for (let i = 0; i < 20; i++) core.process(l, r, MAX_BLOCK, block(0.2), block(0.2));
    // Si la entrada se sumara DESPUÉS de la cadena, esto saldría a 0,2.
    expect(peak(l)).toBeLessThan(0.05);
  });

  it('un micro mono llega a los dos lados', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: true,
      trackIndex: 1,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.3)); // sin canal derecho
    expect(peak(l)).toBeGreaterThan(0.2);
    expect(peak(r)).toBeGreaterThan(0.2);
  });

  it('dejar de escuchar apaga el medidor en el acto', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.7), block(0.7));
    expect(core.meterFrame().inputPeak).toBeGreaterThan(0);
    core.handleMessage({
      type: 'setLiveInput',
      listening: false,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    // Sin esto el último pico se queda clavado en pantalla como si siguiera
    // entrando algo.
    expect(core.meterFrame().inputPeak).toBe(0);
  });

  it('una pista que no existe no revienta el bloque', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: true,
      trackIndex: 999,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    expect(() => core.process(l, r, MAX_BLOCK, block(0.3), block(0.3))).not.toThrow();
    expect(core.meterFrame().inputPeak).toBeCloseTo(0.3, 5);
  });
});

describe('grabar la entrada en crudo', () => {
  it('no manda nada hasta que se le pide', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.5), block(0.5));
    const frame = core.meterFrame();
    expect(frame.inputCaptureL).toBeUndefined();
  });

  it('devuelve la señal TAL CUAL: sin ganancia y sin la cadena de la pista', () => {
    // Es lo que hay que poder volver a mezclar mañana con otra idea. Si se
    // guardara lo que sale de la pista, la toma vendría con el reverb pegado.
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: true,
      trackIndex: 1,
      gain: 0.1,
    });
    core.handleMessage({ type: 'setInputCapture', enabled: true });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.6), block(0.6));
    const frame = core.meterFrame();
    expect(frame.inputCaptureL).toHaveLength(MAX_BLOCK);
    expect(frame.inputCaptureL![0]).toBeCloseTo(0.6, 5);
    expect(frame.inputCaptureR![0]).toBeCloseTo(0.6, 5);
  });

  it('acumula entre frames y no repite lo ya entregado', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    core.handleMessage({ type: 'setInputCapture', enabled: true });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    for (let i = 0; i < 3; i++) core.process(l, r, MAX_BLOCK, block(0.2), block(0.2));
    expect(core.meterFrame().inputCaptureL).toHaveLength(3 * MAX_BLOCK);
    // Ese trozo ya se entregó: el siguiente frame no lo repite.
    expect(core.meterFrame().inputCaptureL).toBeUndefined();
    core.process(l, r, MAX_BLOCK, block(0.2), block(0.2));
    expect(core.meterFrame().inputCaptureL).toHaveLength(MAX_BLOCK);
  });

  it('graba con el transporte parado (una toma no necesita que suene nada)', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    core.handleMessage({ type: 'setInputCapture', enabled: true });
    expect(core.playing).toBe(false);
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.35), block(0.35));
    expect(core.meterFrame().inputCaptureL?.[0]).toBeCloseTo(0.35, 5);
  });

  it('apagarla tira lo pendiente y deja de mandar', () => {
    const core = kernel();
    core.handleMessage({
      type: 'setLiveInput',
      listening: true,
      monitor: false,
      trackIndex: 1,
      gain: 1,
    });
    core.handleMessage({ type: 'setInputCapture', enabled: true });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    core.process(l, r, MAX_BLOCK, block(0.4), block(0.4));
    core.handleMessage({ type: 'setInputCapture', enabled: false });
    expect(core.meterFrame().inputCaptureL).toBeUndefined();
  });
});
