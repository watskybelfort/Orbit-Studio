/**
 * Cortes del Slicer: lo que se guarda y cómo se lee.
 *
 * La lista viene de un detector (o de la mano), así que puede llegar
 * desordenada, con duplicados o con puntos pegados; y el motor la usa tal cual
 * para leer el sample, o sea que aquí es donde se garantiza que tiene sentido.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_SLICE_POINTS,
  evenSlicePoints,
  normalizeSlicePoints,
  sliceCount,
  sliceRange,
} from '../src/model/slices';

describe('normalizeSlicePoints', () => {
  it('sin nada, no hay troceado propio', () => {
    expect(normalizeSlicePoints(undefined)).toBeUndefined();
    expect(normalizeSlicePoints([])).toBeUndefined();
    // Un punto suelto es el sample entero, no un troceado.
    expect(normalizeSlicePoints([0.4])).toEqual([0, 0.4]);
    expect(normalizeSlicePoints([0])).toBeUndefined();
  });

  it('ordena, recorta al rango y siempre empieza en 0', () => {
    expect(normalizeSlicePoints([0.6, 0.2, 0.9])).toEqual([0, 0.2, 0.6, 0.9]);
    expect(normalizeSlicePoints([-1, 0.5, 2])).toEqual([0, 0.5]);
  });

  it('tira duplicados y lo que cae pegado al punto anterior', () => {
    expect(normalizeSlicePoints([0.5, 0.5, 0.50001])).toEqual([0, 0.5]);
  });

  it('un corte en el final no abre trozo nuevo', () => {
    expect(normalizeSlicePoints([0.5, 1])).toEqual([0, 0.5]);
  });

  it('no guarda más cortes de los que tienen sentido', () => {
    const muchos = Array.from({ length: 200 }, (_, i) => i / 200);
    expect(normalizeSlicePoints(muchos)!.length).toBe(MAX_SLICE_POINTS);
  });

  it('descarta la basura sin tirar la lista entera', () => {
    expect(normalizeSlicePoints([Number.NaN, 0.3, Infinity])).toEqual([0, 0.3]);
  });
});

describe('evenSlicePoints', () => {
  it('reparte a partes iguales desde 0', () => {
    expect(evenSlicePoints(4)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('nunca menos de dos trozos ni más del tope', () => {
    expect(evenSlicePoints(0)).toHaveLength(2);
    expect(evenSlicePoints(1000)).toHaveLength(MAX_SLICE_POINTS);
  });
});

describe('sliceRange', () => {
  it('sin cortes propios, partes iguales', () => {
    expect(sliceRange(undefined, 0, 4)).toEqual({ start: 0, end: 0.25 });
    expect(sliceRange(undefined, 3, 4)).toEqual({ start: 0.75, end: 1 });
  });

  it('con cortes propios manda la lista, aunque sean desiguales', () => {
    const p = [0, 0.1, 0.7];
    expect(sliceRange(p, 0, 8)).toEqual({ start: 0, end: 0.1 });
    expect(sliceRange(p, 1, 8)).toEqual({ start: 0.1, end: 0.7 });
    expect(sliceRange(p, 2, 8)).toEqual({ start: 0.7, end: 1 });
  });

  it('el índice se envuelve: el teclado sigue dando trozos hacia arriba', () => {
    const p = [0, 0.5];
    expect(sliceRange(p, 2, 8)).toEqual(sliceRange(p, 0, 8));
    expect(sliceRange(p, -1, 8)).toEqual(sliceRange(p, 1, 8));
  });
});

describe('sliceCount', () => {
  it('cuenta los cortes propios, o los iguales si no hay', () => {
    expect(sliceCount([0, 0.3, 0.6], 8)).toBe(3);
    expect(sliceCount(undefined, 8)).toBe(8);
  });
});
