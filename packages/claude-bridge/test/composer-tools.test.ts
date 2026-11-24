import { describe, expect, it } from 'vitest';
import { ProjectStore, createPattern } from '@orbit/core';
import type { StyleProfile, TrackFeatures } from '@orbit/sound-library';
import { TOOLS, ToolExecutor, parseKeyRoot, parseScale, type ComposerHost } from '../src';

function features(name: string, bpm: number): TrackFeatures {
  const lane = (hits: number[]) => Array.from({ length: 16 }, (_, i) => (hits.includes(i) ? 0.9 : 0.02));
  return {
    name,
    durationSec: 90,
    bpm,
    bpmConfidence: 0.8,
    keyRoot: 6,
    keyMode: 'minor',
    keyConfidence: 0.7,
    swing: 0.05,
    lanes: { low: lane([0, 4, 8, 12]), mid: lane([3, 6, 11, 14]), high: lane([0, 2, 4, 6, 8, 10, 12, 14]) },
    density: { low: 4, mid: 4, high: 8 },
    brightness: 0.4,
    grit: 0.8,
  };
}

function setup() {
  const store = new ProjectStore();
  const profiles: StyleProfile[] = [];
  const measured: string[] = [];
  const host: ComposerHost = {
    listProfiles: async () => profiles,
    saveProfile: async (p) => {
      const i = profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) profiles[i] = p;
      else profiles.push(p);
    },
    analyzeSample: async (ref) => {
      measured.push(ref);
      if (ref === 'silencio') return { name: 'silencio', features: null };
      return { name: ref, features: features(ref, ref.includes('rave') ? 156 : 97) };
    },
  };
  const executor = new ToolExecutor(store, undefined, undefined, undefined, undefined, undefined, host);
  return { store, executor, profiles, measured };
}

describe('esquemas', () => {
  it('cada tool nueva está anunciada y el executor la conoce', async () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ['list_genres', 'compose_beat', 'recompose_part', 'list_style_profiles', 'learn_style', 'analyze_reference', 'compose_from_reference', 'riff', 'transform_notes', 'delete_channel', 'delete_pattern', 'sections']) {
      expect(names).toContain(n);
    }
    expect(new Set(names).size).toBe(names.length);
    const { executor } = setup();
    // Ninguna tool anunciada cae en «desconocida».
    for (const n of names) {
      await executor.execute(n, {}).catch((e: Error) => expect(e.message).not.toMatch(/Tool desconocida/));
    }
  });
});

describe('parseKeyRoot / parseScale', () => {
  it('entiende nombres de nota y atajos de escala', () => {
    expect(parseKeyRoot('F#')).toBe(6);
    expect(parseKeyRoot('Bb')).toBe(10);
    expect(parseKeyRoot('cb')).toBe(11);
    expect(parseKeyRoot(3)).toBe(3);
    expect(parseKeyRoot(undefined)).toBeUndefined();
    expect(() => parseKeyRoot('H')).toThrow();
    expect(parseScale('minor')).toBe('Menor natural');
    expect(parseScale('frigio')).toBe('Frigio');
    expect(() => parseScale('lidio')).toThrow(/desconocida/);
  });
});

describe('compose_beat', () => {
  it('monta un beat con las partes separadas, como UN paso de undo de Claude', async () => {
    const { store, executor } = setup();
    const before = JSON.stringify(store.project);
    const text = (await executor.execute('compose_beat', { genre: 'neoperreo', seed: 3, key: 'F#', scale: 'Frigio', bpm: 98 })).text;
    expect(text).toMatch(/Neo perreo · 98 BPM · F# Frigio/);
    expect(store.project.tempo).toBe(98);
    expect(store.project.channelOrder.length).toBeGreaterThanOrEqual(8);
    expect(store.history.at(-1)?.origin).toBe('claude');
    store.undo('claude');
    expect(JSON.stringify(store.project)).toBe(before);
  });

  it('dryRun describe sin tocar nada', async () => {
    const { store, executor } = setup();
    const before = JSON.stringify(store.project);
    const text = (await executor.execute('compose_beat', { genre: 'trap', seed: 1, dryRun: true })).text;
    expect(text).toMatch(/^PLAN \(sin aplicar\)/);
    expect(JSON.stringify(store.project)).toBe(before);
  });

  it('solo las partes pedidas, en bucle', async () => {
    const { store, executor } = setup();
    await executor.execute('compose_beat', { genre: 'techno', seed: 2, parts: ['kick', 'bass'], shape: 'loop', loopBars: 4 });
    const names = store.project.channelOrder.map((id) => store.project.channels[id]!.name);
    expect(names).toContain('Bombo');
    expect(names).toContain('Bajo');
    expect(names).not.toContain('Melodía');
  });

  it('rechaza lo que no tiene sentido con un mensaje claro', async () => {
    const { executor } = setup();
    await expect(executor.execute('compose_beat', { genre: 'polka' })).rejects.toThrow(/genre/);
    await expect(executor.execute('compose_beat', { genre: 'trap', parts: ['voz'] })).rejects.toThrow(/parte/);
    await expect(executor.execute('compose_beat', { genre: 'trap', progression: [9] })).rejects.toThrow(/progression/);
    await expect(executor.execute('compose_beat', { genre: 'trap', bpm: 900 })).rejects.toThrow();
    await expect(executor.execute('compose_beat', { genre: 'trap', profile: 'no-existe' })).rejects.toThrow(/perfil/);
  });
});

describe('recompose_part', () => {
  it('cambia solo la parte pedida', async () => {
    const { store, executor } = setup();
    await executor.execute('compose_beat', { genre: 'trap', seed: 4 });
    const p = store.project;
    const kick = p.channelOrder.find((id) => p.channels[id]!.name === 'Bombo')!;
    const mel = p.channelOrder.find((id) => p.channels[id]!.name === 'Melodía')!;
    const snapshot = (id: string) =>
      JSON.stringify(Object.values(store.project.patterns).map((pt) => (pt.notes[id] ?? []).map((n) => [n.start, n.key])));
    const kickBefore = snapshot(kick);
    const melBefore = snapshot(mel);
    const text = (await executor.execute('recompose_part', { part: 'melody', seed: 777 })).text;
    expect(text).toMatch(/Melodía recompuesta con semilla 777/);
    expect(snapshot(kick)).toBe(kickBefore);
    expect(snapshot(mel)).not.toBe(melBefore);
  });

  it('sin beat previo, lo dice', async () => {
    const { executor } = setup();
    await expect(executor.execute('recompose_part', { part: 'melody' })).rejects.toThrow(/compose_beat/);
  });
});

describe('perfiles y referencias', () => {
  it('learn_style crea el perfil, compose_beat lo usa y list_style_profiles lo cuenta', async () => {
    const { store, executor, profiles } = setup();
    const learned = (await executor.execute('learn_style', { samples: ['beat-a', 'beat-b', 'silencio'], name: 'Mis beats' })).text;
    expect(learned).toMatch(/Perfil creado/);
    expect(learned).toMatch(/Sin datos: silencio/);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.tracks).toHaveLength(2);
    const text = (await executor.execute('compose_beat', { genre: 'reggaeton', seed: 1, profile: 'Mis beats', influence: 1 })).text;
    expect(text).toMatch(/Estilo «Mis beats»: 2 pistas/);
    expect(store.project.tempo).toBe(97);
    expect((await executor.execute('list_style_profiles', {})).text).toMatch(/Mis beats/);
    // Ampliar el mismo perfil.
    await executor.execute('learn_style', { samples: ['beat-c'], profile: 'Mis beats' });
    expect(profiles[0]!.tracks).toHaveLength(3);
  });

  it('analyze_reference cuenta sin cambiar; compose_from_reference monta con su temática', async () => {
    const { store, executor } = setup();
    const before = JSON.stringify(store.project);
    const text = (await executor.execute('analyze_reference', { sample: 'mi-referencia' })).text;
    expect(text).toMatch(/97 BPM/);
    expect(text).toMatch(/F# menor/);
    expect(JSON.stringify(store.project)).toBe(before);
    const composed = (await executor.execute('compose_from_reference', { sample: 'mi-referencia', seed: 5 })).text;
    expect(composed).toMatch(/Reggaetón|Neo perreo/);
    expect(composed).toMatch(/influencia 0.7/);
    expect(store.project.tempo).toBe(97);
  });

  it('acota cuántos audios se miden de una vez', async () => {
    const { executor, measured } = setup();
    await expect(executor.execute('learn_style', { samples: Array.from({ length: 33 }, (_, i) => `s${i}`) })).rejects.toThrow(/1 a 32/);
    expect(measured).toHaveLength(0);
  });

  it('sin host (MCP sin app), las tools de audio lo explican', async () => {
    const executor = new ToolExecutor(new ProjectStore());
    await expect(executor.execute('learn_style', { samples: ['a'] })).rejects.toThrow(/app abierta/);
    // Componer no necesita host.
    await expect(executor.execute('compose_beat', { genre: 'rave', seed: 1, shape: 'loop' })).resolves.toBeTruthy();
  });
});

describe('edición', () => {
  function withChannel() {
    const s = setup();
    const p = s.store.project;
    return { ...s, patternId: p.patternOrder[0]! };
  }

  it('riff + transform_notes (transpose, chordify, humanize) en un paso cada uno', async () => {
    const { store, executor, patternId } = withChannel();
    await executor.execute('add_channel', { kind: 'nova', name: 'Lead' });
    const ch = store.project.channelOrder.find((id) => store.project.channels[id]!.name === 'Lead')!;
    const r = (await executor.execute('riff', { patternId, channelId: 'Lead', key: 'A', scale: 'minor', bars: 2, seed: 9 })).text;
    expect(r).toMatch(/Riff de \d+ notas/);
    const notes = () => store.project.patterns[patternId]!.notes[ch]!;
    const n0 = notes().length;
    const keys0 = notes().map((n) => n.key);
    await executor.execute('transform_notes', { patternId, channelId: ch, op: 'transpose', amount: 12 });
    expect(notes().map((n) => n.key).sort()).toEqual(keys0.map((k) => k + 12).sort());
    await executor.execute('transform_notes', { patternId, channelId: ch, op: 'chordify', intervals: [0, 3, 7] });
    expect(notes().length).toBeGreaterThan(n0);
    const h = store.history.length;
    await executor.execute('transform_notes', { patternId, channelId: ch, op: 'humanize', amount: 0.02, seed: 2 });
    expect(store.history.length).toBe(h + 1);
    await expect(executor.execute('transform_notes', { patternId, channelId: ch, op: 'magia' })).rejects.toThrow(/op:/);
  });

  it('delete_channel, delete_pattern y sections', async () => {
    const { store, executor } = withChannel();
    await executor.execute('add_channel', { kind: 'synth', name: 'Borrable' });
    await executor.execute('delete_channel', { channelId: 'Borrable' });
    expect(Object.values(store.project.channels).some((c) => c.name === 'Borrable')).toBe(false);
    await expect(executor.execute('delete_pattern', { patternId: store.project.patternOrder[0]! })).rejects.toThrow(/último/);
    store.dispatch({ type: 'addPattern', pattern: createPattern(1, 'Extra') });
    await executor.execute('delete_pattern', { patternId: 'Extra' });
    expect(Object.values(store.project.patterns).some((p) => p.name === 'Extra')).toBe(false);
    await executor.execute('sections', { action: 'add', name: 'Drop', startBar: 8, bars: 8, kind: 'drop' });
    expect((await executor.execute('sections', { action: 'list' })).text).toMatch(/"Drop" \(drop\).*compás 8–16/);
    await executor.execute('sections', { action: 'remove', sectionId: 'drop' });
    expect((await executor.execute('sections', { action: 'list' })).text).toMatch(/no tiene secciones/);
  });
});
