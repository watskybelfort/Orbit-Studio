import { describe, expect, it } from 'vitest';
import { chordify, SCALES, type Note } from '../src';

function note(start: number, key: number, id = `n${key}@${start}`): Note {
  return { id, start, duration: 1, key, velocity: 0.7, pan: 0.2, slide: true };
}

const MENOR = [0, 3, 7];
const MAYOR = [0, 4, 7];

describe('acordes sobre notas ya escritas', () => {
  it('devuelve solo las notas nuevas, no la original', () => {
    const got = chordify([note(0, 60)], { intervals: MENOR });
    expect(got.map((n) => n.key)).toEqual([63, 67]);
  });

  it('las notas nuevas heredan el hueco de la madre pero no su slide', () => {
    const [tercera] = chordify([note(2, 60)], { intervals: MENOR });
    expect(tercera).toMatchObject({ start: 2, duration: 1, velocity: 0.7, pan: 0.2, slide: false });
    expect(tercera!.id).not.toBe('n60@2');
  });

  it('no repite lo que ya hay escrito', () => {
    const raiz = note(0, 60);
    const quinta = note(0, 67);
    const got = chordify([raiz], { intervals: MENOR, existing: [raiz, quinta] });
    expect(got.map((n) => n.key)).toEqual([63]);
  });

  it('aplicarlo dos veces no apila notas encima de las mismas teclas', () => {
    const raiz = note(0, 60);
    const primera = chordify([raiz], { intervals: MAYOR });
    const segunda = chordify([raiz], { intervals: MAYOR, existing: [raiz, ...primera] });
    expect(segunda).toEqual([]);
  });

  it('con escala, el acorde se arrima a la tonalidad', () => {
    // Do menor natural sobre el 62 (D): un acorde MAYOR daría F# (66) y A
    // (69), que no están en la escala. Ajustado cae en F (65) y Ab (68) — el
    // acorde que de verdad toca sobre el segundo grado de Do menor.
    const got = chordify([note(0, 62)], {
      intervals: MAYOR,
      scale: SCALES['Menor natural'],
      root: 0,
    });
    expect(got.map((n) => n.key)).toEqual([65, 68]);
  });

  it('sin escala el acorde es fijo, suba donde suba', () => {
    const got = chordify([note(0, 62)], { intervals: MAYOR });
    expect(got.map((n) => n.key)).toEqual([66, 69]);
  });

  it('respeta el techo del teclado', () => {
    expect(chordify([note(0, 126)], { intervals: MAYOR, maxKey: 127 }).map((n) => n.key)).toEqual([]);
  });

  it('vale para varias notas de golpe y sale ordenado', () => {
    const got = chordify([note(4, 60), note(0, 60)], { intervals: [0, 7] });
    expect(got.map((n) => [n.start, n.key])).toEqual([
      [0, 67],
      [4, 67],
    ]);
  });

  it('sin intervalos no hace nada', () => {
    expect(chordify([note(0, 60)], { intervals: [] })).toEqual([]);
  });
});
