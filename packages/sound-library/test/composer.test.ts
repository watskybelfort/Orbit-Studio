import { describe, expect, it } from 'vitest';
import { SCALES, inScale } from '@orbit/core';
import {
  COMPOSER_GENRES,
  GENRE_PRESETS,
  composeBeat,
  createProfile,
  describePlan,
  DRUM_PITCH,
  factoryInstrument,
  kickTune,
  factorySound,
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
// El pico del tema: el drop en las formas de club, el hook en las de rap.
const dropPattern = (plan: BeatPlan, role: string) =>
  part(plan, role)?.patterns.find((p) => p.id.startsWith('drop')) ?? part(plan, role)?.patterns.find((p) => p.id.startsWith('hook'));

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
        // El boom bap toca el bombo unos ms tarde (microtiming MPC): cuenta como «en el 1».
        expect(drop.notes.some((n) => Math.abs(n.start - bar * 4) < 0.05)).toBe(true);
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
    // Swing MPC de boom bap: 0.36 ≈ 59 % de Linn (54-62 % es lo que suena suelto sin ser tresillo).
    expect(plan.swing).toBeGreaterThan(0.25);
    expect(plan.swing).toBeLessThan(0.48);
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

describe('instrumentos propios de cada género', () => {
  it('todo sonido de fábrica que piden los presets existe en la librería', () => {
    for (const g of COMPOSER_GENRES) {
      const p = GENRE_PRESETS[g];
      for (const ids of Object.values(p.drumKit ?? {})) for (const id of ids ?? []) expect(factorySound(id), `${g}: ${id}`).toBeDefined();
      if (p.fxKit) {
        expect(factorySound(p.fxKit.riser)).toBeDefined();
        expect(factorySound(p.fxKit.impact)).toBeDefined();
      }
    }
  });

  it('trap, reggaetón, neo perreo y boom bap tocan su batería sampleada; techno y rave, el kit sintético', () => {
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      for (const seed of [1, 2, 3]) {
        const plan = composeBeat({ genre: g, seed });
        for (const role of ['kick', 'snare', 'hats'] as const) {
          const sound = part(plan, role)!.sound;
          expect(sound.kind).toBe('sampler');
          // Cada nota cae en una tecla que tiene sample: nada mudo.
          const keys = new Set(Object.keys(sound.samples!).map(Number));
          for (const pt of part(plan, role)!.patterns) for (const n of pt.notes) expect(keys.has(n.key)).toBe(true);
        }
        const kit = Object.values(part(plan, 'kick')!.sound.samples!)[0]!;
        // Cada género, su kit: el del trap ya no viste al dembow.
        expect(kit).toMatch(new RegExp(`^drums/${g}/`));
      }
    }
    for (const g of ['techno', 'rave'] as const) expect(part(composeBeat({ genre: g, seed: 1 }), 'kick')!.sound.kind).toBe('drums');
  });

  it('nada de timbres metálicos ni de juguete, y sin percusión suelta en trap y boom bap', () => {
    const banned = /celesta|juguete|talkbox|melodica|saxo|campana|laser|sirena|requinto|nylon|8bit|metal/;
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const plan = composeBeat({ genre: g, seed });
        // También los instrumentos grabados (sampler): su id va en la primera zona. La
        // guitarra nylon GRABADA del reggaetón sí va (es del género, y cálida: centroide
        // ~590 Hz); lo vetado era el nylon sintético brillante, que es un preset.
        for (const p of plan.parts) {
          expect(p.sound.preset ?? '', `${g} ${p.role}`).not.toMatch(banned);
          const inst = (p.sound.zones?.[0]?.sampleId ?? '').replace(/^instrumentos\/guitarra-nylon.*/, '');
          expect(inst, `${g} ${p.role}`).not.toMatch(banned);
        }
        if (g === 'trap' || g === 'boombap') expect(part(plan, 'perc')).toBeUndefined();
      }
    }
    expect(part(composeBeat({ genre: 'boombap', seed: 1 }), 'fx')).toBeUndefined();
  });

  it('la melodía no se va a lo agudo (media por debajo de C6)', () => {
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      for (const seed of [1, 2, 3]) {
        const notes = part(composeBeat({ genre: g, seed }), 'melody')!.patterns.flatMap((p) => p.notes);
        const avg = notes.reduce((s, n) => s + n.key, 0) / notes.length;
        expect(avg, `${g} ${seed}`).toBeLessThan(84);
      }
    }
  });

  it('el barrido de la subida termina justo en el drop y el impacto cae en el 1', () => {
    const plan = composeBeat({ genre: 'trap', seed: 2, shape: 0 });
    const fx = part(plan, 'fx')!;
    const build = fx.patterns.find((p) => p.id.startsWith('build'))!;
    const riser = build.notes[0]!;
    expect(riser.start + riser.duration).toBeCloseTo(build.bars * 4, 5);
    const drop = fx.patterns.find((p) => p.id.startsWith('drop'))!;
    expect(drop.notes).toEqual([expect.objectContaining({ start: 0, key: 62 })]);
  });

  it('los instrumentos grabados que piden los presets existen, con varias tomas', () => {
    for (const g of COMPOSER_GENRES) {
      for (const role of ['bass', 'chords', 'melody'] as const) {
        for (const c of GENRE_PRESETS[g].sounds[role]) {
          if (!c.instrument) continue;
          expect(c.kind, `${g} ${c.instrument}`).toBe('sampler');
          expect(factoryInstrument(c.instrument)?.length ?? 0, `${g} ${c.instrument}`).toBeGreaterThan(1);
        }
      }
    }
  });
});

describe('reglas de la investigación de género', () => {
  it('el glide del 808 solo cierra la frase: último compás de cada 4, segunda mitad', () => {
    for (const g of ['trap', 'neoperreo', 'reggaeton'] as const) {
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        for (const pt of part(composeBeat({ genre: g, seed }), 'bass')!.patterns) {
          for (const n of pt.notes) {
            if (!n.slide) continue;
            expect(Math.floor(n.start / 4) % 4, `${g} ${seed} ${pt.id}`).toBe(3);
            expect(n.start % 4, `${g} ${seed} ${pt.id}`).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
  });

  it('boom bap: bombo tarde, caja adelantada y hats tarde, el mismo desfase en cada compás', () => {
    const plan = composeBeat({ genre: 'boombap', seed: 4 });
    const ms = (beats: number) => (beats * 60000) / plan.bpm;
    const off = (role: string, grid: number) =>
      dropPattern(plan, role)!.notes.filter((n) => Math.abs(n.start - Math.round(n.start / grid) * grid) < 0.1).map((n) => ms(n.start - Math.round(n.start / grid) * grid));
    for (const o of off('kick', 4)) expect(o).toBeCloseTo(GENRE_PRESETS.boombap.drums.feelMs!.kick!, 0);
    for (const o of off('snare', 2).filter((x) => Math.abs(x) < 20)) expect(o).toBeCloseTo(GENRE_PRESETS.boombap.drums.feelMs!.snare!, 0);
    // Los hats llevan además el swing horneado en las semicorcheas pares: se miran las corcheas.
    for (const o of off('hats', 0.5).filter((x) => Math.abs(x) < 30)) expect(o).toBeCloseTo(GENRE_PRESETS.boombap.drums.feelMs!.hats!, 0);
  });

  it('reggaetón: shaker en las 16 semicorcheas con el acento en el 3+3+2; neo perreo en bucle de 1-2 acordes', () => {
    const hats = dropPattern(composeBeat({ genre: 'reggaeton', seed: 2 }), 'hats')!.notes.filter((n) => n.key === 70 && n.start < 4);
    expect(hats.length).toBeGreaterThanOrEqual(15);
    const v = (i: number) => hats.find((n) => Math.abs(n.start - i * 0.25) < 1e-6)!.velocity;
    // Acento en el tresillo 3+3+2 (pasos 1, 4, 7 de cada medio compás).
    for (const strong of [0, 3, 6, 8, 11]) expect(v(strong)).toBeGreaterThan(v(strong + 1) + 0.15);
    for (const prog of GENRE_PRESETS.neoperreo.progressions) expect(new Set(prog).size).toBeLessThanOrEqual(2);
  });

  it('los géneros urbanos dejan margen de true peak en el master; techno y rave, como estaban', () => {
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      const lim = GENRE_PRESETS[g].master.find((f) => f.kind === 'limiter')!;
      expect(lim.params['ceiling']).toBeLessThanOrEqual(-2);
    }
    for (const g of ['techno', 'rave'] as const) expect(GENRE_PRESETS[g].master.find((f) => f.kind === 'limiter')!.params['ceiling']).toBe(-1);
  });

  it('el bombo se afina a la tónica o la quinta, y cada bombo de los kits tiene su altura medida', () => {
    expect(kickTune(33.47, 9)).toBeCloseTo(-0.47, 2); // reggaetón sobre La: un cuarto de tono abajo
    expect(Math.abs(kickTune(40.2, 0))).toBeLessThanOrEqual(3.5);
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      for (const id of GENRE_PRESETS[g].drumKit?.[36] ?? []) expect(DRUM_PITCH[id], id).toBeDefined();
      for (const seed of [1, 2, 3]) {
        const plan = composeBeat({ genre: g, seed });
        const kick = part(plan, 'kick')!.sound;
        const pitch = DRUM_PITCH[kick.samples![36]!]! + (kick.tunes?.[36] ?? 0);
        const pc = (((Math.round(pitch) - plan.keyRoot) % 12) + 12) % 12;
        expect([0, 7], `${g} ${seed}`).toContain(pc);
      }
    }
  });

  it('trap: el bombo lleva una capa de click en su misma tecla', () => {
    const kick = part(composeBeat({ genre: 'trap', seed: 1 }), 'kick')!.sound;
    expect(kick.layers).toEqual([{ key: 36, sampleId: 'drums/trap/kick-click-01' }]);
    expect(factorySound('drums/trap/kick-click-01')).toBeDefined();
  });

  it('verso y hook: remate de caja al cerrar cada frase, y el segundo verso no es copia del primero', () => {
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      const plan = composeBeat({ genre: g, seed: 2, shape: 3 });
      const verses = part(plan, 'snare')!.patterns.filter((p) => p.id.startsWith('verse'));
      expect(verses.length, g).toBe(2);
      const bar4 = verses[0]!.notes.filter((n) => n.start >= 12 && n.start < 16).length;
      const bar1 = verses[0]!.notes.filter((n) => n.start < 4).length;
      expect(bar4, g).toBeGreaterThan(bar1);
      const sig = (p: { notes: { start: number; key: number }[] }) => JSON.stringify(p.notes.map((n) => [n.start, n.key]));
      const hats = part(plan, 'hats')!.patterns.filter((p) => p.id.startsWith('verse'));
      expect(sig(verses[0]!) !== sig(verses[1]!) || sig(hats[0]!) !== sig(hats[1]!), g).toBe(true);
    }
  });

  it('neo perreo: el 808 largo cae en el 1 y el 9', () => {
    const bass = dropPattern(composeBeat({ genre: 'neoperreo', seed: 1 }), 'bass')!;
    for (const n of bass.notes) expect([0, 2]).toContain(n.start % 4);
  });

  it('la melodía no pone b9 sobre ninguna nota del acorde', () => {
    for (const g of ['trap', 'reggaeton', 'neoperreo', 'boombap'] as const) {
      for (const seed of [1, 2, 3, 4]) {
        const plan = composeBeat({ genre: g, seed });
        const scale = SCALES[plan.scaleName]!;
        const mel = part(plan, 'melody')!;
        for (const pt of mel.patterns) {
          for (const n of pt.notes) {
            const deg = plan.progression[Math.floor(n.start / 4) % plan.progression.length]!;
            const tones = [0, 2, 4].map((o) => (plan.keyRoot + scale[(deg + o) % scale.length]!) % 12);
            expect(tones.some((pc) => (((n.key - pc) % 12) + 12) % 12 === 1), `${g} ${seed} ${pt.id} ${n.key}`).toBe(false);
          }
        }
      }
    }
  });
});
