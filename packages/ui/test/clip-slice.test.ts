/**
 * Cortar/trocear clips de audio con time-stretch.
 *
 * Los dos bugs que cubre: la cola de un corte arrancaba en tiempo real
 * (`offset + firstLen × secPerBeat`) cuando el motor llena el clip con toda la
 * fuente restante (`ratio = srcSec/clipSec`), y los beats se pasaban a segundos
 * con `project.tempo` ignorando el mapa de tempo. Aquí están la aritmética
 * pura, su consistencia con el mapa que compila el motor, y un render OFFLINE
 * de verdad para medir dónde queda leyendo cada pieza.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createEmptyProject,
  ProjectStore,
  type Clip,
  type Marker,
  type Project,
} from '@orbit/core';
import { compileProject, renderProject, type SampleData } from '@orbit/engine';
import {
  naturalRatePieces,
  outputSpanForSource,
  projectTempoMap,
  slicedTailOffset,
  sliceAudioWindow,
  trimAudioWindow,
  sourceSpanForOutput,
} from '../src/editors/clip-slice';
import { readSource } from './read-source';

const SR = 44100;

/** Rampa de `seconds` segundos: el valor ES la posición normalizada. */
function ramp(seconds: number): SampleData {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = i / n;
  return { left, right: left.slice(), rate: SR };
}

/** Proyecto con una rampa y un clip de audio (2 beats por defecto). */
function rampProject(opts: {
  tempo?: number;
  markers?: Marker[];
  seconds?: number;
  offset?: number;
  stretch?: boolean;
  length?: number;
} = {}): { project: Project; samples: Map<string, SampleData> } {
  const project = createEmptyProject('Corte');
  project.tempo = opts.tempo ?? 120;
  for (const m of opts.markers ?? []) project.markers[m.id] = m;
  const trackId = Object.values(project.playlistTracks).find(
    (t) => t.arrangementId === project.activeArrangementId,
  )!.id;
  const seconds = opts.seconds ?? 2;
  applyCommand(project, {
    type: 'registerSample',
    sample: { id: 'ramp', name: 'ramp', path: 'qa:ramp', hash: 'h', duration: seconds },
  });
  applyCommand(project, {
    type: 'addClips',
    clips: [
      {
        id: 'clip',
        kind: 'audio',
        playlistTrackId: trackId,
        start: 0,
        length: opts.length ?? 2,
        muted: false,
        sampleId: 'ramp',
        audioOffset: opts.offset ?? 0,
        audioStretch: opts.stretch ?? true,
      },
    ],
  });
  return { project, samples: new Map([['ramp', ramp(seconds)]]) };
}

/** El mismo corte que despacha `Playlist.sliceClip`, con el helper compartido. */
function cutPlaylistClip(project: Project, cut: number, id = 'clip', tailId = 'cola'): ProjectStore {
  const clip = project.clips[id]!;
  const firstLen = cut - clip.start;
  const second: Clip = { ...clip, id: tailId, start: cut, length: clip.length - firstLen };
  const sample = clip.sampleId ? project.samples[clip.sampleId] : undefined;
  const {head, tail} = sliceAudioWindow(clip, cut, {
    offset: clip.audioOffset ?? 0,
    sampleDuration: sample?.duration ?? 0,
    sourceLength: clip.audioSourceLength,
    stretch: clip.audioStretch === true,
    tempoMap: projectTempoMap(Object.values(project.markers), project.tempo),
    fallbackTempo: project.tempo,
  });
  Object.assign(second, tail);
  second.fadeIn = 0;
  second.fadeOut = 0;
  const store = new ProjectStore(project);
  store.dispatch({
    type: 'batch',
    label: 'Cortar clip',
    commands: [
      { type: 'patchClips', patches: [{ id: clip.id, length: firstLen, fadeIn: 0, fadeOut: 0, ...head }] },
      { type: 'addClips', clips: [second] },
    ],
  });
  return store;
}

/** Render de solo esos clips, para medir la pieza sin la otra de fondo. */
function renderOnly(project: Project, clipIds: string[], samples: Map<string, SampleData>) {
  const compiled = compileProject(project, { mode: 'song', clipIds });
  return renderProject(compiled, { samples, tailSeconds: 0, sampleRate: SR });
}

describe('aritmética del reparto con stretch', () => {
  it('sin stretch el tramo de salida se lee a tiempo real', () => {
    expect(sourceSpanForOutput(0.5, 1, 2, false)).toBe(0.5);
    expect(outputSpanForSource(1, 2, 1, false)).toBe(1);
  });

  it('con stretch cada tramo se lleva su parte proporcional de fuente', () => {
    // Rampa de 2 s en un clip de 1 s: la mitad de salida = 1 s de fuente.
    expect(sourceSpanForOutput(0.5, 1, 2, true)).toBe(1);
    expect(sourceSpanForOutput(0.25, 1, 2, true)).toBe(0.5);
    // Y la inversa.
    expect(outputSpanForSource(1, 2, 1, true)).toBe(0.5);
  });

  it('sin fuente o sin largo no se inventa un ratio', () => {
    expect(sourceSpanForOutput(0.5, 1, 0, true)).toBe(0.5);
    expect(sourceSpanForOutput(0.5, 0, 2, true)).toBe(0.5);
  });
});

describe('el mapa de tempo de la UI es el que compila el motor', () => {
  it('coincide con compileProject con marcadores, repetidos y en el beat 0', () => {
    const { project } = rampProject({
      tempo: 120,
      markers: [
        { id: 'm1', time: 1, name: 'A', color: '#fff', tempo: 60 },
        { id: 'm2', time: 4, name: 'B', color: '#fff', tempo: 60 }, // repetido: se salta
        { id: 'm3', time: 8, name: 'C', color: '#fff', tempo: 140 },
        { id: 'm0', time: 0, name: 'Inicio', color: '#fff', tempo: 100 }, // redefine el 0
      ],
    });
    expect(projectTempoMap(Object.values(project.markers), project.tempo)).toEqual(
      compileProject(project, { mode: 'song' }).tempoMap,
    );
  });
});

describe('slicedTailOffset', () => {
  it('el caso medido: rampa 2 s, clip de 1 s con stretch, corte por la mitad → 0.5 del sample', () => {
    const { project } = rampProject({ tempo: 120 });
    const offset = slicedTailOffset(0, 2, 1, {
      offset: 0,
      sampleDuration: 2,
      stretch: true,
      tempoMap: projectTempoMap(Object.values(project.markers), project.tempo),
      fallbackTempo: project.tempo,
    });
    expect(offset).toBe(1);
  });

  it('sin stretch la cola arranca en tiempo real', () => {
    const offset = slicedTailOffset(0, 2, 1, {
      offset: 0,
      sampleDuration: 2,
      stretch: false,
      tempoMap: [],
      fallbackTempo: 120,
    });
    expect(offset).toBe(0.5);
  });

  it('integra el mapa de tempo: un marcador a mitad cambia los segundos de la cabeza', () => {
    const { project } = rampProject({
      tempo: 120,
      markers: [{ id: 'm1', time: 1, name: 'Lento', color: '#fff', tempo: 60 }],
    });
    const ctx = {
      offset: 0,
      sampleDuration: 2,
      stretch: true,
      tempoMap: projectTempoMap(Object.values(project.markers), project.tempo),
      fallbackTempo: project.tempo,
    };
    // clip de 2 beats: 0→1 a 120 (0.5 s) + 1→2 a 60 (1 s) = 1.5 s de salida.
    // La cabeza (0→1 beat) son 0.5 s = 1/3 del clip → 2/3 del sample.
    expect(slicedTailOffset(0, 2, 1, ctx)).toBeCloseTo(2 / 3, 10);
    // El cálculo viejo (tempo plano) daría 0.5.
    expect(slicedTailOffset(0, 2, 1, ctx)).not.toBeCloseTo(0.5, 3);
  });

  it('respeta el offset de fuente del clip', () => {
    const offset = slicedTailOffset(0, 2, 1, {
      offset: 1,
      sampleDuration: 2,
      stretch: true,
      tempoMap: [],
      fallbackTempo: 120,
    });
    // La fuente disponible es 1 s (de 1 a 2) y la cabeza se lleva la mitad.
    expect(offset).toBe(1.5);
  });
});

describe('render real del corte (Playlist)', () => {
  it('la cola arranca a la mitad del sample, no a un cuarto', () => {
    const { project, samples } = rampProject({ tempo: 120 });
    cutPlaylistClip(project, 1);
    expect(project.clips['cola']!.audioOffset).toBe(1);

    const res = renderOnly(project, ['cola'], samples);
    // La cola ocupa el beat 1 (0.5 s) + 0.5 s de largo: ratio 2, o sea que en
    // el segundo 0.55 del timeline lee la fuente 1.1 → 0.55 de la rampa.
    const at = (sec: number) => res.left[Math.round(sec * SR)]!;
    expect(at(0.55)).toBeGreaterThan(0.5);
    expect(at(0.55)).toBeLessThan(0.62);
    // Y más adelante sigue subiendo: en 0.9 s lee 1.8 → 0.9.
    expect(at(0.9)).toBeGreaterThan(0.85);
    // Antes del corte, silencio: la cola empieza en el beat 1.
    expect(Math.abs(at(0.3))).toBeLessThan(1e-6);
  });

  it('el mismo clip sin cortar lee su segunda mitad igual que la cola', () => {
    const { project, samples } = rampProject({ tempo: 120 });
    const original = renderOnly(project, ['clip'], samples).left;
    const at = (xs: Float32Array, sec: number) => xs[Math.round(sec * SR)]!;
    // La cola arranca donde el original iba por la mitad de la fuente (1 s).
    cutPlaylistClip(project, 1);
    const cola = renderOnly(project, ['cola'], samples).left;
    // En la ventana de la cola los dos leen la misma zona; los grains van en
    // otra fase, así que se compara con margen y no muestra a muestra.
    expect(Math.abs(at(cola, 0.6) - at(original, 0.6))).toBeLessThan(0.05);
    expect(Math.abs(at(cola, 0.8) - at(original, 0.8))).toBeLessThan(0.05);
  });
});

describe('trocear con stretch (AudioEditor)', () => {
  it('las piezas son contiguas y a velocidad natural', () => {
    expect(naturalRatePieces(0, 2, [0.5, 1.5])).toEqual([
      { offset: 0, at: 0, seconds: 0.5 },
      { offset: 0.5, at: 0.5, seconds: 1 },
      { offset: 1.5, at: 1.5, seconds: 0.5 },
    ]);
  });

  it('ignora los cortes pegados a los bordes y sin cortes no hay piezas', () => {
    expect(naturalRatePieces(0, 2, [0.005, 1.995, 1])).toEqual([
      { offset: 0, at: 0, seconds: 1 },
      { offset: 1, at: 1, seconds: 1 },
    ]);
    expect(naturalRatePieces(0, 2, [])).toEqual([]);
  });

  it('una pieza natural lee su tramo, no lo que queda del sample', () => {
    const { project, samples } = rampProject({ tempo: 120 });
    const [primera, segunda] = naturalRatePieces(0, 2, [1]);
    const trackId = project.clips['clip']!.playlistTrackId;
    // Así construye AudioEditor.sliceClip sus clips: natural, sin stretch.
    applyCommand(project, { type: 'removeClips', clipIds: ['clip'] });
    for (const [i, p] of [primera!, segunda!].entries()) {
      applyCommand(project, {
        type: 'addClips',
        clips: [
          {
            id: `p${i}`,
            kind: 'audio',
            playlistTrackId: trackId,
            start: p.at / 0.5,
            length: p.seconds / 0.5,
            muted: false,
            sampleId: 'ramp',
            audioOffset: p.offset,
            audioStretch: false,
          },
        ],
      });
    }
    const res = renderOnly(project, ['p0'], samples);
    const at = (sec: number) => res.left[Math.round(sec * SR)]!;
    // A 0.25 s de timeline lee la fuente 0.25 → 0.125 de la rampa. Con el
    // stretch encendido habría leído 0.5 → 0.25.
    expect(at(0.25)).toBeGreaterThan(0.1);
    expect(at(0.25)).toBeLessThan(0.15);
  });
});

describe('los editores usan la aritmética compartida', () => {
  it('Playlist ya no calcula el offset con el tempo plano', () => {
    const src = readSource('editors/playlist/Playlist.tsx');
    expect(src).toContain('sliceAudioWindow(');
    expect(src).toContain('Object.assign(second, audio.tail)');
    expect(src).toContain('sliceHead = audio.head');
    expect(src).not.toContain('firstLen * (60 / project.tempo)');
  });

  it('AudioEditor hornea el stretch de las piezas y usa naturalRatePieces', () => {
    const src = readSource('editors/audio/AudioEditor.tsx');
    expect(src).toContain('naturalRatePieces(');
    expect(src).toContain('audioStretch: false');
  });
});

describe('042: el corte conserva toda la señal, incluida fase de grains', () => {
  it('las asas recortan la ventana de fuente sin cambiar su velocidad', () => {
    const {project} = rampProject({length: 4});
    cutPlaylistClip(project, 2);
    const tail = project.clips.cola!;
    const left = trimAudioWindow(tail, 1.25, 2, 1);
    expect(left).toMatchObject({audioOffset: 1.25, audioSourceLength: 0.75, audioGrainOffset: 1.25, length: 1.5});
    expect(trimAudioWindow(tail, 1, 1.5, 1)).toMatchObject({audioSourceLength: 0.5, audioGrainOffset: 1, length: 1});
    const editor = readSource('editors/audio/AudioEditor.tsx');
    expect(editor).toContain('clip.audioSourceLength ??');
    expect(editor).toContain('const to = Math.min(dur, offsetSec + clipSec)');
    expect(editor).toContain('trimAudioWindow(clip,');
  });
  function audible(opts: Parameters<typeof rampProject>[0], pitch = 0) {
    const f = rampProject(opts);
    f.project.clips.clip!.audioPitch = pitch;
    const data = f.samples.get('ramp')!;
    for (let i = 0; i < data.left.length; i++) {
      data.left[i] = (i < data.left.length / 2 ? 0.03 : 0.3) * Math.sin(i * 0.1);
      data.right[i] = data.left[i]!;
    }
    return f;
  }
  function all(f: ReturnType<typeof audible>) {
    return renderProject(compileProject(f.project, {mode: 'song'}), {
      sampleRate: SR, tailSeconds: 0, samples: f.samples,
    }).left;
  }
  function maxDiff(a: Float32Array, b: Float32Array) {
    expect(b.length).toBe(a.length);
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i]! - b[i]!));
    return max;
  }
  it.each([
    {length: 4, pitch: 0, cut: 2, stretch: true},
    {length: 2, pitch: 7, cut: 0.713, stretch: true},
    {length: 6, pitch: -5, cut: 2.513, stretch: true},
    {length: 4, pitch: 5, cut: 1.137, stretch: false},
    {length: 4, pitch: 0, cut: 1.137, stretch: false},
  ])('preserva cabeza y cola: %j', ({length, pitch, cut, stretch}) => {
    const f = audible({length, stretch, offset: 0.125}, pitch);
    const before = all(f);
    const store = cutPlaylistClip(f.project, cut);
    expect(maxDiff(before, all(f))).toBeLessThan(1e-6);
    store.undo();
    expect(maxDiff(before, all(f))).toBeLessThan(1e-6);
    store.redo();
    expect(maxDiff(before, all(f))).toBeLessThan(1e-6);
  });
  it('integra marcadores de tempo y un segundo corte de la cola', () => {
    const f = audible({length: 4, markers: [
      {id: 'slow', time: 1, tempo: 60, name: 'Lento', color: '#fff'},
    ]}, 3);
    const before = all(f);
    cutPlaylistClip(f.project, 1.137);
    cutPlaylistClip(f.project, 2.713, 'cola', 'cola2');
    expect(maxDiff(before, all(f))).toBeLessThan(1e-6);
    f.project = JSON.parse(JSON.stringify(f.project));
    expect(maxDiff(before, all(f))).toBeLessThan(1e-6);
  });
  it('un cambio uniforme de tempo mantiene la relación entre las piezas', () => {
    const f = audible({length: 4}, 7);
    const original = JSON.parse(JSON.stringify(f.project));
    cutPlaylistClip(f.project, 1.137);
    f.project.tempo = 95;
    original.tempo = 95;
    expect(maxDiff(all({...f, project: original}), all(f))).toBeLessThan(1e-6);
  });
});
