import { describe, expect, it } from 'vitest';
import { applyCommand, beatsInBar, createEmptyProject, decodeMidi, encodeMidi, meterBeatUnit } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 8000;

function fixture(num: number, den: number) {
  const project = createEmptyProject();
  applyCommand(project, { type: 'setTempo', tempo: 120 });
  applyCommand(project, { type: 'setTimeSig', timeSig: { num, den } });
  applyCommand(project, { type: 'patchPattern', patternId: project.patternOrder[0]!, patch: { length: 16 } });
  const compiled = compileProject(project, { mode: 'pattern', patternId: project.patternOrder[0]! });
  const kernel = new KernelCore(SR);
  kernel.handleMessage({ type: 'snapshot', project: compiled });
  kernel.handleMessage({ type: 'setLoop', enabled: false, start: 0, end: 16 });
  return { project, compiled, kernel };
}

describe('BUG047: el denominador llega al metrónomo y la cuenta previa', () => {
  it.each([[6, 8], [6, 4], [3, 8]])('%i/%i acentúa el comienzo real de cada compás y coincide con MIDI', (num, den) => {
    const { project, compiled, kernel } = fixture(num, den);
    expect(decodeMidi(encodeMidi(project, { mode: 'pattern', patternId: project.patternOrder[0]! })).timeSig).toEqual({ num, den });
    const clicks: { sample: number; frequency: number }[] = [];
    let sample = 0;
    let frequency = 1760;
    Object.defineProperty(kernel, 'clickFreq', {
      get: () => frequency,
      set: (value: number) => { frequency = value; clicks.push({ sample, frequency }); },
    });
    kernel.handleMessage({ type: 'setMetronome', enabled: true });
    kernel.handleMessage({ type: 'play', fromBeat: 0 });
    const barSamples = beatsInBar(project.timeSig) * SR / 2;
    const left = new Float32Array(1); const right = new Float32Array(1);
    let peak = 0;
    for (; sample <= barSamples * 2; sample++) {
      kernel.process(left, right, 1);
      peak = Math.max(peak, Math.abs(left[0]!));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(clicks.filter((c) => c.frequency === 1760).map((c) => c.sample)).toEqual([0, barSamples, barSamples * 2]);
    expect(clicks[1]!.sample).toBe(meterBeatUnit(project.timeSig) * SR / 2);
    expect(compiled.timeSigDen ?? 4).toBe(den);
  });

  it.each([[6, 8, 1.5], [6, 4, 3], [3, 8, 0.75]])('%i/%i cuenta un compás en %fs antes de empezar', (num, den, seconds) => {
    const { project, kernel } = fixture(num, den);
    const beats = beatsInBar(project.timeSig);
    kernel.handleMessage({ type: 'countIn', beats, beatsPerBar: beats, beatUnit: meterBeatUnit(project.timeSig), playFrom: 0 });
    expect(kernel.countInBeatsLeft).toBe(num);
    const left = new Float32Array(MAX_BLOCK); const right = new Float32Array(MAX_BLOCK);
    let elapsed = 0;
    let peak = 0;
    while (!kernel.playing && elapsed < SR * 5) {
      kernel.process(left, right, MAX_BLOCK);
      elapsed += MAX_BLOCK;
      for (const x of left) peak = Math.max(peak, Math.abs(x));
    }
    expect(kernel.playing).toBe(true);
    expect(Math.abs(elapsed - seconds * SR)).toBeLessThanOrEqual(MAX_BLOCK);
    expect(peak).toBeGreaterThan(0.1);
  });
});
