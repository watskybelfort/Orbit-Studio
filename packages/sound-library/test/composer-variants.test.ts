import { describe, expect, it } from 'vitest';
import { COMPOSER_GENRES, GENRE_PRESETS, composeBeat, describePlan, genreVariants, recomposePart, resolvePreset } from '../src';

describe('variantes de género', () => {
  it('sin variante se usa el preset de siempre', () => {
    for (const g of COMPOSER_GENRES) expect(resolvePreset(g)).toBe(GENRE_PRESETS[g]);
  });

  it('una variante que no existe se rechaza con un motivo legible', () => {
    expect(() => composeBeat({ genre: 'boombap', seed: 1, variant: 'inventada' })).toThrow(/variante "inventada"/);
  });

  it('pedir la variante vacía es pedir la de siempre (misma semilla, mismo beat)', () => {
    const a = composeBeat({ genre: 'trap', seed: 7, shape: 'loop' });
    const b = composeBeat({ genre: 'trap', seed: 7, shape: 'loop', variant: '' });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect('variant' in a).toBe(false);
  });

  for (const g of COMPOSER_GENRES) {
    for (const v of genreVariants(g)) {
      it(`${g} · ${v.id}: compone, lo dice en el plan y recompone dentro de la variante`, () => {
        expect(v.preset.id).toBe(g);
        const plan = composeBeat({ genre: g, seed: 3, variant: v.id });
        expect(plan.variant).toBe(v.id);
        expect(plan.bpm).toBeGreaterThanOrEqual(v.preset.bpm.min - 3);
        expect(plan.bpm).toBeLessThanOrEqual(v.preset.bpm.max + 3);
        expect(describePlan(plan)).toContain(v.name);
        expect(plan.master).toBe(v.preset.master);
        const role = plan.parts[plan.parts.length - 1]!.role;
        const again = recomposePart(plan, role, 3);
        expect(JSON.stringify(again)).toBe(JSON.stringify(plan.parts.find((p) => p.role === role)));
        // Y suena distinto a la de siempre con la misma semilla.
        const base = composeBeat({ genre: g, seed: 3 });
        expect(JSON.stringify(plan.parts)).not.toBe(JSON.stringify(base.parts));
      });
    }
  }
});
