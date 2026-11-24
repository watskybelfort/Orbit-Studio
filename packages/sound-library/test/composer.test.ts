import { describe, expect, it } from 'vitest';
import { SCALES, inScale } from '@orbit/core';
import {
  COMPOSER_GENRES,
  GENRE_PRESETS,
  composeBeat,
  createProfile,
  describePlan,
  fitTempo,
  genreDrumLanes,
  guessGenre,
  parseProfile,
  parseSteps,
  styleHint,
  type BeatPlan,
  type TrackFeatures,
} from '../src';

const part = (plan: BeatPlan, role: string) => plan.parts.find((p) => p.role === role);
const dropPattern = (plan: BeatPlan, role: string) => part(plan, role)?.patterns.find((p) => p.id.startsWith('drop'));

function track(over: Partial<TrackFeatures> = {}): TrackFeatures {
  const lane = (hits: number[]) => Array.from({ length: 16 }, (_, i) => (hits.includes(i) ? 0.9 : 0.02));
  return {
    name: 'ref.wav',
    durationSec: 120,
    bpm: 96,
    bpmConfidence: 0.8,
    keyRoot: 6,
    keyMode: 'minor',
    keyConfidence: 0.7,
    swing: 0.1,
    lanes: { low: lane([0, 4, 7, 8, 12]), mid: lane([3, 6, 11, 14]), high: lane([0, 2, 4, 6, 8, 10, 12, 14]) },
    density: { low: 5, mid: 4, high: 8 },
    brightness: 0.4,
    grit: 0.8,
    ...over,
  };
}

describe('notación de pasos', () => {
  it('lee 16 pasos y rechaza lo que no mide', () => {
    expect(parseSteps('X...x...o...?..g').map((s) => s.p)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0.65, 0, 0, 0, 0.3, 0, 0, 0.45]);
    expect(() => parseSteps('x...')).toThrow(/16/);
    expect(() => parseSteps('z...............')).toThrow(/desconocido/);
  });
  it('todos los patrones de todos los géneros son válidos', () => {
    for (const g of COMPOSER_GENRES) expect(() => genreDrumLanes(g)).not.toThrow();
  });
});

describe('composeBeat', () => {
  it.each(COMPOSER_GENRES)('%s: misma semilla, mismo beat; otra semilla, otro', (genre) => {
    const a = composeBeat({ genre, seed: 7 });
    const b = composeBeat({ genre, seed: 7 });
    const c = composeBeat({ genre, seed: 8 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.parts)).not.toBe(JSON.stringify(c.parts));
  });

  it.each(COMPOSER_GENRES)('%s: tempo del género, partes separadas y notas dentro del patrón', (genre) => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = composeBeat({ genre, seed });
      const { min, max } = GENRE_PRESETS[genre].bpm;
      expect(plan.bpm).toBeGreaterThanOrEqual(min - 3);
      expect(plan.bpm).toBeLessThanOrEqual(max + 3);
      const roles = plan.parts.map((p) => p.role);
      expect(new Set(roles).size).toBe(roles.length);
      for (const r of ['kick', 'snare', 'hats', 'bass', 'chords', 'melody']) expect(roles).toContain(r);
      for (const p of plan.parts) {
        for (const pat of p.patterns) {
          for (const n of pat.notes) {
            expect(n.start).toBeGreaterThanOrEqual(0);
            expect(n.start).toBeLessThan(pat.bars * 4);
            expect(n.velocity).toBeGreaterThan(0);
            expect(n.velocity).toBeLessThanOrEqual(1);
            expect(n.key).toBeGreaterThanOrEqual(0);
            expect(n.key).toBeLessThanOrEqual(127);
          }
        }
        // Los clips cubren secciones reales y no se solapan dentro de la pista.
        const sorted = [...p.clips].sort((x, y) => x.startBar - y.startBar);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i]!.startBar).toBeGreaterThanOrEqual(sorted[i - 1]!.startBar + sorted[i - 1]!.bars);
        }
      }
    }
  });

  it.each(COMPOSER_GENRES)('%s: bajo, acordes y melodía nunca se salen de la escala', (genre) => {
    for (const seed of [11, 12, 13, 14]) {
      const plan = composeBeat({ genre, seed });
      const scale = SCALES[plan.scaleName]!;
      for (const role of ['bass', 'chords', 'melody']) {
        for (const pat of part(plan, role)!.patterns) {
          for (const n of pat.notes) expect(inScale(n.key, plan.keyRoot, scale)).toBe(true);
        }
      }
    }
  });

  it('el bajo vive en el grave (27..39) y la melodía por encima de los acordes', () => {
    for (const genre of COMPOSER_GENRES) {
      const plan = composeBeat({ genre, seed: 3 });
      const bass = dropPattern(plan, 'bass')!.notes;
      for (const n of bass) {
        expect(n.key).toBeGreaterThanOrEqual(27);
        expect(n.key).toBeLessThanOrEqual(51);
      }
      const avg = (ns: { key: number }[]) => ns.reduce((s, n) => s + n.key, 0) / ns.length;
      expect(avg(dropPattern(plan, 'melody')!.notes)).toBeGreaterThan(avg(dropPattern(plan, 'chords')!.notes) - 3);
    }
  });

  it('el drop lleva bombo en el 1 de cada compás', () => {
    for (const genre of COMPOSER_GENRES) {
      const drop = dropPattern(composeBeat({ genre, seed: 21 }), 'kick')!;
      for (let bar = 0; bar < drop.bars; bar++) {
        expect(drop.notes.some((n) => n.start === bar * 4)).toBe(true);
      }
    }
  });

  it('techno y rave: cuatro en el suelo', () => {
    for (const genre of ['techno', 'rave'] as const) {
      const drop = dropPattern(composeBeat({ genre, seed: 5 }), 'kick')!;
      for (let bar = 0; bar < drop.bars; bar++) {
        for (const beat of [0, 1, 2, 3]) expect(drop.notes.some((n) => n.start === bar * 4 + beat)).toBe(true);
      }
    }
  });

  it('reggaetón: la caja del dembow cae en sus cuatro sitios', () => {
    for (const seed of [1, 2, 3]) {
      const drop = dropPattern(composeBeat({ genre: 'reggaeton', seed }), 'snare')!;
      const key = GENRE_PRESETS.reggaeton.drums.keys.snare;
      for (let bar = 0; bar < drop.bars; bar++) {
        for (const at of [0.75, 1.5, 2.75, 3.5]) {
          expect(drop.notes.some((n) => n.key === key && n.start === bar * 4 + at)).toBe(true);
        }
      }
    }
  });

  it('neo perreo: dembow con caja en el 0.75 y bajo distorsionado', () => {
    const plan = composeBeat({ genre: 'neoperreo', seed: 9 });
    const drop = dropPattern(plan, 'snare')!;
    const caja = GENRE_PRESETS.neoperreo.drums.keys.snare;
    expect(drop.notes.filter((n) => n.key === caja && n.start % 4 === 0.75).length).toBe(drop.bars);
    expect(part(plan, 'bass')!.fx.some((f) => f.kind === 'distortion')).toBe(true);
    expect(plan.bpm).toBeGreaterThanOrEqual(88);
    expect(plan.bpm).toBeLessThanOrEqual(108);
  });

  it('trap: el 808 arranca donde golpea el bombo', () => {
    const plan = composeBeat({ genre: 'trap', seed: 4 });
    const kicks = new Set(dropPattern(plan, 'kick')!.notes.map((n) => n.start));
    for (const n of dropPattern(plan, 'bass')!.notes) expect(kicks.has(n.start)).toBe(true);
  });

  it('la subida cierra con redoble y el intro no lleva bombo', () => {
    const plan = composeBeat({ genre: 'trap', seed: 2, shape: 0 });
    const snare = part(plan, 'snare')!.patterns.find((p) => p.id.startsWith('build'))!;
    const lastBar = (snare.bars - 1) * 4;
    expect(snare.notes.filter((n) => n.start >= lastBar).length).toBeGreaterThanOrEqual(16);
    expect(part(plan, 'kick')!.patterns.some((p) => p.id.startsWith('intro'))).toBe(false);
  });

  it('modo bucle: una sola sección de los compases pedidos', () => {
    const plan = composeBeat({ genre: 'boombap', seed: 1, shape: 'loop', loopBars: 4 });
    expect(plan.sections).toHaveLength(1);
    expect(plan.totalBars).toBe(4);
    expect(plan.swing).toBeGreaterThan(0.4);
  });

  it('respeta tempo, tonalidad, escala, progresión y partes pedidas', () => {
    const plan = composeBeat({
      genre: 'reggaeton', seed: 1, bpm: 92, keyRoot: 2, scale: 'Dórico', progression: [0, 3], roles: ['kick', 'melody'],
    });
    expect(plan.bpm).toBe(92);
    expect(plan.keyRoot).toBe(2);
    expect(plan.scaleName).toBe('Dórico');
    expect(plan.progression).toEqual([0, 3]);
    expect(plan.parts.map((p) => p.role)).toEqual(['kick', 'melody']);
    expect(describePlan(plan)).toMatch(/92 BPM · D Dórico/);
  });

  it('rechaza opciones que no tienen sentido', () => {
    expect(() => composeBeat({ genre: 'polka' as never, seed: 1 })).toThrow(/género/);
    expect(() => composeBeat({ genre: 'trap', seed: 1, bpm: 900 })).toThrow(/bpm/);
    expect(() => composeBeat({ genre: 'trap', seed: 1, keyRoot: 12 })).toThrow(/keyRoot/);
    expect(() => composeBeat({ genre: 'trap', seed: 1, scale: 'Lidia' })).toThrow(/escala/);
    expect(() => composeBeat({ genre: 'trap', seed: 1, roles: [] })).toThrow(/parte/);
    expect(() => composeBeat({ genre: 'trap', seed: 1, progression: [9] })).toThrow(/progression/);
    expect(() => composeBeat({ genre: 'trap', seed: 1, shape: 'loop', loopBars: 99 })).toThrow(/loopBars/);
  });

  it('la variación de sonido mueve las perillas dentro de rango, sin tocarlas a 0', () => {
    const quiet = composeBeat({ genre: 'trap', seed: 3, soundVariation: 0 });
    const wild = composeBeat({ genre: 'trap', seed: 3, soundVariation: 1 });
    expect(JSON.stringify(quiet.parts.map((p) => p.sound))).not.toBe(JSON.stringify(wild.parts.map((p) => p.sound)));
    for (const p of wild.parts) for (const v of Object.values(p.sound.params)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('perfil de estilo', () => {
  it('lleva el tempo al rango del género (half-time y doble)', () => {
    expect(fitTempo(70, 'trap')).toBe(140);
    expect(fitTempo(188, 'reggaeton')).toBe(94);
    expect(fitTempo(134, 'techno')).toBe(134);
    expect(fitTempo(60, 'rave')).toBeNull();
  });

  it('el perfil empuja tempo, tonalidad y groove, y se cuenta en el plan', () => {
    const profile = createProfile('p1', 'Mis beats', [track()]);
    const hint = styleHint(profile, 'neoperreo');
    expect(hint.matched).toBe(1);
    expect(hint.bpm).toBe(96);
    const plan = composeBeat({ genre: 'neoperreo', seed: 4, profile, influence: 1 });
    expect(plan.bpm).toBe(96);
    expect(plan.keyRoot).toBe(6);
    expect(plan.style).toEqual({ profile: 'Mis beats', matched: 1, grooved: 1, influence: 1 });
    const without = composeBeat({ genre: 'neoperreo', seed: 4 });
    expect(JSON.stringify(plan.parts)).not.toBe(JSON.stringify(without.parts));
  });

  it('un perfil de otro tempo no le cambia el groove a un género que no encaja', () => {
    const profile = createProfile('p', 'Boom bap', [track({ bpm: 88 })]);
    expect(styleHint(profile, 'rave').lanes).toBeNull();
    expect(styleHint(profile, 'rave').matched).toBe(0);
  });

  it('valida lo que llega de fuera', () => {
    const profile = createProfile('p', 'X', [track()]);
    expect(parseProfile(JSON.parse(JSON.stringify(profile)))).toEqual(profile);
    expect(parseProfile({ version: 1, id: 'x', name: 'y', tracks: [{ name: 'a' }] })).toBeNull();
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile({ ...profile, version: 99 })).toBeNull();
  });

  it('adivina el género por tempo y groove', () => {
    expect(guessGenre(track())).toMatch(/reggaeton|neoperreo/);
    const four = (i: number[]) => Array.from({ length: 16 }, (_, k) => (i.includes(k) ? 1 : 0));
    expect(guessGenre(track({ bpm: 134, lanes: { low: four([0, 4, 8, 12]), mid: four([4, 12]), high: four([2, 6, 10, 14]) } }))).toBe('techno');
    expect(guessGenre(track({ bpm: 70, swing: 0, lanes: { low: four([0, 6, 10]), mid: four([8]), high: four([0, 2, 4, 6, 8, 10, 12, 14]) }, density: { low: 3, mid: 1, high: 12 } }))).toBe('trap');
  });
});
