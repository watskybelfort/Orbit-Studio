import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParamRef } from '@orbit/core';

async function rig() {
  vi.resetModules();
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
  vi.stubGlobal('window', { orbit: { settings: { set: async () => ({}) } } });
  const app = await import('../src/state/app');
  const midi = await import('../src/state/midi-learn');
  const record = await import('../src/state/param-record');
  const touch = await import('../src/state/param-touch');
  const ref: ParamRef = { kind: 'mixer', trackIndex: 1, param: 'volume' };
  const frameAt = (positionBeats: number, playing = true) => app.engine.onMeters?.({
    peaks: new Float32Array(1), rms: new Float32Array(1), masterRms: [0, 0],
    positionBeats, playing, inputPeak: 0, cpu: 0,
  });
  const learn = (source: string, target: ParamRef = ref) => {
    midi.startMidiLearn(target);
    midi.onMidiControl(source, 0);
  };
  const move = (source: string, value: number) => {
    midi.onMidiControl(source, value);
    for (const fn of frames.splice(0)) fn(0);
  };
  return { ...app, midi, record, touch, ref, frameAt, learn, move };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG050: MIDI Learn graba los gestos mediante param-touch', () => {
  it.each(['cc:74', 'bend'])('%s crea una curva con valores posteriores al dispatch y un undo', async (source) => {
    const r = await rig();
    const touches = vi.fn();
    const off = r.touch.onParamTouch(touches);
    r.learn(source);
    expect(touches).not.toHaveBeenCalled();
    r.record.toggleParamRecordArmed();
    r.frameAt(0.5);
    r.move(source, 0.1);
    r.frameAt(1.5);
    r.move(source, 0.8);
    expect(r.store.project.mixer[1]!.volume).toBeCloseTo(1.6);
    r.frameAt(1.5, false);
    const clips = Object.values(r.store.project.clips);
    expect(clips).toHaveLength(1);
    expect(r.touch.useParamTouch.getState().last).toEqual(r.ref);
    expect(touches).toHaveBeenCalledTimes(2);
    expect(clips[0]!.target).toEqual(r.ref);
    expect(clips[0]!.start).toBe(0.5);
    expect(clips[0]!.points).toMatchObject([{ time: 0, value: 0.1 }, { time: 1, value: 0.8 }]);
    r.store.undo();
    expect(Object.values(r.store.project.clips)).toEqual([]);
    expect(r.store.project.mixer[1]!.volume).toBeCloseTo(1.6);
    r.store.redo();
    expect(Object.values(r.store.project.clips)).toEqual(clips);
    off();
  });

  it('sin armar cambia el destino y último parámetro, sin crear automatización', async () => {
    const r = await rig();
    r.learn('cc:74');
    r.frameAt(0.5); r.move('cc:74', 0.1);
    r.frameAt(1.5); r.move('cc:74', 0.8);
    r.frameAt(1.5, false);
    expect(r.store.project.mixer[1]!.volume).toBeCloseTo(1.6);
    expect(r.touch.useParamTouch.getState().last).toEqual(r.ref);
    expect(Object.values(r.store.project.clips)).toEqual([]);
  });

  it('un destino que ya no existe no avisa ni deja un carril fantasma', async () => {
    const r = await rig();
    r.learn('cc:74', { kind: 'channelMix', channelId: 'borrado', param: 'volume' });
    const touches = vi.fn();
    const off = r.touch.onParamTouch(touches);
    r.record.toggleParamRecordArmed();
    r.frameAt(0.5); r.move('cc:74', 0.1);
    r.frameAt(1.5); r.move('cc:74', 0.8);
    r.frameAt(1.5, false);
    expect(touches).not.toHaveBeenCalled();
    expect(Object.values(r.store.project.clips)).toEqual([]);
    off();
  });
});

