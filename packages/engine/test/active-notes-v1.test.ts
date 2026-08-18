/**
 * El kernel dice qué teclas suenan (MeterFrame.notes).
 *
 * Es el dato que ilumina los teclados de la UI, así que lo que importa es que
 * salga del MISMO sitio que el sonido: una audición encendida aparece, una
 * soltada desaparece aunque siga sonando la cola, y las notas del secuenciador
 * aparecen y se apagan solas cuando el patrón las suelta.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 44100;

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

/** Proyecto de un canal con las notas dadas (patrón de 4 beats a 120 BPM). */
function project(notes: Note[]) {
  const p = createEmptyProject('Notas');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('synth', 0, 'Lead');
  applyCommand(p, { type: 'addChannel', channel: ch });
  if (notes.length > 0) {
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes });
  }
  return compileProject(p, { mode: 'pattern', patternId });
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

/** Teclas del canal 0 que reporta el frame. */
function keysOf(core: KernelCore): number[] {
  const notes = core.meterFrame().notes;
  return [...(notes ?? [])].filter((v) => v >> 8 === 0).map((v) => v & 0xff).sort((a, b) => a - b);
}

describe('kernel: notas que suenan en el meter frame', () => {
  it('sin nada sonando no emite el campo (no aloca por frame)', () => {
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: project([]) });
    runBlocks(core, 4);
    expect(core.meterFrame().notes).toBeUndefined();
    core.dispose();
  });

  it('una audición aparece mientras está pulsada y desaparece al soltarla', () => {
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: project([]) });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 64, on: true });
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 67, on: true });
    runBlocks(core, 4);
    expect(keysOf(core)).toEqual([64, 67]);

    // Soltar apaga la tecla YA, aunque la voz siga sonando su release.
    core.handleMessage({ type: 'previewNote', channelIndex: 0, key: 64, on: false });
    expect(keysOf(core)).toEqual([67]);
    core.dispose();
  });

  it('las notas del secuenciador se encienden y se apagan solas', () => {
    // 1 beat = 0.5 s a 120 BPM = ~172 bloques de 128 a 44.1 kHz.
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: project([note(0, 1, 60), note(2, 1, 72)]) });
    core.handleMessage({ type: 'play', fromBeat: 0 });

    runBlocks(core, 40); // dentro de la primera nota
    expect(keysOf(core)).toEqual([60]);

    runBlocks(core, 300); // pasado su final, antes de la segunda
    expect(keysOf(core)).toEqual([]);

    runBlocks(core, 90); // dentro de la segunda (beat ~2.5; el patrón dura 4)
    expect(keysOf(core)).toEqual([72]);
    core.dispose();
  });

  it('el canal viaja en el paquete: mismas teclas en canales distintos no se mezclan', () => {
    const p = createEmptyProject('Dos canales');
    p.tempo = 120;
    applyCommand(p, { type: 'addChannel', channel: createChannel('synth', 0, 'A') });
    applyCommand(p, { type: 'addChannel', channel: createChannel('synth', 1, 'B') });
    const core = new KernelCore(SR);
    core.handleMessage({
      type: 'snapshot',
      project: compileProject(p, { mode: 'pattern', patternId: p.patternOrder[0]! }),
    });
    core.handleMessage({ type: 'previewNote', channelIndex: 1, key: 60, on: true });
    runBlocks(core, 4);

    const packed = [...(core.meterFrame().notes ?? [])];
    expect(packed).toEqual([(1 << 8) | 60]);
    core.dispose();
  });
});
