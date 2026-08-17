import { describe, expect, it } from 'vitest';
import { detectTransients, evenSlices } from '../src/render/transients';

const SR = 44100;

/** Golpes de ruido con caída rápida en las posiciones dadas (segundos). */
function hits(times: number[], seconds: number): Float32Array {
  const xs = new Float32Array(Math.round(seconds * SR));
  let seed = 12345;
  const rnd = () => {
    // Ruido reproducible: el test no puede depender de Math.random.
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  for (const t of times) {
    const from = Math.round(t * SR);
    const len = Math.round(0.08 * SR);
    for (let i = 0; i < len && from + i < xs.length; i++) {
      xs[from + i]! += rnd() * Math.exp(-i / (0.012 * SR)) * 0.9;
    }
  }
  return xs;
}

describe('detectTransients', () => {
  it('encuentra los golpes de un patrón de negras a 120 BPM', () => {
    const times = [0.05, 0.55, 1.05, 1.55, 2.05];
    const xs = hits(times, 2.6);
    const found = detectTransients(xs, xs, SR, { sensitivity: 0.5 });
    expect(found.times.length).toBeGreaterThanOrEqual(times.length);
    // Cada golpe real tiene un corte a menos de 20 ms.
    for (const t of times) {
      const nearest = found.times.reduce(
        (best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best),
        Infinity,
      );
      expect(Math.abs(nearest - t)).toBeLessThan(0.02);
    }
  });

  it('el silencio no genera cortes', () => {
    const xs = new Float32Array(SR);
    expect(detectTransients(xs, xs, SR).times).toHaveLength(0);
  });

  it('respeta la separación mínima y el tope de cortes', () => {
    const xs = hits([0.05, 0.08, 0.5, 0.9, 1.4], 1.8);
    const juntos = detectTransients(xs, xs, SR, { minSpacingSec: 0.2 });
    for (let i = 1; i < juntos.times.length; i++) {
      expect(juntos.times[i]! - juntos.times[i - 1]!).toBeGreaterThanOrEqual(0.2 - 1e-6);
    }
    const topados = detectTransients(xs, xs, SR, { maxCount: 2 });
    expect(topados.times.length).toBeLessThanOrEqual(2);
  });

  it('es determinista y las fuerzas quedan normalizadas', () => {
    const xs = hits([0.1, 0.6, 1.1], 1.5);
    const a = detectTransients(xs, xs, SR);
    const b = detectTransients(xs, xs, SR);
    expect(a.times).toEqual(b.times);
    for (const s of a.strengths) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...a.strengths)).toBeCloseTo(1, 6);
  });

  it('evenSlices reparte los cortes por igual', () => {
    expect(evenSlices(4, 4)).toEqual([1, 2, 3]);
    expect(evenSlices(2, 1)).toEqual([]);
  });
});
