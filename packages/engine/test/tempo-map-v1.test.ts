import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, newId } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import { renderProject } from '../src/render/offline';
import type { CompiledAudioClip } from '../src/protocol';

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

  it('un clip de audio no salta de posición al cruzar un marcador de tempo', () => {
    // 120 BPM hasta el beat 4, luego 60. Un clip de audio debe sonar a su
    // velocidad natural sin que la lectura del sample dé un salto en el marcador.
    const compiled = withMarkers([{ time: 4, tempo: 60 }]);
    compiled.lengthBeats = 8;
    // Master neutro: la salida es exactamente el índice leído del sample.
    const m = compiled.mixer[0]!;
    m.volume = 1;
    m.pan = 0;
    m.stereoWidth = 1;
    m.eqLow = 0;
    m.eqMid = 0;
    m.eqHigh = 0;
    m.slots = [];
    const rate = 44100;
    // Sample RAMPA (left[i] = i): la salida revela la posición de lectura. 8 s
    // sobran para los ~6 s reales (4 beats@120 + 4 beats@60).
    const ramp = new Float32Array(rate * 8);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i;
    const clip: CompiledAudioClip = {
      start: 0,
      length: 8,
      sampleId: 'ramp',
      offset: 0,
      gain: 1,
      mixerTrack: 0,
      stretch: false,
      pitch: 0,
    };
    compiled.audioClips = [clip];

    const res = renderProject(compiled, {
      sampleRate: rate,
      tailSeconds: 0,
      samples: new Map([['ramp', { left: ramp, right: ramp, rate }]]),
    });

    // La posición de lectura avanza ~1 muestra por muestra. Con el bug, al cruzar
    // el beat 4 saltaba ~2 s (≈88200 muestras) de golpe. Queda como mucho la
    // cuantización de un bloque (~128) en el borde del marcador.
    let maxJump = 0;
    let prev = res.left[0]!;
    for (let i = 1; i < res.left.length; i++) {
      const v = res.left[i]!;
      if (v > 0 && prev > 0) maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
    }
    expect(maxJump).toBeLessThan(1000);
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
