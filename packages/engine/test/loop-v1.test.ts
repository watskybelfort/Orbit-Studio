import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

function note(start: number, key = 60): Note {
  return { id: newId(), start, duration: 0.25, key, velocity: 0.9, pan: 0, slide: false };
}

/** Patrón con una nota por beat en `beats` beats (a 120 BPM: 1 beat = 0.5 s). */
function patternOf(beats: number) {
  const p = createEmptyProject('Loop');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('drums', 0, 'Kick');
  ch.mixerTrack = 1;
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, {
    type: 'addNotes',
    patternId,
    channelId: ch.id,
    notes: Array.from({ length: beats }, (_, i) => note(i, 36)),
  });
  return compileProject(p, { mode: 'pattern', patternId });
}

function runSeconds(core: KernelCore, seconds: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  const blocks = Math.round((seconds * 44100) / MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

describe('loop del transporte', () => {
  it('un patrón que crece se reproduce ENTERO, no solo sus primeros 4 beats', () => {
    const core = new KernelCore(44100);
    // Así llega en la vida real: primero un patrón corto…
    core.handleMessage({ type: 'snapshot', project: patternOf(4) });
    // …y luego el usuario alarga el patrón hasta 8 beats.
    const largo = patternOf(8);
    expect(largo.lengthBeats).toBe(8);
    core.handleMessage({ type: 'snapshot', project: largo });
    core.handleMessage({ type: 'play', fromBeat: 0 });

    // 3 s a 120 BPM = 6 beats: con el loop pegado a 4 habría dado la vuelta
    // y estaríamos en el beat 2.
    runSeconds(core, 3);
    expect(core.posBeats).toBeGreaterThan(5.8);
    expect(core.posBeats).toBeLessThan(6.2);
  });

  it('la región de loop que marca el usuario se respeta', () => {
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: patternOf(8) });
    core.handleMessage({ type: 'setLoop', start: 0, end: 2, enabled: true });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    // 3 s = 6 beats sobre una región de 2 beats: hay que estar dentro de ella.
    runSeconds(core, 3);
    expect(core.posBeats).toBeGreaterThanOrEqual(0);
    expect(core.posBeats).toBeLessThan(2.2);
  });

  it('al quitar la región, la reproducción vuelve a cubrir el patrón entero', () => {
    const core = new KernelCore(44100);
    core.handleMessage({ type: 'snapshot', project: patternOf(8) });
    core.handleMessage({ type: 'setLoop', start: 0, end: 2, enabled: true });
    core.handleMessage({ type: 'setLoop', start: 0, end: 0, enabled: false });
    core.handleMessage({ type: 'snapshot', project: patternOf(8) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runSeconds(core, 3);
    expect(core.posBeats).toBeGreaterThan(5.8);
  });
});
