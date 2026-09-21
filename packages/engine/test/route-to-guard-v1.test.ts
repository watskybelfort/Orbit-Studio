/**
 * Guarda de `routeTo` fuera de rango.
 *
 * El bucle del mixer indexaba `this.bufL[track.routeTo]` sin comprobar que la
 * pista destino exista: `mixer[1].routeTo = 999` + `process()` reventaba con
 * "Cannot read properties of undefined". Los sends sí tenían esa guarda; el
 * enrutado no. Un proyecto con un `routeTo` corrupto (o de un archivo viejo
 * con menos pistas) no puede llevarse el hilo de audio por delante.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import type { CompiledProject } from '../src/protocol';

const SR = 44100;

function note(): Note {
  return { id: newId(), start: 0, duration: 1, key: 60, velocity: 0.9, pan: 0, slide: false };
}

function projectWithNotes(): CompiledProject {
  const p = createEmptyProject('RouteTo');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('synth', 0, 'Synth');
  ch.mixerTrack = 1;
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note()] });
  return compileProject(p, { mode: 'pattern', patternId });
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

describe('mixer: routeTo fuera de rango', () => {
  it('no revienta process() con la pista destino inexistente', () => {
    const compiled = projectWithNotes();
    compiled.mixer[1]!.routeTo = 999;
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: compiled });
    core.handleMessage({ type: 'setLoop', start: 0, end: 8, enabled: true });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    expect(() => runBlocks(core, 16)).not.toThrow();
    core.dispose();
  });

  it('un routeTo negativo tampoco revienta', () => {
    const compiled = projectWithNotes();
    compiled.mixer[1]!.routeTo = -3;
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: compiled });
    core.handleMessage({ type: 'setLoop', start: 0, end: 8, enabled: true });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    expect(() => runBlocks(core, 16)).not.toThrow();
    core.dispose();
  });
});
