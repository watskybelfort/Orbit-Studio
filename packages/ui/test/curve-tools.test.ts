import { describe, expect, it } from 'vitest';
import {
  EDGE,
  lineBetween,
  quantizeValue,
  replaceRange,
  shapePoints,
  strokeToPoints,
} from '../src/editors/automation/curve-tools';
import type { AutomationPoint } from '@orbit/core';

function pt(id: string, time: number, value: number, tension = 0): AutomationPoint {
  return { id, time, value, tension };
}

/** Réplica de evalCurve del motor, para comprobar lo que se OIRÁ. */
function evalCurve(points: AutomationPoint[], t: number): number {
  const first = points[0]!;
  if (t <= first.time) return first.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const f = a.tension === 0 ? (t - a.time) / span : (t - a.time) / span;
      return a.value + (b.value - a.value) * f;
    }
  }
  return points[points.length - 1]!.value;
}

describe('quantizeValue', () => {
  it('sin divisiones deja el valor tal cual (acotado)', () => {
    expect(quantizeValue(0.37, 0)).toBe(0.37);
    expect(quantizeValue(-2, 0)).toBe(0);
    expect(quantizeValue(9, 0)).toBe(1);
  });

  it('redondea a la división más cercana', () => {
    expect(quantizeValue(0.3, 2)).toBe(0.5);
    expect(quantizeValue(0.2, 4)).toBe(0.25);
    expect(quantizeValue(0.51, 12)).toBeCloseTo(0.5, 6);
  });
});

describe('strokeToPoints', () => {
  it('una rampa a mano se queda en sus dos extremos', () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({ time: i / 10, norm: i / 49 }));
    const out = strokeToPoints(samples, { eps: 0.02 });
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0]!.time).toBe(0);
    expect(out[out.length - 1]!.value).toBeCloseTo(1, 6);
  });

  it('conserva el pico de un trazo en pico', () => {
    const samples = [
      { time: 0, norm: 0 },
      { time: 1, norm: 1 },
      { time: 2, norm: 0 },
    ];
    const out = strokeToPoints(samples, { eps: 0.01 });
    expect(out.map((p) => p.time)).toEqual([0, 1, 2]);
  });

  it('un trazo hacia atrás sale ordenado por tiempo', () => {
    // El del medio NO va en la recta 0→2 a propósito: si fuese colineal, la
    // simplificación lo quitaría (con razón) y el test no probaría el orden.
    const out = strokeToPoints([
      { time: 2, norm: 1 },
      { time: 1, norm: 0.9 },
      { time: 0, norm: 0 },
    ]);
    expect(out.map((p) => p.time)).toEqual([0, 1, 2]);
  });

  it('dos muestras en el mismo instante no dejan un tramo de longitud cero', () => {
    const out = strokeToPoints([
      { time: 0, norm: 0 },
      { time: 1, norm: 0.2 },
      { time: 1, norm: 0.9 },
      { time: 2, norm: 1 },
    ]);
    const times = out.map((p) => p.time);
    expect(new Set(times).size).toBe(times.length);
    // Gana la última muestra de ese instante: es lo que el usuario acaba de decidir.
    const enUno = out.find((p) => p.time === 1);
    if (enUno) expect(enUno.value).toBeCloseTo(0.9, 6);
  });

  it('el snap de valor se aplica al trazo', () => {
    const out = strokeToPoints(
      [
        { time: 0, norm: 0.13 },
        { time: 1, norm: 0.88 },
      ],
      { valueSteps: 4 },
    );
    expect(out.map((p) => p.value)).toEqual([0.25, 1]);
  });

  it('sin muestras no inventa nada', () => {
    expect(strokeToPoints([])).toEqual([]);
  });

  it('los ids son nuevos y distintos', () => {
    const out = strokeToPoints([
      { time: 0, norm: 0 },
      { time: 1, norm: 1 },
    ]);
    expect(new Set(out.map((p) => p.id)).size).toBe(out.length);
  });
});

describe('lineBetween', () => {
  it('deja dos puntos, ordenados aunque se arrastre hacia atrás', () => {
    const out = lineBetween(4, 1, 1, 0.25);
    expect(out.map((p) => p.time)).toEqual([1, 4]);
    expect(out.map((p) => p.value)).toEqual([0.25, 1]);
  });

  it('un arrastre sin recorrido es un solo punto', () => {
    expect(lineBetween(2, 0.5, 2, 0.5)).toHaveLength(1);
  });
});

describe('replaceRange', () => {
  const base = [pt('a', 0, 0), pt('b', 2, 1, 0.5), pt('c', 4, 0), pt('d', 8, 1)];

  it('quita solo lo de dentro y conserva lo de fuera', () => {
    const out = replaceRange(base, 1, 5, [pt('n1', 1, 0.5), pt('n2', 5, 0.5)]);
    expect(out.map((p) => p.id)).toEqual(['a', 'n1', 'n2', 'd']);
  });

  it('el punto anterior pierde la curvatura: la rampa entra por donde se dibujó', () => {
    const curvado = [pt('a', 0, 0, 0.8), pt('b', 4, 1)];
    const out = replaceRange(curvado, 2, 4, [pt('n', 2, 0.3), pt('n2', 4, 0.3)]);
    expect(out[0]!.tension).toBe(0);
  });

  it('no muta la lista original', () => {
    const copia = base.map((p) => ({ ...p }));
    replaceRange(base, 1, 5, [pt('n', 3, 0.5)]);
    expect(base).toEqual(copia);
  });

  it('lo nuevo se acota al tramo pedido', () => {
    const out = replaceRange(base, 2, 3, [pt('n', 99, 0.5)]);
    expect(out.find((p) => p.id === 'n')!.time).toBe(3);
  });

  it('nunca deja el clip sin puntos', () => {
    expect(replaceRange([pt('a', 0, 0)], 0, 10, []).length).toBeGreaterThan(0);
  });

  it('sale ordenado por tiempo', () => {
    const out = replaceRange(base, 1, 5, [pt('n2', 4, 0.2), pt('n1', 2, 0.8)]);
    const times = out.map((p) => p.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('shapePoints', () => {
  it('cubre el tramo entero de punta a punta', () => {
    const out = shapePoints({ shape: 'sine', from: 0, to: 8, cycles: 2, min: 0, max: 1 });
    expect(out[0]!.time).toBeCloseTo(0, 6);
    expect(out[out.length - 1]!.time).toBeCloseTo(8, 6);
  });

  it('respeta el recorrido pedido', () => {
    const out = shapePoints({ shape: 'sine', from: 0, to: 4, cycles: 1, min: 0.25, max: 0.75 });
    for (const p of out) {
      expect(p.value).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(p.value).toBeLessThanOrEqual(0.75 + 1e-9);
    }
  });

  it('el seno arranca en el centro y sube', () => {
    const out = shapePoints({ shape: 'sine', from: 0, to: 4, cycles: 1, min: 0, max: 1 });
    expect(out[0]!.value).toBeCloseTo(0.5, 4);
    expect(out[1]!.value).toBeGreaterThan(out[0]!.value);
  });

  it('el triángulo son tres puntos por ciclo', () => {
    const out = shapePoints({ shape: 'triangle', from: 0, to: 4, cycles: 1, min: 0, max: 1 });
    expect(out.map((p) => p.value)).toEqual([0, 1, 0]);
  });

  it('la sierra lleva su flanco como dos puntos casi pegados', () => {
    const out = shapePoints({ shape: 'sawUp', from: 0, to: 4, cycles: 1, min: 0, max: 1 });
    const alto = out.find((p) => p.value === 1)!;
    const vuelta = out.find((p) => p.time > alto.time)!;
    expect(vuelta.time - alto.time).toBeCloseTo(EDGE, 9);
    expect(vuelta.value).toBe(0);
  });

  it('dos puntos nunca comparten instante (un tramo de cero no se puede evaluar)', () => {
    for (const shape of ['sine', 'triangle', 'sawUp', 'sawDown', 'square', 'random'] as const) {
      const out = shapePoints({ shape, from: 0, to: 8, cycles: 3, min: 0, max: 1, seed: 7 });
      const times = out.map((p) => p.time);
      for (let i = 1; i < times.length; i++) {
        expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(0);
      }
      expect(new Set(times.map((t) => t.toFixed(9))).size).toBe(times.length);
    }
  });

  it('la aleatoria es determinista: misma semilla, misma curva', () => {
    const args = { shape: 'random' as const, from: 0, to: 8, cycles: 4, min: 0, max: 1 };
    expect(shapePoints({ ...args, seed: 42 }).map((p) => p.value)).toEqual(
      shapePoints({ ...args, seed: 42 }).map((p) => p.value),
    );
    expect(shapePoints({ ...args, seed: 42 }).map((p) => p.value)).not.toEqual(
      shapePoints({ ...args, seed: 43 }).map((p) => p.value),
    );
  });

  it('min y max al revés dan la forma invertida, no una vacía', () => {
    const out = shapePoints({ shape: 'triangle', from: 0, to: 4, cycles: 1, min: 1, max: 0 });
    expect(out).toHaveLength(3);
    expect(out[1]!.value).toBe(1);
  });

  it('un tramo de longitud cero no genera nada', () => {
    expect(shapePoints({ shape: 'sine', from: 4, to: 4, cycles: 1, min: 0, max: 1 })).toEqual([]);
  });

  it('la fase desplaza la forma sin dejar el tramo a medio cubrir', () => {
    const out = shapePoints({
      shape: 'square',
      from: 0,
      to: 8,
      cycles: 2,
      min: 0,
      max: 1,
      phase: 0.25,
    });
    expect(out[0]!.time).toBeCloseTo(0, 6);
    expect(out[out.length - 1]!.time).toBeCloseTo(8, 6);
    expect(evalCurve(out, 0)).toBeGreaterThanOrEqual(0);
  });
});
