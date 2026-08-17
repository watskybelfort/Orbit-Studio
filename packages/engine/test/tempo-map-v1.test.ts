import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, newId } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

/** Proyecto con marcadores que cambian tempo y/o compás. */
function withMarkers(marks: { time: number; tempo?: number; timeSigNum?: number }[]) {
  const p = createEmptyProject('Mapas');
  p.tempo = 120;
  p.timeSig = { num: 4, den: 4 };
  for (const m of marks) {
    applyCommand(p, {
      type: 'addMarker',
      marker: {
        id: newId(),
        time: m.time,
        name: `M${m.time}`,
        color: '#fff',
        ...(m.tempo !== undefined ? { tempo: m.tempo } : null),
        ...(m.timeSigNum !== undefined ? { timeSigNum: m.timeSigNum } : null),
      },
    });
  }
  return compileProject(p, { mode: 'song' });
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

describe('mapas de tempo y compás por marcador', () => {
  it('el compilador arranca con el valor del proyecto y añade un tramo por marcador', () => {
    const c = withMarkers([
      { time: 8, tempo: 90 },
      { time: 16, tempo: 140, timeSigNum: 3 },
    ]);
    expect(c.tempoMap).toEqual([
      { beat: 0, tempo: 120 },
      { beat: 8, tempo: 90 },
      { beat: 16, tempo: 140 },
    ]);
    expect(c.meterMap).toEqual([
      { beat: 0, num: 4 },
      { beat: 16, num: 3 },
    ]);
  });

  it('un marcador en el beat 0 redefine el valor inicial', () => {
    const c = withMarkers([{ time: 0, tempo: 75, timeSigNum: 6 }]);
    expect(c.tempoMap).toEqual([{ beat: 0, tempo: 75 }]);
    expect(c.meterMap).toEqual([{ beat: 0, num: 6 }]);
    expect(c.tempo).toBe(75);
    expect(c.timeSigNum).toBe(6);
  });

  it('sin marcadores de tempo hay un solo tramo (comportamiento de siempre)', () => {
    const c = withMarkers([{ time: 4 }]);
    expect(c.tempoMap).toHaveLength(1);
    expect(c.meterMap).toHaveLength(1);
  });

  it('el transporte cambia de velocidad al cruzar el marcador', () => {
    // 120 BPM hasta el beat 4 (2 s) y 60 BPM a partir de ahí (1 beat/s).
    const compiled = withMarkers([{ time: 4, tempo: 60 }]);
    compiled.lengthBeats = 64; // que no pare a mitad del test
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: compiled });
    core.handleMessage({ type: 'setLoop', start: 0, end: 64, enabled: false });
    core.handleMessage({ type: 'play', fromBeat: 0 });

    // 2 s exactos: debería estar justo en el beat 4.
    runBlocks(core, Math.round((2 * 44100) / MAX_BLOCK));
    expect(core.posBeats).toBeGreaterThan(3.9);
    expect(core.posBeats).toBeLessThan(4.1);

    // Otro segundo a 60 BPM = un beat más (a 120 serían dos).
    runBlocks(core, Math.round(44100 / MAX_BLOCK));
    expect(core.posBeats).toBeGreaterThan(4.9);
    expect(core.posBeats).toBeLessThan(5.15);
  });

  it('un seek hacia atrás recupera el tempo del tramo anterior', () => {
    const compiled = withMarkers([{ time: 4, tempo: 60 }]);
    compiled.lengthBeats = 64;
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: compiled });
    core.handleMessage({ type: 'setLoop', start: 0, end: 64, enabled: false });
    core.handleMessage({ type: 'play', fromBeat: 8 });
    runBlocks(core, 20);
    const slow = core.posBeats;
    core.handleMessage({ type: 'seek', beat: 0 });
    runBlocks(core, Math.round(44100 / MAX_BLOCK)); // 1 s a 120 BPM = 2 beats
    expect(core.posBeats).toBeGreaterThan(1.9);
    expect(core.posBeats).toBeLessThan(2.15);
    expect(slow).toBeGreaterThan(8);
  });
});
