/**
 * Cuenta atrás con el transporte PARADO.
 *
 * El metrónomo del kernel solo suena rodando, así que grabar desde el compás 1
 * —donde no hay sitio por delante para el pre-roll— enseñaba el conteo en
 * pantalla sin que sonara nada. Aquí se comprueba lo que arregla eso: que los
 * clics salen por la salida con el transporte quieto, que caen al tempo, que el
 * 1 de cada compás va acentuado, y que el transporte entra solo un beat después
 * del último clic y en el beat que se pidió.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';

const SR = 48000;

/** Corre bloques recogiendo la salida entera (mono L). */
function collect(core: KernelCore, blocks: number): Float32Array {
  const out = new Float32Array(blocks * MAX_BLOCK);
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let b = 0; b < blocks; b++) {
    core.process(l, r, MAX_BLOCK);
    out.set(l, b * MAX_BLOCK);
  }
  return out;
}

/** Muestra donde arranca cada clic (flanco de subida sobre el silencio). */
function clickStarts(xs: Float32Array, threshold = 0.05): number[] {
  const starts: number[] = [];
  let quietFor = 1e9;
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i]!) > threshold) {
      if (quietFor > 200) starts.push(i);
      quietFor = 0;
    } else {
      quietFor++;
    }
  }
  return starts;
}

/** Pico absoluto en una ventana. */
function peak(xs: Float32Array, from: number, len: number): number {
  let m = 0;
  const end = Math.min(xs.length, from + len);
  for (let i = from; i < end; i++) m = Math.max(m, Math.abs(xs[i]!));
  return m;
}

function kernelAt(tempo: number): KernelCore {
  const core = new KernelCore(SR);
  const project = createEmptyProject();
  project.tempo = tempo;
  core.handleMessage({ type: 'snapshot', project: compileProject(project, { mode: 'song' }) });
  return core;
}

describe('cuenta atrás con el transporte parado', () => {
  it('suena con el transporte quieto y a un clic por beat', () => {
    const core = kernelAt(120); // 0,5 s por beat = 24 000 samples
    core.handleMessage({ type: 'countIn', beats: 4, beatsPerBar: 4 });
    expect(core.playing).toBe(false);

    const out = collect(core, 900); // ~2,4 s
    const starts = clickStarts(out);
    expect(starts).toHaveLength(4);
    // Primer clic al abrir; los demás cada 24 000 samples (±1 bloque).
    expect(starts[0]!).toBeLessThan(MAX_BLOCK);
    for (let i = 1; i < starts.length; i++) {
      expect(Math.abs(starts[i]! - starts[i - 1]! - 24_000)).toBeLessThanOrEqual(MAX_BLOCK);
    }
  });

  it('el 1 del compás va más agudo que los demás', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'countIn', beats: 4, beatsPerBar: 4 });
    const out = collect(core, 900);
    const starts = clickStarts(out);
    // Cruces por cero de los primeros 10 ms de cada clic: el 1 va a 1760 Hz.
    const freq = (from: number): number => {
      let crossings = 0;
      const end = from + Math.round(0.01 * SR);
      for (let i = from + 1; i < end; i++) if (out[i - 1]! <= 0 && out[i]! > 0) crossings++;
      return crossings / 0.01;
    };
    expect(freq(starts[0]!)).toBeGreaterThan(freq(starts[1]!) * 1.2);
  });

  it('el transporte entra solo un beat después del último clic, en su beat', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'countIn', beats: 4, beatsPerBar: 4, playFrom: 2 });
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);

    // 4 beats = 2 s = 96 000 samples = 750 bloques. Antes de eso, quieto.
    for (let b = 0; b < 740; b++) core.process(l, r, MAX_BLOCK);
    expect(core.playing).toBe(false);

    for (let b = 0; b < 20; b++) core.process(l, r, MAX_BLOCK);
    expect(core.playing).toBe(true);
    // Arrancó en el beat pedido (y ya avanzó un pelo desde entonces).
    expect(core.posBeats).toBeGreaterThanOrEqual(2);
    expect(core.posBeats).toBeLessThan(2.1);

  });

  it('sin playFrom cuenta y se queda parada', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'countIn', beats: 2, beatsPerBar: 4 });
    collect(core, 600);
    expect(core.playing).toBe(false);
  });

  it('cancelar corta los clics que faltan y el arranque', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'countIn', beats: 4, beatsPerBar: 4, playFrom: 4 });
    collect(core, 100); // dentro del primer beat (y lejos de la cola del clic)

    core.handleMessage({ type: 'cancelCountIn' });
    const rest = collect(core, 800);
    expect(clickStarts(rest)).toHaveLength(0);
    expect(core.playing).toBe(false);
  });

  it('un play a mano se lleva por delante la cuenta en marcha', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'countIn', beats: 4, beatsPerBar: 4, playFrom: 8 });
    collect(core, 100);
    core.handleMessage({ type: 'play', fromBeat: 0 });
    collect(core, 900);
    // No dio el salto al beat 8 de la cuenta: sigue donde lo puso el play.
    expect(core.posBeats).toBeLessThan(6);
  });

  it('el frame de medidores dice cuántos beats faltan', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'countIn', beats: 4, beatsPerBar: 4, playFrom: 0 });
    collect(core, 10);
    expect(core.meterFrame().countInBeatsLeft).toBe(4);
    collect(core, 400); // pasado el tercer clic (2,2 beats)
    expect(core.meterFrame().countInBeatsLeft).toBe(2);

    collect(core, 800);
    expect(core.meterFrame().countInBeatsLeft).toBeUndefined();
  });

  it('el clic sale aunque el master esté mudo (no pasa por la mesa)', () => {
    const core = kernelAt(120);
    core.handleMessage({ type: 'mixerParam', trackIndex: 0, key: 'volume', value: 0 });
    core.handleMessage({ type: 'countIn', beats: 2, beatsPerBar: 4 });
    const out = collect(core, 40);
    expect(peak(out, 0, out.length)).toBeGreaterThan(0.1);
  });
});
