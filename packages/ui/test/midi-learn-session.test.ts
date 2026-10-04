import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParamRef } from '@orbit/core';

const volume: ParamRef = { kind: 'mixer', trackIndex: 1, param: 'volume' };
const pan: ParamRef = { kind: 'mixer', trackIndex: 1, param: 'pan' };

async function rig() {
  vi.resetModules();
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
  const settings = { get: vi.fn(async () => ({} as Record<string, unknown>)), set: async () => ({}) };
  vi.stubGlobal('window', { orbit: { settings } });
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const midi = await import('../src/state/midi-learn');
  const learn = (ref: ParamRef) => { midi.startMidiLearn(ref); midi.onMidiControl('cc:74', 0); };
  const flush = () => { for (const fn of frames.splice(0)) fn(0); };
  const queue = (value: number) => midi.onMidiControl('cc:74', value);
  const move = (value: number) => { queue(value); flush(); };
  const snapshot = () => ({ json: core.serializeProject(app.store.project), history: [...app.store.history], version: app.store.version });
  return { core, ...app, midi, settings, learn, flush, queue, move, snapshot };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG053: el gesto MIDI pertenece a un mapeo y a una sesión', () => {
  it('reasignar volumen a pan separa dos gestos con undo/redo coherente dentro de 800ms', async () => {
    const r = await rig();
    const initial = { ...r.store.project.mixer[1]! };
    r.learn(volume); r.move(0.1); r.move(0.2);
    r.learn(pan); r.move(0.8); r.move(0.6);
    expect(r.store.history).toHaveLength(2);
    expect(r.store.project.mixer[1]!.pan).toBeCloseTo(0.2);
    r.store.undo();
    expect(r.store.project.mixer[1]!.pan).toBe(initial.pan);
    expect(r.store.project.mixer[1]!.volume).toBeCloseTo(0.4);
    r.store.undo();
    expect(r.store.project.mixer[1]).toEqual(initial);
    r.store.redo(); r.store.redo();
    expect(r.store.project.mixer[1]!.pan).toBeCloseTo(0.2);
    expect(r.store.project.mixer[1]!.volume).toBeCloseTo(0.4);
  });

  it('un barrido continuo del mismo mapeo sigue siendo un único undo', async () => {
    const r = await rig();
    const before = r.snapshot().json;
    r.learn(volume); r.move(0.1); r.move(0.5); r.move(0.9);
    expect(r.store.history).toHaveLength(1);
    r.store.undo(); expect(r.snapshot().json).toBe(before);
    r.store.redo(); expect(r.store.project.mixer[1]!.volume).toBeCloseTo(1.8);
  });

  it('reaprender el mismo destino empieza un gesto independiente', async () => {
    const r = await rig();
    r.learn(volume); r.move(0.2);
    r.learn(pan); r.learn(volume); r.move(0.9);
    expect(r.store.history).toHaveLength(2);
    r.store.undo(); expect(r.store.project.mixer[1]!.volume).toBeCloseTo(0.4);
  });

  it.each(['remap', 'remove', 'settings'] as const)('%s invalida el mensaje en espera antes del frame', async (change) => {
    const r = await rig();
    r.learn(volume); r.queue(0.9);
    if (change === 'remap') r.learn(pan);
    if (change === 'remove') r.midi.removeMidiMapping('cc:74');
    if (change === 'settings') {
      r.settings.get.mockResolvedValue({ midiMappings: [{ source: 'cc:74', ref: pan }] });
      await r.midi.loadMidiMappings();
    }
    const before = r.snapshot(); r.flush(); expect(r.snapshot()).toEqual(before);
  });

  it.each(['nuevo', 'mismo id'] as const)('un mensaje de A no modifica el reemplazo %s', async (mode) => {
    const r = await rig();
    r.learn(volume); r.queue(0.9);
    r.store.replaceProject(mode === 'nuevo' ? r.core.createEmptyProject('B') : r.store.project);
    const before = r.snapshot(); r.flush(); expect(r.snapshot()).toEqual(before);
    // Los mapeos persisten; solo se descarta el mensaje de la sesión vieja.
    r.move(0.3); expect(r.store.project.mixer[1]!.volume).toBeCloseTo(0.6);
  });

  it('un nuevo mensaje recibido al emitir el primer frame sobrevive hasta el siguiente', async () => {
    const r = await rig();
    const touch = await import('../src/state/param-touch');
    let once = true;
    const off = touch.onParamTouch(() => { if (once) { once = false; r.queue(0.9); } });
    r.learn(volume); r.move(0.2);
    expect(r.store.project.mixer[1]!.volume).toBeCloseTo(0.4);
    r.flush(); expect(r.store.project.mixer[1]!.volume).toBeCloseTo(1.8);
    off();
  });
});
