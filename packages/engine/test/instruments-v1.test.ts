import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';
import type { SampleData } from '../src/dsp/voices';

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

/** Proyecto de un canal del kind pedido tocando las notas dadas. */
function oneChannel(kind: 'vox' | 'slicer', keys: number[], params: Record<string, number> = {}) {
  const p = createEmptyProject('Instr');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel(kind, 0, kind);
  ch.mixerTrack = 1;
  Object.assign(ch.params, params);
  if (kind === 'slicer') ch.sampleId = 'loop';
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, {
    type: 'addNotes',
    patternId,
    channelId: ch.id,
    notes: keys.map((k, i) => note(i * 0.5, 0.45, k)),
  });
  return compileProject(p, { mode: 'pattern', patternId });
}

/** Loop de prueba: cuatro trozos con amplitud creciente (1 → 4). */
function loopSample(): Map<string, SampleData> {
  const sr = 44100;
  const n = sr; // 1 s
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const slice = Math.floor((i / n) * 4);
    left[i] = Math.sin((2 * Math.PI * 220 * i) / sr) * (0.15 + slice * 0.2);
  }
  return new Map([['loop', { left, right: left.slice(), rate: sr }]]);
}

function rms(xs: Float32Array, from: number, to: number): number {
  let s = 0;
  const hi = Math.min(to, xs.length);
  for (let i = Math.max(0, from); i < hi; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, hi - Math.max(0, from)));
}

describe('Orbit Vox', () => {
  it('canta: hay señal, sin NaN y sin clipping', () => {
    const res = renderProject(oneChannel('vox', [60, 64, 67]), { tailSeconds: 0.2 });
    let peak = 0;
    for (const s of res.left) {
      expect(Number.isNaN(s)).toBe(false);
      peak = Math.max(peak, Math.abs(s));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('cada vocal suena distinta (los formantes cambian el timbre)', () => {
    const energy = (vowel: number) => {
      const res = renderProject(oneChannel('vox', [60], { vowel }), { tailSeconds: 0 });
      let sum = 0;
      // Diferencia de primer orden: pesa los agudos, donde viven los formantes.
      for (let i = 1; i < res.left.length; i++) {
        const d = res.left[i]! - res.left[i - 1]!;
        sum += d * d;
      }
      return sum;
    };
    const a = energy(0);
    const i = energy(2);
    expect(Math.abs(a - i) / Math.max(a, i)).toBeGreaterThan(0.05);
  });

  it('es determinista', () => {
    const a = renderProject(oneChannel('vox', [60]), { tailSeconds: 0 });
    const b = renderProject(oneChannel('vox', [60]), { tailSeconds: 0 });
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
  });
});

describe('Orbit Slicer', () => {
  it('cada tecla dispara su trozo del loop', () => {
    const samples = loopSample();
    // C3 (36) = primer trozo (flojo), 39 = cuarto trozo (fuerte).
    const primero = renderProject(oneChannel('slicer', [36], { slices: 4, release: 0.01 }), {
      samples,
      tailSeconds: 0,
    });
    const ultimo = renderProject(oneChannel('slicer', [39], { slices: 4, release: 0.01 }), {
      samples,
      tailSeconds: 0,
    });
    const sr = primero.sampleRate;
    expect(rms(ultimo.left, 0, Math.round(0.2 * sr))).toBeGreaterThan(
      rms(primero.left, 0, Math.round(0.2 * sr)) * 1.5,
    );
  });

  it('sin sample no suena ni revienta', () => {
    const p = createEmptyProject('Sin sample');
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('slicer', 0, 'Slicer');
    ch.mixerTrack = 1;
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(0, 1, 36)] });
    const res = renderProject(compileProject(p, { mode: 'pattern', patternId }), {
      tailSeconds: 0,
    });
    expect(rms(res.left, 0, res.left.length)).toBe(0);
  });
});
