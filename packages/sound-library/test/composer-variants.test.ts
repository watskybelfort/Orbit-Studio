import { describe, expect, it } from 'vitest';
import { SCALES } from '@orbit/core';
import { COMPOSER_GENRES, GENRE_PRESETS, composeBeat, describePlan, factoryInstrument, factorySound, genreVariants, recomposePart, resolvePreset } from '../src';

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

  // Las mismas reglas de calidad que los géneros de siempre, para cada variante.
  const banned = /celesta|juguete|talkbox|melodica|saxo|campana|laser|sirena|requinto|8bit|metal(?!es)/;
  for (const g of COMPOSER_GENRES) {
    for (const v of genreVariants(g)) {
      it(`${g} · ${v.id}: sonidos que existen, kit sampleado, sin timbres vetados, melodía sin b9 ni agudos, true peak`, () => {
        const p = v.preset;
        for (const ids of Object.values(p.drumKit ?? {})) for (const id of ids ?? []) expect(factorySound(id), id).toBeDefined();
        if (p.fxKit) for (const id of [p.fxKit.riser, p.fxKit.impact]) expect(factorySound(id), id).toBeDefined();
        for (const role of ['bass', 'chords', 'melody'] as const) {
          for (const c of p.sounds[role]) if (c.instrument) expect(factoryInstrument(c.instrument)?.length ?? 0, c.instrument).toBeGreaterThan(1);
        }
        expect(p.master.find((f) => f.kind === 'limiter')!.params).toMatchObject({ ceiling: -1.2, truePeak: 1 });
        for (const seed of [1, 2, 3, 4]) {
          const plan = composeBeat({ genre: g, variant: v.id, seed });
          for (const role of ['kick', 'snare', 'hats'] as const) expect(plan.parts.find((x) => x.role === role)!.sound.kind).toBe('sampler');
          for (const part of plan.parts) {
            expect(part.sound.preset ?? '', `${part.role}`).not.toMatch(banned);
            const inst = (part.sound.zones?.[0]?.sampleId ?? '').replace(/^instrumentos\/guitarra-nylon.*/, '');
            expect(inst, part.role).not.toMatch(banned);
          }
          const mel = plan.parts.find((x) => x.role === 'melody');
          if (p.sounds.melody.length === 0) {
            expect(mel).toBeUndefined();
            continue;
          }
          const notes = mel!.patterns.flatMap((pt) => pt.notes);
          expect(notes.reduce((s, n) => s + n.key, 0) / notes.length).toBeLessThan(84);
          const scale = SCALES[plan.scaleName]!;
          for (const pt of mel!.patterns) {
            for (const n of pt.notes) {
              const deg = plan.progression[Math.floor(n.start / 4) % plan.progression.length]!;
              const tones = [0, 2, 4].map((o) => (plan.keyRoot + scale[(deg + o) % scale.length]!) % 12);
              expect(tones.some((pc) => (((n.key - pc) % 12) + 12) % 12 === 1), `${seed} ${pt.id} ${n.key}`).toBe(false);
            }
          }
        }
      });
    }
  }

  it('el trap sin melodía no tiene ni melodía ni acordes: batería, 808 y FX', () => {
    const plan = composeBeat({ genre: 'trap', variant: 'crudo', seed: 5 });
    expect(plan.parts.map((x) => x.role).sort()).toEqual(['bass', 'fx', 'hats', 'kick', 'snare'].sort());
  });
});
