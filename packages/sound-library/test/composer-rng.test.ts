import { describe, expect, it } from 'vitest';
import { createRng, hashString } from '../src';

/**
 * El compositor entero cuelga de aquí: si esta pieza cambia sin querer, el
 * mismo proyecto con la misma semilla deja de sonar igual. Por eso se fijan
 * también los números, no solo «que sea determinista».
 */
describe('azar con semilla', () => {
  it('misma semilla, misma secuencia; otra semilla, otra', () => {
    const a = createRng(1);
    const seq = [a.next(), a.next(), a.next()];
    // Los tres primeros valores de la semilla 1 (mulberry32, 32 bits de estado).
    // Cambiarlos no es un detalle de test: es otro beat para cada semilla guardada.
    expect(seq).toEqual([0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
    const b = createRng(1);
    expect([b.next(), b.next(), b.next()]).toEqual(seq);
    expect(createRng(2).next()).not.toBe(seq[0]);
  });

  it('int es inclusivo en los dos extremos y range no toca el máximo', () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(rng.int(2, 4));
    expect([...seen].sort()).toEqual([2, 3, 4]);
    for (let i = 0; i < 200; i++) {
      const v = rng.range(-1, 1);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThan(1);
    }
  });

  it('chance(0) nunca y chance(1) siempre', () => {
    const rng = createRng(11);
    for (let i = 0; i < 100; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('weighted no elige un peso 0 y cae en el primero si todos pesan 0', () => {
    const rng = createRng(5);
    const items = ['a', 'b', 'c'] as const;
    for (let i = 0; i < 200; i++) expect(rng.weighted(items, [0, 1, 0])).toBe('b');
    expect(rng.weighted(items, [0, 0, 0])).toBe('a');
  });

  it('fork no consume del padre: el hijo sale igual antes o después de usarlo', () => {
    // De esto depende que tocar una parte (pedir un número más en la melodía)
    // no mueva la batería: cada hijo nace del texto y de la semilla, no del
    // estado del padre.
    const child = createRng(42).fork('melody');
    const expected = [child.next(), child.next(), child.next()];
    const late = createRng(42);
    for (let i = 0; i < 17; i++) late.next();
    const afterParentUse = late.fork('melody');
    expect([afterParentUse.next(), afterParentUse.next(), afterParentUse.next()]).toEqual(expected);
    // Y dos hijos con nombre distinto no son el mismo flujo.
    expect(createRng(42).fork('kick').next()).not.toBe(expected[0]);
  });

  it('hashString es FNV-1a de 32 bits', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('kick')).toBe(3323728671);
    expect(hashString('kick', 7)).toBe(3375443029);
    expect(hashString('kick')).not.toBe(hashString('Kick'));
    expect(hashString('melody') >>> 0).toBe(hashString('melody'));
  });
});
