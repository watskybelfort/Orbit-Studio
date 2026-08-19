/**
 * Fundidos de clip: la rampa que dibuja la playlist tiene que ser la que suena.
 *
 * El sample es corriente continua a 1, así que la salida ES la ganancia: si el
 * fundido está bien, el canal izquierdo dibuja la misma recta que el clip.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, type Clip } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 44100;
/** A 120 BPM un beat es medio segundo. */
const SAMPLES_PER_BEAT = SR / 2;
const SAMPLE_SECONDS = 10;

/** Proyecto con UN clip de audio de 4 beats en el master, con los fundidos dados. */
function project(fadeIn?: number, fadeOut?: number) {
  const p = createEmptyProject('Fades');
  p.tempo = 120;
  const trackId = Object.values(p.playlistTracks).find(
    (t) => t.arrangementId === p.activeArrangementId,
  )!.id;
  applyCommand(p, {
    type: 'registerSample',
    sample: { id: 'dc', name: 'dc', path: 'qa:dc', hash: 'x', duration: SAMPLE_SECONDS },
  });
  const clip: Clip = {
    id: 'c1',
    kind: 'audio',
    playlistTrackId: trackId,
    start: 0,
    length: 4,
    muted: false,
    sampleId: 'dc',
    ...(fadeIn === undefined ? {} : { fadeIn }),
    ...(fadeOut === undefined ? {} : { fadeOut }),
  };
  applyCommand(p, { type: 'addClips', clips: [clip] });
  return compileProject(p, { mode: 'song' });
}

/** Corre los 4 beats del clip y devuelve el canal izquierdo. */
function render(fadeIn?: number, fadeOut?: number): Float32Array {
  const core = new KernelCore(SR);
  const dc = new Float32Array(SR * SAMPLE_SECONDS).fill(1);
  core.handleMessage({
    type: 'loadSample',
    sampleId: 'dc',
    left: dc,
    right: dc.slice(),
    sampleRate: SR,
  });
  core.handleMessage({ type: 'snapshot', project: project(fadeIn, fadeOut) });
  // Sin loop: interesa el clip de principio a fin, no la vuelta.
  core.handleMessage({ type: 'setLoop', start: 0, end: 4, enabled: false });
  core.handleMessage({ type: 'play', fromBeat: 0 });

  const total = 4 * SAMPLES_PER_BEAT;
  const blocks = Math.floor(total / MAX_BLOCK);
  const out = new Float32Array(blocks * MAX_BLOCK);
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < blocks; b++) {
    core.process(l, r, MAX_BLOCK);
    out.set(l, b * MAX_BLOCK);
  }
  core.dispose();
  return out;
}

/** Nivel medio alrededor de un beat (evita mirar una muestra suelta). */
function levelAtBeat(out: Float32Array, beat: number): number {
  const at = Math.round(beat * SAMPLES_PER_BEAT);
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, at - 200); i < Math.min(out.length, at + 200); i++) {
    sum += out[i]!;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

describe('fundidos de un clip de audio', () => {
  it('sin fundidos el clip suena plano de principio a fin', () => {
    const out = render();
    expect(levelAtBeat(out, 0.05)).toBeCloseTo(1, 2);
    expect(levelAtBeat(out, 2)).toBeCloseTo(1, 2);
    expect(levelAtBeat(out, 3.9)).toBeCloseTo(1, 2);
  });

  it('el fundido de entrada sube de 0 a 1 en su tramo', () => {
    const out = render(2);
    expect(out[0]!).toBeCloseTo(0, 3);
    expect(levelAtBeat(out, 0.5)).toBeCloseTo(0.25, 2);
    expect(levelAtBeat(out, 1)).toBeCloseTo(0.5, 2);
    expect(levelAtBeat(out, 2)).toBeCloseTo(1, 2);
    expect(levelAtBeat(out, 3)).toBeCloseTo(1, 2);
  });

  it('el fundido de salida baja hasta el final del clip', () => {
    const out = render(undefined, 2);
    expect(levelAtBeat(out, 0.5)).toBeCloseTo(1, 2);
    expect(levelAtBeat(out, 2)).toBeCloseTo(1, 2);
    expect(levelAtBeat(out, 3)).toBeCloseTo(0.5, 2);
    expect(levelAtBeat(out, 3.9)).toBeCloseTo(0.05, 1);
  });

  it('dos fundidos a tope reparten el clip y no pasan de 1', () => {
    // 4 + 4 en un clip de 4: el compilador los reparte a 2 y 2.
    const out = render(4, 4);
    let peak = 0;
    for (const v of out) if (v > peak) peak = v;
    expect(peak).toBeLessThanOrEqual(1.001);
    expect(levelAtBeat(out, 2)).toBeCloseTo(1, 1);
    expect(levelAtBeat(out, 0.2)).toBeLessThan(0.2);
    expect(levelAtBeat(out, 3.8)).toBeLessThan(0.2);
  });
});
