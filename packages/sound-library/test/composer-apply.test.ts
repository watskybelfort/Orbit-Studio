import { describe, expect, it } from 'vitest';
import { ProjectStore, createEmptyProject } from '@orbit/core';
import { composeBeat, factoryInstrument, planToCommands, recomposePart, replacePartCommands, type BeatPlan } from '../src';

const part = (plan: BeatPlan, role: string) => plan.parts.find((p) => p.role === role);

describe('plan → proyecto', () => {
  it('monta el beat con cada parte en su canal, patrones y pista, en un solo undo', () => {
    const store = new ProjectStore();
    const before = JSON.stringify(store.project);
    const plan = composeBeat({ genre: 'reggaeton', seed: 2 });
    const { commands, applied } = planToCommands(store.project, plan);
    store.dispatch({ type: 'batch', label: 'Componer beat', commands }, { label: 'Componer beat' });
    const p = store.project;
    expect(p.tempo).toBe(plan.bpm);
    expect(applied.parts).toHaveLength(plan.parts.length);
    const channelIds = new Set(applied.parts.map((a) => a.channelId));
    expect(channelIds.size).toBe(plan.parts.length);
    const trackIds = new Set(applied.parts.map((a) => a.playlistTrackId));
    expect(trackIds.size).toBe(plan.parts.length);
    for (const a of applied.parts) {
      const planPart = plan.parts.find((x) => x.role === a.role)!;
      expect(p.channels[a.channelId]!.name).toBe(planPart.name);
      for (const [key, id] of Object.entries(a.patterns)) {
        const planPattern = planPart.patterns.find((x) => x.id === key)!;
        expect(p.patterns[id]!.notes[a.channelId]!.length).toBe(planPattern.notes.length);
        // Un patrón por parte: nada mezclado en otro canal.
        expect(Object.keys(p.patterns[id]!.notes)).toEqual([a.channelId]);
      }
      const clips = Object.values(p.clips).filter((c) => c.playlistTrackId === a.playlistTrackId);
      expect(clips.length).toBe(planPart.clips.length);
    }
    expect(Object.values(p.sections ?? {}).length).toBe(plan.sections.length);
    expect(p.mixer[0]!.slots.some((s) => s?.kind === 'limiter')).toBe(true);
    store.undo();
    expect(JSON.stringify(store.project)).toBe(before);
  });

  it('un segundo beat va detrás del primero, sin pisarlo ni duplicar limitador', () => {
    const store = new ProjectStore(createEmptyProject());
    const first = composeBeat({ genre: 'techno', seed: 1, shape: 'loop', loopBars: 8 });
    store.dispatch({ type: 'batch', commands: planToCommands(store.project, first).commands });
    const second = composeBeat({ genre: 'rave', seed: 1, shape: 'loop', loopBars: 4 });
    const { commands, applied } = planToCommands(store.project, second);
    expect(applied.startBar).toBe(8);
    store.dispatch({ type: 'batch', commands });
    expect(store.project.mixer[0]!.slots.filter((s) => s?.kind === 'limiter')).toHaveLength(1);
  });

  it('recompone una parte en su sitio: mismas claves de patrón, notas nuevas', () => {
    const store = new ProjectStore();
    const plan = composeBeat({ genre: 'trap', seed: 5 });
    const { commands, applied } = planToCommands(store.project, plan);
    store.dispatch({ type: 'batch', commands });
    const fresh = recomposePart(plan, 'melody', 99)!;
    expect(fresh.patterns.map((p) => p.id)).toEqual(part(plan, 'melody')!.patterns.map((p) => p.id));
    const a = applied.parts.find((x) => x.role === 'melody')!;
    const id = Object.values(a.patterns)[0]!;
    const old = JSON.stringify(store.project.patterns[id]!.notes[a.channelId]!.map((n) => [n.start, n.key]));
    store.dispatch({ type: 'batch', commands: replacePartCommands(store.project, a, fresh, { sound: true }) });
    const now = JSON.stringify(store.project.patterns[id]!.notes[a.channelId]!.map((n) => [n.start, n.key]));
    expect(now).not.toBe(old);
  });
});

describe('batería sampleada en el proyecto', () => {
  it('registra cada sample de fábrica una vez, lo devuelve para el motor y el canal toca por keymap', () => {
    const store = new ProjectStore();
    const plan = composeBeat({ genre: 'reggaeton', seed: 3 });
    const { commands, applied, samples } = planToCommands(store.project, plan);
    const registered = commands.filter((c) => c.type === 'registerSample');
    expect(registered.length).toBe(samples.length);
    expect(new Set(samples.map((s) => s.id)).size).toBe(samples.length);
    for (const s of samples) expect(s.path).toMatch(/^factory:.+\.wav$/);
    store.dispatch({ type: 'batch', commands });
    const kick = applied.parts.find((a) => a.role === 'kick')!;
    const ch = store.project.channels[kick.channelId]!;
    expect(ch.kind).toBe('sampler');
    expect(ch.keymap![0]).toMatchObject({ keyLow: 36, keyHigh: 36, keyRoot: 36 });
    expect(store.project.samples[ch.keymap![0]!.sampleId]).toBeDefined();
    // Un segundo beat del mismo género no vuelve a registrar lo que ya está.
    const again = planToCommands(store.project, composeBeat({ genre: 'reggaeton', seed: 3 }));
    expect(again.samples).toHaveLength(0);
    expect(again.commands.some((c) => c.type === 'registerSample')).toBe(false);
    store.dispatch({ type: 'batch', commands: again.commands });
  });
});

describe('instrumentos grabados de fábrica en el proyecto', () => {
  it('un instrumento multisampleado entra con todas sus tomas y el teclado repartido como en el browser', () => {
    const store = new ProjectStore();
    // Boom bap: acordes de Rhodes, piano o piano de cinta según la semilla; se busca una con sampler.
    let plan = composeBeat({ genre: 'boombap', seed: 1 });
    for (let seed = 1; seed < 40 && !plan.parts.some((p) => p.sound.zones); seed++) plan = composeBeat({ genre: 'boombap', seed });
    const inst = plan.parts.find((p) => p.sound.zones)!;
    expect(inst).toBeDefined();
    const takes = factoryInstrument(inst.sound.zones![0]!.sampleId.replace(/-\d+(-p+)?$|-p+$/, ''))!;
    expect(takes.length).toBe(inst.sound.zones!.length);
    const { commands, applied, samples } = planToCommands(store.project, plan);
    for (const z of inst.sound.zones!) expect(samples.some((s) => s.id === z.sampleId)).toBe(true);
    store.dispatch({ type: 'batch', commands });
    const ch = store.project.channels[applied.parts.find((a) => a.role === inst.role)!.channelId]!;
    expect(ch.kind).toBe('sampler');
    // Cubre el teclado entero, sin huecos: cualquier nota de la parte suena.
    const keymap = ch.keymap!;
    for (const pt of inst.patterns) {
      for (const n of pt.notes) {
        expect(keymap.some((z) => n.key >= z.keyLow && n.key <= z.keyHigh && n.velocity >= z.velLow && n.velocity <= z.velHigh), `tecla ${n.key}`).toBe(true);
      }
    }
    for (const z of keymap) expect(store.project.samples[z.sampleId], z.sampleId).toBeDefined();
  });
});

describe('sidechain del bajo al bombo', () => {
  it('el compresor del 808 escucha la pista de mixer del bombo', () => {
    for (const genre of ['trap', 'reggaeton'] as const) {
      const store = new ProjectStore();
      const { commands, applied } = planToCommands(store.project, composeBeat({ genre, seed: 1 }));
      store.dispatch({ type: 'batch', commands });
      const kick = applied.parts.find((a) => a.role === 'kick')!;
      const bass = applied.parts.find((a) => a.role === 'bass')!;
      expect(kick.mixerTrack).toBeGreaterThan(0);
      const slots = store.project.channels[bass.channelId]!.fx ?? [];
      const comp = slots.find((sl) => sl?.kind === 'compressor');
      expect(comp, genre).toBeDefined();
      expect(comp!.sidechainSource, genre).toBe(kick.mixerTrack);
    }
  });
});

