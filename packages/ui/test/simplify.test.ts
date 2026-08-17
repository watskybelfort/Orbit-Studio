import { describe, expect, it } from 'vitest';
import { simplifyCurve, type CurveSample } from '../src/state/simplify';

/** Rampa recta muestreada muy fino, como un fader arrastrado despacio. */
function ramp(n: number, from = 0, to = 1): CurveSample[] {
  return Array.from({ length: n }, (_, i) => ({
    time: (i / (n - 1)) * 4,
    norm: from + ((to - from) * i) / (n - 1),
  }));
}

/** Error máximo de la curva simplificada contra la original. */
function maxError(original: CurveSample[], kept: CurveSample[]): number {
  let worst = 0;
  for (const p of original) {
    // Valor de la poligonal simplificada en ese tiempo.
    let value = kept[kept.length - 1]!.norm;
    for (let i = 0; i < kept.length - 1; i++) {
      const a = kept[i]!;
      const b = kept[i + 1]!;
      if (p.time <= b.time) {
        const span = b.time - a.time;
        const t = span <= 0 ? 0 : (p.time - a.time) / span;
        value = a.norm + (b.norm - a.norm) * t;
        break;
      }
    }
    worst = Math.max(worst, Math.abs(value - p.norm));
  }
  return worst;
}

describe('simplifyCurve: puntos de una perilla grabada', () => {
  it('una rampa recta se queda en sus dos extremos', () => {
    expect(simplifyCurve(ramp(400), 0.006)).toHaveLength(2);
  });

  it('conserva los extremos y el codo de una curva en pico', () => {
    const up = ramp(100, 0, 1);
    const down = ramp(100, 1, 0).map((p) => ({ time: p.time + 4, norm: p.norm }));
    const kept = simplifyCurve([...up, ...down], 0.006);
    expect(kept.length).toBeGreaterThanOrEqual(3);
    expect(kept[0]!.norm).toBeCloseTo(0, 6);
    expect(kept[kept.length - 1]!.norm).toBeCloseTo(0, 6);
    // El vértice (valor 1) sigue ahí.
    expect(Math.max(...kept.map((p) => p.norm))).toBeCloseTo(1, 6);
  });

  it('un barrido a mano baja de cientos de puntos a decenas sin pasarse de error', () => {
    const jitter = (i: number) => Math.sin(i * 12.9898) * 0.5 + 0.5; // ruido reproducible
    const sweep: CurveSample[] = Array.from({ length: 600 }, (_, i) => ({
      time: (i / 599) * 8,
      norm: Math.min(1, Math.max(0, 0.5 + 0.45 * Math.sin(i / 40) + 0.002 * jitter(i))),
    }));
    const kept = simplifyCurve(sweep, 0.006);
    expect(kept.length).toBeLessThan(80);
    expect(kept.length).toBeGreaterThan(4);
    expect(maxError(sweep, kept)).toBeLessThanOrEqual(0.006 + 1e-9);
  });

  it('con dos puntos o menos devuelve lo mismo', () => {
    expect(simplifyCurve([], 0.01)).toEqual([]);
    const two = ramp(2);
    expect(simplifyCurve(two, 0.01)).toEqual(two);
  });
});
