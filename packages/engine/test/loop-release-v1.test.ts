/**
 * El cierre del loop suelta lo que venía sonando.
 *
 * Era el bug de "se corta la primera nota pero las de más adelante suenan": una
 * nota que acaba JUSTO en el final del patrón no encontraba su note-off (el
 * playhead vuelve al principio y `posBeats >= offBeat` deja de cumplirse), así
 * que seguía sonando pase tras pase. Dos síntomas: el sonido se solapa consigo
 * mismo, y al llenarse el pool de 64 voces se roba la más antigua — la primera
 * nota del patrón.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 44100;
/** A 120 BPM y 44.1 kHz, un beat son 172 bloques de 128 samples. */
const BLOCKS_PER_BEAT = 172;

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

function keysOf(core: KernelCore): number[] {
  return [...(core.meterFrame().notes ?? [])].map((v) => v & 0xff).sort((a, b) => a - b);
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

/** Kernel tocando un patrón de 4 beats a 120 BPM con las notas dadas. */
function playing(notes: Note[]): KernelCore {
  const p = createEmptyProject('Loop');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('synth', 0, 'Piano');
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes });
  const core = new KernelCore(SR);
  core.handleMessage({
    type: 'snapshot',
    project: compileProject(p, { mode: 'pattern', patternId }),
  });
  core.handleMessage({ type: 'play', fromBeat: 0 });
  return core;
}

describe('loop: lo del pase anterior se suelta al dar la vuelta', () => {
  it('una nota que acaba en el final del patrón no sigue sonando en la vuelta siguiente', () => {
    const core = playing([note(3, 1, 60)]);

    runBlocks(core, Math.round(3.5 * BLOCKS_PER_BEAT)); // dentro de la nota
    expect(keysOf(core)).toEqual([60]);

    runBlocks(core, Math.round(1.5 * BLOCKS_PER_BEAT)); // beat ~1 de la 2ª vuelta
    expect(keysOf(core)).toEqual([]);
    core.dispose();
  });

  it('cuatro notas seguidas no se acumulan vuelta tras vuelta', () => {
    const core = playing([note(0, 1, 60), note(1, 1, 62), note(2, 1, 64), note(3, 1, 65)]);

    let max = 0;
    for (let i = 0; i < 40; i++) {
      runBlocks(core, Math.round(BLOCKS_PER_BEAT / 4));
      max = Math.max(max, keysOf(core).length);
    }
    expect(max).toBe(1); // nunca dos a la vez: son consecutivas
    core.dispose();
  });

  it('saltar el playhead tampoco deja notas huérfanas sonando', () => {
    const core = playing([note(0, 4, 60)]); // nota larguísima
    runBlocks(core, BLOCKS_PER_BEAT);
    expect(keysOf(core)).toEqual([60]);

    core.handleMessage({ type: 'seek', beat: 3 });
    expect(keysOf(core)).toEqual([]);
    core.dispose();
  });

  it('una audición sostenida sobrevive al cierre del loop', () => {
    const core = playing([note(0, 1, 60)]);
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 72, on: true });

    runBlocks(core, Math.round(5 * BLOCKS_PER_BEAT)); // pasa el cierre del loop
    // La tecla que alguien tiene pulsada no la suelta el loop, solo quien pulsa.
    expect(keysOf(core)).toContain(72);
    core.dispose();
  });
});
