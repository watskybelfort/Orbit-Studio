/**
 * La forma de un beat entero.
 *
 * Lo que se prueba no es que las secciones existan, sino que las tres reglas
 * que hacen que un tema suene a tema se cumplan en TODAS las formas: se empieza
 * presentando, ningún drop cae sin que algo lo anuncie, y se acaba dejando ir.
 * Y que el reparto en el tiempo no deje huecos ni solapes.
 */

import { describe, expect, it } from 'vitest';
import {
  SHAPE_COUNT,
  densityOf,
  isLastBarOfSection,
  planSections,
  sectionAt,
  totalBars,
} from '../src/pack-structure';

const ALL = Array.from({ length: SHAPE_COUNT }, (_, i) => planSections(i));

describe('planSections: todas las formas', () => {
  it('empiezan presentando', () => {
    for (const sections of ALL) expect(sections[0]!.kind).toBe('intro');
  });

  it('acaban dejando ir', () => {
    for (const sections of ALL) expect(sections[sections.length - 1]!.kind).toBe('outro');
  });

  it('ningún drop cae sin que algo lo anuncie', () => {
    for (const sections of ALL) {
      sections.forEach((s, i) => {
        if (s.kind !== 'drop') return;
        const antes = sections[i - 1];
        expect(antes).toBeDefined();
        // Un build, o el propio drop volviendo tras la vuelta.
        expect(['build', 'break']).toContain(antes!.kind);
      });
    }
  });

  it('tienen al menos un drop (si no, no hay tema)', () => {
    for (const sections of ALL) {
      expect(sections.some((s) => s.kind === 'drop')).toBe(true);
    }
  });

  it('van en compases de cuatro y no se quedan cortas', () => {
    for (const sections of ALL) {
      for (const s of sections) expect(s.bars % 4).toBe(0);
      expect(totalBars(sections)).toBeGreaterThanOrEqual(16);
    }
  });
});

describe('reparto en el tiempo', () => {
  it('las secciones se encadenan sin huecos ni solapes', () => {
    for (const sections of ALL) {
      let esperado = 0;
      for (const s of sections) {
        expect(s.startBar).toBe(esperado);
        esperado += s.bars;
      }
      expect(esperado).toBe(totalBars(sections));
    }
  });

  it('cada compás del tema tiene su sección, y ni uno más', () => {
    for (const sections of ALL) {
      const total = totalBars(sections);
      for (let bar = 0; bar < total; bar++) expect(sectionAt(sections, bar)).not.toBeNull();
      expect(sectionAt(sections, total)).toBeNull();
      expect(sectionAt(sections, -1)).toBeNull();
    }
  });

  it('el último compás de cada sección se reconoce', () => {
    const sections = planSections(0);
    for (const s of sections) {
      expect(isLastBarOfSection(sections, s.startBar + s.bars - 1)).toBe(true);
      if (s.bars > 1) expect(isLastBarOfSection(sections, s.startBar)).toBe(false);
    }
  });

  it('el índice se envuelve y no se sale nunca', () => {
    expect(planSections(SHAPE_COUNT)).toEqual(planSections(0));
    expect(planSections(-1)).toEqual(planSections(SHAPE_COUNT - 1));
    expect(planSections(999).length).toBeGreaterThan(0);
  });
});

describe('densidad por sección', () => {
  it('el drop suena entero y la intro no lleva bombo', () => {
    expect(densityOf('drop').drums).toBe(1);
    expect(densityOf('drop').bass).toBe(1);
    expect(densityOf('intro').drums).toBe(0);
  });

  it('la vuelta se queda sin 808: es lo que deja sitio para volver a subir', () => {
    expect(densityOf('break').bass).toBe(0);
    expect(densityOf('break').drums).toBeLessThan(densityOf('drop').drums);
  });

  it('solo el build lleva redoble, y va con los hats al doble', () => {
    expect(densityOf('build').roll).toBe(true);
    expect(densityOf('build').doubleHats).toBe(true);
    for (const kind of ['intro', 'drop', 'break', 'outro'] as const) {
      expect(densityOf(kind).roll).toBe(false);
    }
  });
});
