import { describe, expect, it } from 'vitest';
import { createEmptyProject, ProjectStore, type Clip, type ParamRef } from '@orbit/core';
import { compileProject, renderProject, type SampleData } from '@orbit/engine';
import { sliceAutomationCurve } from '../src/editors/automation/slice-curve';
import { readSource } from './read-source';

function fixture(tension: number, tempo = false) {
  const project = createEmptyProject('Curva cortada');
  project.tempo = 120;
  const lane = Object.keys(project.playlistTracks)[0]!;
  const target: ParamRef = tempo ? { kind: 'transport', param: 'tempo' }
    : { kind: 'mixer', trackIndex: 0, param: 'volume' };
  project.clips.curve = {
    id: 'curve', kind: 'automation', playlistTrackId: lane, start: 0.37, length: 4.13,
    muted: false, target,
    points: [
      { id: 'a', time: -0.4, value: 0.15, tension },
      { id: 'b', time: 2.3, value: 0.75, tension: -tension },
      { id: 'c', time: 5, value: 0.4, tension: 0 },
    ],
  };
  project.samples.tone = {id: 'tone', name: 'tone', path: 'qa:tone', hash: 'tone', duration: 8};
  project.clips.audio = {
    id: 'audio', kind: 'audio', playlistTrackId: lane, start: 0, length: 8,
    muted: false, sampleId: 'tone', audioGain: 0.2,
  };
  const pcm = new Float32Array(8 * 8000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 220 * i / 8000);
  const samples = new Map<string, SampleData>([['tone', {left: pcm, right: pcm, rate: 8000}]]);
  return {store: new ProjectStore(project), samples};
}

function cut(store: ProjectStore, id: string, at: number, nextId = 'tail') {
  const clip = store.project.clips[id]!;
  const headLength = at - clip.start;
  const {head, tail} = sliceAutomationCurve(clip, headLength);
  const second: Clip = {...clip, ...tail, id: nextId, start: at, length: clip.length - headLength};
  store.dispatch({ type: 'batch', label: 'Cortar clip', commands: [
    {type: 'patchClips', patches: [{id, length: headLength, ...head}]},
    {type: 'addClips', clips: [second]},
  ]});
}

function render(f: ReturnType<typeof fixture>) {
  return renderProject(compileProject(f.store.project, {mode: 'song'}), {
    sampleRate: 8000, tailSeconds: 0, samples: f.samples,
  }).left;
}

function difference(a: Float32Array, b: Float32Array) {
  expect(b.length).toBe(a.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
  return max;
}

describe('041: cortar conserva la curva audible y sus anclas', () => {
  for (const tension of [-1, 0, 0.7]) {
    for (const cutAt of [2.37, 1.137]) {
      it(`tensión ${tension}, corte ${cutAt}, incluidos puntos fuera de rango`, () => {
        const f = fixture(tension);
        const before = render(f);
        const pointsBefore = JSON.stringify(f.store.project.clips.curve!.points);
        cut(f.store, 'curve', cutAt);
        expect(difference(before, render(f))).toBeLessThan(1e-7);
        expect(JSON.stringify(f.store.project.clips.curve!.points)).toBe(pointsBefore);
        expect(f.store.project.clips.tail!.points![0]!.time).toBeLessThan(0);
      });
    }
  }
  it('cortes repetidos conservan el origen, incluso después de JSON', () => {
    const f = fixture(-0.8);
    const before = render(f);
    cut(f.store, 'curve', 1.137);
    cut(f.store, 'tail', 2.513, 'tail2');
    f.store.replaceProject(JSON.parse(JSON.stringify(f.store.project)));
    expect(difference(before, render(f))).toBeLessThan(1e-7);
  });
  it('deshacer y rehacer dejan el audio original', () => {
    const f = fixture(1);
    const before = render(f);
    cut(f.store, 'curve', 1.137);
    f.store.undo();
    expect(Object.keys(f.store.project.clips)).toHaveLength(2);
    expect(difference(before, render(f))).toBeLessThan(1e-7);
    f.store.redo();
    expect(difference(before, render(f))).toBeLessThan(1e-7);
  });
  it('una ventana de tempo mantiene la integral y no empieza antes del corte', () => {
    const f = fixture(0.7, true);
    const before = render(f);
    cut(f.store, 'curve', 1.137);
    expect(difference(before, render(f))).toBeLessThan(1e-6);
  });
  it('el gesto real usa el reparto para las dos piezas', () => {
    const source = readSource('editors/playlist/Playlist.tsx');
    expect(source).toContain('sliceAutomationCurve(clip, firstLen)');
    expect(source).toContain('Object.assign(second, curve.tail)');
    expect(source).toContain('...curveHead');
  });
});
