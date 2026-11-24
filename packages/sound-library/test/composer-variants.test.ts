import { describe, expect, it } from 'vitest';
import { SCALES } from '@orbit/core';
import { COMPOSER_GENRES, GENRE_PRESETS, MAX_PART_FX, composeBeat, describePlan, factoryInstrument, factorySound, genreVariants, recomposePart, resolvePreset } from '../src';

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

  it('trap duro: el 808 vive en Re1-Fa1 hacia abajo (26..37) con la tónica entre Re y Fa, y la forma larga dura 2:00-2:30', () => {
    for (const variant of ['duro', 'crudo']) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const plan = composeBeat({ genre: 'trap', variant, seed });
        expect([2, 3, 4, 5]).toContain(plan.keyRoot);
        // Sin contar los glides, que al cerrar la frase pueden subir una octava (firma del 808).
        const notes = plan.parts.find((x) => x.role === 'bass')!.patterns.flatMap((pt) => pt.notes);
        const slideUp = new Set(notes.filter((n) => n.slide).map((n) => n.start));
        for (const n of notes) {
          if (n.slide || slideUp.has(n.start)) continue;
          expect(n.key, `${variant} ${seed} @${n.start}`).toBeGreaterThanOrEqual(26);
          expect(n.key, `${variant} ${seed} @${n.start}`).toBeLessThanOrEqual(37);
        }
        expect(plan.totalBars).toBe(80);
        const sec = (plan.totalBars * 4 * 60) / plan.bpm;
        expect(sec).toBeGreaterThanOrEqual(120);
        expect(sec).toBeLessThanOrEqual(150);
        expect(plan.sections.some((x) => x.kind === 'break')).toBe(true);
      }
    }
  });

  it('las variantes con golpe en el hook entran al hook con un barrido que acaba justo en él', () => {
    const plan = composeBeat({ genre: 'reggaeton', seed: 2, shape: 3 });
    const fx = plan.parts.find((x) => x.role === 'fx')!;
    for (const v of fx.patterns.filter((pt) => pt.id.startsWith('verse'))) {
      const riser = v.notes.find((n) => n.key !== 62)!;
      expect(riser.start + riser.duration).toBeCloseTo(v.bars * 4, 5);
    }
  });

  it('ninguna parte de ningún preset ni variante pide más insertos de los que tiene un canal', () => {
    // Lo que pasaba de 4 no sonaba, sin aviso: se perdieron muescas y el sidechain del 808 del trap duro.
    for (const g of COMPOSER_GENRES) {
      for (const p of [GENRE_PRESETS[g], ...genreVariants(g).map((v) => v.preset)]) {
        for (const [role, fx] of Object.entries(p.fx)) expect(fx?.length ?? 0, `${g} ${role}`).toBeLessThanOrEqual(MAX_PART_FX);
      }
    }
  });
});
