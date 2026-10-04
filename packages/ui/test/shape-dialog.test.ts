import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { automationCurveValue, type AutomationPoint } from '@orbit/core';
import { shapePoints } from '../src/editors/automation/curve-tools';
import { readSource } from './read-source';

const source = readSource('editors/automation/ShapeDialog.tsx');

/** Ejecuta la conversión REAL de los campos del diálogo, sin montar React. */
function dialogPoints(fields: Record<string, unknown> = {}): AutomationPoint[] {
  const begin = source.indexOf('  const points = shapePoints({');
  const end = source.indexOf('\n  // La previsualización', begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const context = { shapePoints, shape: 'triangle', from: 0, to: 4, clipLength: 4,
    cycles: 1, min: 0, max: 100, phase: 0, resolution: 12, seed: 1, ...fields };
  return runInNewContext(`${source.slice(begin, end)}\npoints`, context) as AutomationPoint[];
}

describe('BUG059: fase del triángulo en el generador del diálogo', () => {
  const cases: [number, [number, number][]][] = [
    [0, [[0, 0], [2, 1], [4, 0]]],
    [12.5, [[0, 0.25], [1.5, 1], [3.5, 0], [4, 0.25]]],
    [25, [[0, 0.5], [1, 1], [3, 0], [4, 0.5]]],
    [50, [[0, 1], [2, 0], [4, 1]]],
    [75, [[0, 0.5], [1, 0], [3, 1], [4, 0.5]]],
    [100, [[0, 0], [2, 1], [4, 0]]],
  ];
  it.each(cases)('fase %s%% conserva vértices exactos y la interpolación lineal', (phase, expected) => {
    const points = dialogPoints({ phase });
    expect(points.map(({ time, value }) => [time, value])).toEqual(expected);
    // Comparar toda la interpolación con vértices esperados explícitos detecta
    // un pico perdido aunque los extremos del tramo sigan siendo correctos.
    const reference = expected.map(([time, value], i) => ({ id: `${i}`, time, value, tension: 0 }));
    for (let time = 0; time <= 4; time += 0.03125) {
      expect(automationCurveValue(points, time)).toBeCloseTo(automationCurveValue(reference, time), 12);
    }
    expect(new Set(points.map(({ time }) => time)).size).toBe(points.length);
    expect(points.every(({ tension }) => tension === 0)).toBe(true);
  });

  it('un cuarto de ciclo conserva el valor del borde aunque no incluya un valle', () => {
    const points = dialogPoints({ phase: 25, cycles: 0.25 });
    expect(points.map(({ time, value }) => [time, value])).toEqual([[0, 0.5], [4, 1]]);
    expect(automationCurveValue(points, 2)).toBeCloseTo(0.75, 12);
  });

  it('un ciclo fraccionario que atraviesa un pico lo conserva y recorta ambos bordes', () => {
    const points = dialogPoints({ phase: 40, cycles: 0.25 });
    expect(points).toHaveLength(3);
    expect(points[0]!.value).toBeCloseTo(0.8, 12);
    expect(points[1]!.time).toBeCloseTo(1.6, 12);
    expect(points[1]!.value).toBe(1);
    expect(points[2]!.time).toBe(4);
    expect(points[2]!.value).toBeCloseTo(0.7, 12);
  });

  it('varios ciclos parciales respetan posición, amplitud y borde final', () => {
    const points = dialogPoints({ from: 2, to: 10, clipLength: 10, cycles: 2.5, phase: 12.5, min: 20, max: 80 });
    const expected = [[2, 0.35], [3.2, 0.8], [4.8, 0.2], [6.4, 0.8], [8, 0.2], [9.6, 0.8], [10, 0.65]];
    expect(points).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(points[i]!.time).toBeCloseTo(expected[i]![0]!, 12);
      expect(points[i]!.value).toBeCloseTo(expected[i]![1]!, 12);
    }
  });

  it('normalizar la fase, invertir el tramo y limitarlo al clip conserva los mismos vértices', () => {
    const expected = dialogPoints({ phase: 25 });
    const geometry = (points: AutomationPoint[]) => points.map(({ time, value }) => [time, value]);
    expect(geometry(shapePoints({ shape: 'triangle', from: 4, to: 0, cycles: 1, min: 0, max: 1, phase: -0.75 }))).toEqual(geometry(expected));
    expect(geometry(dialogPoints({ phase: 125, to: 8 }))).toEqual(geometry(expected));
  });

  it('preview y Aplicar entregan la misma curva generada al consumidor', () => {
    expect(source).toContain('onPreview(points.length > 0 ? points : null)');
    expect(source).toContain('onApply(points, Math.min(from, to), Math.max(from, to))');
    const points = dialogPoints({ phase: 25 });
    expect([0, 1, 2, 3, 4].map((beat) => automationCurveValue(points, beat))).toEqual([0.5, 1, 0.5, 0, 0.5]);
  });
});
