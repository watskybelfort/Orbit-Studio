/**
 * Un `queueSnapshot` en cola NO sobrevive a stop/play.
 *
 * La cola de la vista Live está pensada para entrar al cerrar el loop actual
 * (`applyQueued` en el cierre). Pero si en medio se para y se vuelve a
 * arrancar, ese snapshot es de una reproducción que ya no existe: al llegar al
 * cierre del loop nuevo se aplicaba igual, con lo que el transporte cambiaba
 * de timeline (longitud, loop, tempo) sin que nadie lo hubiera pedido.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import type { CompiledProject } from '../src/protocol';

const SR = 44100;

/** Canción vacía con una longitud de timeline concreta. */
function song(title: string, lengthBeats: number): CompiledProject {
  const p = createEmptyProject(title);
  p.tempo = 120;
  const compiled = compileProject(p, { mode: 'song' });
  compiled.lengthBeats = lengthBeats;
  return compiled;
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

describe('queueSnapshot: la cola se anula con stop', () => {
  it('tras stop/play no se aplica el snapshot encolado al cerrar el loop', () => {
    const a = song('A', 4);
    const b = song('B', 8);
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: a });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    core.handleMessage({ type: 'queueSnapshot', project: b });
    core.handleMessage({ type: 'stop' });
    core.handleMessage({ type: 'play', fromBeat: 0 });

    // 1560 bloques = 199 680 muestras ≈ 9.06 beats a 120 BPM. Con A (loop de 4)
    // el playhead envolvió en el 4 y en el 8: está en ~1.06. Con B aplicado
    // (loop de 8) solo envolvió en el 4: estaría en ~5.06.
    runBlocks(core, 1560);
    expect(core.playing).toBe(true);
    expect(core.posBeats).toBeLessThan(4);
    core.dispose();
  });

  it('sin stop, el snapshot encolado sí entra al cerrar el loop (control)', () => {
    const a = song('A', 4);
    const b = song('B', 8);
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: a });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    core.handleMessage({ type: 'queueSnapshot', project: b });
    runBlocks(core, 1560);
    // El loop nuevo es de 8 beats: tras la vuelta en el 4 ya no envolvió más.
    expect(core.posBeats).toBeGreaterThan(4);
    core.dispose();
  });
});
