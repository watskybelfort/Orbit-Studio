import { describe, expect, it } from 'vitest';
import { clampFades, fadeGainAt } from '../src/model/fades';

describe('clamp de fundidos', () => {
  it('los deja como están cuando caben', () => {
    expect(clampFades(1, 2, 8)).toEqual({ fadeIn: 1, fadeOut: 2 });
  });

  it('sin fundidos devuelve ceros', () => {
    expect(clampFades(undefined, undefined, 8)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });

  it('dos fundidos que se pisan reparten el clip a proporción', () => {
    // Primero cada uno se limita al clip (6 → 4) y DESPUÉS se reparten: 4 y 2
    // en un clip de 4 salen 2:1. Se llenan los 4 beats justos, sin ganancia
    // por encima de 1 y sin que uno se coma al otro.
    const f = clampFades(6, 2, 4);
    expect(f.fadeIn + f.fadeOut).toBeCloseTo(4);
    expect(f.fadeIn / f.fadeOut).toBeCloseTo(2);
  });

  it('dos fundidos iguales parten el clip por la mitad', () => {
    expect(clampFades(3, 3, 4)).toEqual({ fadeIn: 2, fadeOut: 2 });
  });

  it('un solo fundido no pasa de la longitud del clip', () => {
    expect(clampFades(99, 0, 4)).toEqual({ fadeIn: 4, fadeOut: 0 });
  });

  it('valores imposibles salen como 0', () => {
    expect(clampFades(-3, Number.NaN, 4)).toEqual({ fadeIn: 0, fadeOut: 0 });
    expect(clampFades(2, 2, 0)).toEqual({ fadeIn: 0, fadeOut: 0 });
  });
});

describe('ganancia del fundido', () => {
  const f = clampFades(2, 1, 8);

  it('entra desde silencio y llega a 1 al acabar la rampa', () => {
    expect(fadeGainAt(0, f, 8)).toBe(0);
    expect(fadeGainAt(1, f, 8)).toBeCloseTo(0.5);
    expect(fadeGainAt(2, f, 8)).toBeCloseTo(1);
  });

  it('en el centro no toca nada', () => {
    expect(fadeGainAt(5, f, 8)).toBe(1);
  });

  it('sale hasta silencio al final', () => {
    expect(fadeGainAt(7.5, f, 8)).toBeCloseTo(0.5);
    expect(fadeGainAt(8, f, 8)).toBe(0);
  });

  it('fuera del clip no suena', () => {
    expect(fadeGainAt(-1, f, 8)).toBe(0);
    expect(fadeGainAt(9, f, 8)).toBe(0);
  });

  it('con los dos fundidos tocándose manda el más bajo, nunca la suma', () => {
    const tope = clampFades(4, 4, 4); // repartido: 2 y 2
    for (let b = 0; b <= 4; b += 0.25) {
      expect(fadeGainAt(b, tope, 4)).toBeLessThanOrEqual(1);
    }
    expect(fadeGainAt(2, tope, 4)).toBeCloseTo(1);
  });
});
