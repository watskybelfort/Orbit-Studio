import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

function note(pan: number): Note {
  return { id: newId(), start: 0, duration: 2, key: 60, velocity: 0.9, pan, slide: false };
}

/** Una nota sostenida con el pan dado; devuelve el pico L y R de 1 s. */
function peaksWithPan(pan: number, withInsert: boolean): { l: number; r: number } {
  const p = createEmptyProject('Pan');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('synth', 0, 'Synth');
  ch.mixerTrack = 1;
  ch.pan = 0; // el canal al centro: lo que desvíe es el pan de la nota
  applyCommand(p, { type: 'addChannel', channel: ch });
  if (withInsert) {
    // Un insert en el canal fuerza el camino con buffer intermedio (chBuf),
    // distinto del directo: el pan de nota debe funcionar en los dos.
    applyCommand(p, {
      type: 'setChannelEffect',
      channelId: ch.id,
      slotIndex: 0,
      slot: { id: newId(), kind: 'eq', enabled: true, mix: 1, params: {} },
    });
  }
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(pan)] });
  const core = new KernelCore(44100);
  core.handleMessage({ type: 'snapshot', project: compileProject(p, { mode: 'pattern', patternId }) });
  core.handleMessage({ type: 'play', fromBeat: 0 });
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  let pl = 0;
  let pr = 0;
  for (let i = 0; i < Math.round(44100 / MAX_BLOCK); i++) {
    core.process(l, r, MAX_BLOCK);
    for (let s = 0; s < MAX_BLOCK; s++) {
      pl = Math.max(pl, Math.abs(l[s]!));
      pr = Math.max(pr, Math.abs(r[s]!));
    }
  }
  return { l: pl, r: pr };
}

describe('pan por nota (antes se compilaba pero el kernel lo ignoraba)', () => {
  it('una nota a la izquierda suena mucho más por la izquierda', () => {
    const { l, r } = peaksWithPan(-1, false);
    expect(l).toBeGreaterThan(0.01);
    expect(l).toBeGreaterThan(r * 4);
  });

  it('una nota a la derecha suena mucho más por la derecha', () => {
    const { l, r } = peaksWithPan(1, false);
    expect(r).toBeGreaterThan(l * 4);
  });

  it('centrada, L y R quedan igualados', () => {
    const { l, r } = peaksWithPan(0, false);
    expect(Math.abs(l - r)).toBeLessThan(l * 0.05);
  });

  it('también desvía cuando el canal tiene un insert (camino con buffer)', () => {
    const { l, r } = peaksWithPan(-1, true);
    expect(l).toBeGreaterThan(r * 4);
  });
});
