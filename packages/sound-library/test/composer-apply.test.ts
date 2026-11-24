import { describe, expect, it } from 'vitest';
import { ProjectStore, createEmptyProject } from '@orbit/core';
import { composeBeat, planToCommands, recomposePart, replacePartCommands, type BeatPlan } from '../src';

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
