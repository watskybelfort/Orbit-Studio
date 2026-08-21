/**
 * Secciones del arreglo: lo que importa no es que se muevan cajas, es que el
 * tema siga cuadrando después. Cada test comprueba el ESTADO resultante
 * aplicando los comandos con el store de verdad, no la forma de los comandos.
 */

import { describe, expect, it } from 'vitest';
import {
  ProjectStore,
  clipsInSpan,
  createEmptyProject,
  createPlaylistTrack,
  duplicateSectionCommands,
  moveSectionCommands,
  newId,
  removeSectionCommands,
  resizeSectionCommands,
  sectionsFromShape,
  sectionsOf,
  type ArrangementSection,
  type Clip,
  type Project,
} from '../src';

/** Proyecto con una pista y las secciones/clips que pida el test. */
function scene(): { store: ProjectStore; project: Project; trackId: string; arr: string } {
  const store = new ProjectStore();
  store.replaceProject(createEmptyProject('QA'));
  const project = store.project;
  const arr = project.activeArrangementId;
  const track = createPlaylistTrack(arr, 0);
  store.dispatch({ type: 'addPlaylistTrack', track }, { label: 'pista' });
  return { store, project: store.project, trackId: track.id, arr };
}

function clip(store: ProjectStore, trackId: string, start: number, length = 4): Clip {
  const c: Clip = {
    id: newId(),
    kind: 'pattern',
    playlistTrackId: trackId,
    start,
    length,
    muted: false,
    patternId: store.project.patternOrder[0]!,
  };
  store.dispatch({ type: 'addClips', clips: [c] }, { label: 'clip' });
  return c;
}

function section(
  store: ProjectStore,
  arr: string,
  name: string,
  start: number,
  length: number,
): ArrangementSection {
  const s: ArrangementSection = { id: newId(), arrangementId: arr, name, start, length };
  store.dispatch({ type: 'addSections', sections: [s] }, { label: 'seccion' });
  return s;
}

/** Aplica una lista de comandos como un solo paso, igual que hace la UI. */
function apply(store: ProjectStore, commands: ReturnType<typeof duplicateSectionCommands>): void {
  if (commands.length === 0) return;
  store.dispatch({ type: 'batch', label: 'op', commands }, { label: 'op' });
}

const starts = (store: ProjectStore, trackId: string) =>
  Object.values(store.project.clips)
    .filter((c) => c.playlistTrackId === trackId)
    .map((c) => c.start)
    .sort((a, b) => a - b);

describe('sectionsOf y clipsInSpan', () => {
  it('las secciones salen ordenadas y solo las de su arrangement', () => {
    const { store, arr } = scene();
    section(store, arr, 'B', 16, 8);
    section(store, arr, 'A', 0, 16);
    section(store, 'otro-arreglo', 'X', 0, 4);
    expect(sectionsOf(store.project, arr).map((s) => s.name)).toEqual(['A', 'B']);
  });

  it('un clip pertenece a la sección donde EMPIEZA, no a la que invade', () => {
    const { store, arr, trackId } = scene();
    clip(store, trackId, 12, 8); // empieza en la intro y se mete en el drop
    const dentro = clipsInSpan(store.project, arr, 16, 32);
    expect(dentro).toHaveLength(0);
  });

  it('el borde de la derecha es abierto: un clip en el límite es de la siguiente', () => {
    const { store, arr, trackId } = scene();
    clip(store, trackId, 16);
    expect(clipsInSpan(store.project, arr, 0, 16)).toHaveLength(0);
    expect(clipsInSpan(store.project, arr, 16, 32)).toHaveLength(1);
  });
});

describe('duplicateSectionCommands', () => {
  it('copia la sección con sus clips justo detrás', () => {
    const { store, arr, trackId } = scene();
    const drop = section(store, arr, 'Drop', 0, 16);
    clip(store, trackId, 0);
    clip(store, trackId, 8);
    apply(store, duplicateSectionCommands(store.project, drop.id));

    expect(sectionsOf(store.project, arr).map((s) => [s.name, s.start])).toEqual([
      ['Drop', 0],
      ['Drop', 16],
    ]);
    expect(starts(store, trackId)).toEqual([0, 8, 16, 24]);
  });

  it('empuja a la derecha lo que venía detrás: nada se pisa', () => {
    const { store, arr, trackId } = scene();
    const drop = section(store, arr, 'Drop', 0, 16);
    section(store, arr, 'Outro', 16, 8);
    clip(store, trackId, 0);
    clip(store, trackId, 16); // el clip del outro
    apply(store, duplicateSectionCommands(store.project, drop.id));

    expect(sectionsOf(store.project, arr).map((s) => [s.name, s.start])).toEqual([
      ['Drop', 0],
      ['Drop', 16],
      ['Outro', 32],
    ]);
    expect(starts(store, trackId)).toEqual([0, 16, 32]);
  });

  it('los marcadores se van con el resto (si no, el tempo se descuadra)', () => {
    const { store, arr } = scene();
    const drop = section(store, arr, 'Drop', 0, 16);
    store.dispatch(
      { type: 'addMarker', marker: { id: 'm1', time: 16, name: 'Outro', color: '#fff', tempo: 90 } },
      { label: 'marcador' },
    );
    apply(store, duplicateSectionCommands(store.project, drop.id));
    expect(store.project.markers['m1']!.time).toBe(32);
  });

  it('un clip que arranca antes de la sección no se copia', () => {
    const { store, arr, trackId } = scene();
    const drop = section(store, arr, 'Drop', 16, 16);
    clip(store, trackId, 12, 8); // empieza fuera, invade el drop
    apply(store, duplicateSectionCommands(store.project, drop.id));
    expect(starts(store, trackId)).toEqual([12]);
  });

  it('los clips copiados son nuevos y no comparten automatización', () => {
    const { store, arr, trackId } = scene();
    const drop = section(store, arr, 'Drop', 0, 8);
    const auto: Clip = {
      id: newId(),
      kind: 'automation',
      playlistTrackId: trackId,
      start: 0,
      length: 8,
      muted: false,
      points: [{ id: 'p', time: 0, value: 0.5, tension: 0 }],
    };
    store.dispatch({ type: 'addClips', clips: [auto] }, { label: 'auto' });
    apply(store, duplicateSectionCommands(store.project, drop.id));

    const copia = Object.values(store.project.clips).find((c) => c.id !== auto.id && c.points)!;
    copia.points![0]!.value = 1;
    expect(auto.points![0]!.value).toBe(0.5);
  });

  it('todo cabe en un solo undo', () => {
    const { store, arr, trackId } = scene();
    const drop = section(store, arr, 'Drop', 0, 16);
    clip(store, trackId, 0);
    const antes = starts(store, trackId);
    apply(store, duplicateSectionCommands(store.project, drop.id));
    store.undo();
    expect(starts(store, trackId)).toEqual(antes);
    expect(sectionsOf(store.project, arr)).toHaveLength(1);
  });

  it('una sección que no existe no hace nada', () => {
    const { store } = scene();
    expect(duplicateSectionCommands(store.project, 'no-existe')).toEqual([]);
  });
});

describe('removeSectionCommands', () => {
  it('sin opciones quita solo la etiqueta', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    clip(store, trackId, 4);
    apply(store, removeSectionCommands(store.project, s.id));
    expect(sectionsOf(store.project, arr)).toHaveLength(0);
    expect(starts(store, trackId)).toEqual([4]);
  });

  it('con withClips se lleva lo que sonaba dentro', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    clip(store, trackId, 4);
    clip(store, trackId, 20);
    apply(store, removeSectionCommands(store.project, s.id, { withClips: true }));
    expect(starts(store, trackId)).toEqual([20]);
  });

  it('con ripple cierra el hueco', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Drop', 8, 16);
    section(store, arr, 'Outro', 24, 8);
    clip(store, trackId, 0);
    clip(store, trackId, 24);
    apply(store, removeSectionCommands(store.project, s.id, { withClips: true, ripple: true }));

    expect(sectionsOf(store.project, arr).map((x) => [x.name, x.start])).toEqual([['Outro', 8]]);
    expect(starts(store, trackId)).toEqual([0, 8]);
  });

  it('el ripple no le manda un patch a la sección que se acaba de borrar', () => {
    const { store, arr } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    apply(store, removeSectionCommands(store.project, s.id, { ripple: true }));
    expect(store.project.sections[s.id]).toBeUndefined();
  });

  it('nada se va por debajo del beat 0', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Intro', 0, 16);
    clip(store, trackId, 16);
    apply(store, removeSectionCommands(store.project, s.id, { ripple: true }));
    expect(starts(store, trackId)).toEqual([0]);
  });
});

describe('moveSectionCommands', () => {
  it('la sección se lleva sus clips', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    clip(store, trackId, 0);
    clip(store, trackId, 8);
    clip(store, trackId, 20); // fuera: no se mueve
    apply(store, moveSectionCommands(store.project, s.id, 32));

    expect(store.project.sections[s.id]!.start).toBe(32);
    expect(starts(store, trackId)).toEqual([20, 32, 40]);
  });

  it('mover al mismo sitio no genera comandos', () => {
    const { store, arr } = scene();
    const s = section(store, arr, 'Drop', 8, 16);
    expect(moveSectionCommands(store.project, s.id, 8)).toEqual([]);
  });

  it('no se puede empujar antes del 0', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Drop', 8, 8);
    clip(store, trackId, 8);
    apply(store, moveSectionCommands(store.project, s.id, -20));
    expect(store.project.sections[s.id]!.start).toBe(0);
    expect(starts(store, trackId)).toEqual([0]);
  });
});

describe('resizeSectionCommands', () => {
  it('alargar empuja lo de detrás', () => {
    const { store, arr, trackId } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    section(store, arr, 'Outro', 16, 8);
    clip(store, trackId, 16);
    apply(store, resizeSectionCommands(store.project, s.id, 24));

    expect(store.project.sections[s.id]!.length).toBe(24);
    expect(sectionsOf(store.project, arr).map((x) => [x.name, x.start])).toEqual([
      ['Drop', 0],
      ['Outro', 24],
    ]);
    expect(starts(store, trackId)).toEqual([24]);
  });

  it('sin ripple solo cambia la longitud', () => {
    const { store, arr } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    const outro = section(store, arr, 'Outro', 16, 8);
    apply(store, resizeSectionCommands(store.project, s.id, 24, false));
    expect(store.project.sections[outro.id]!.start).toBe(16);
  });

  it('no se puede dejar en cero', () => {
    const { store, arr } = scene();
    const s = section(store, arr, 'Drop', 0, 16);
    apply(store, resizeSectionCommands(store.project, s.id, -5));
    expect(store.project.sections[s.id]!.length).toBeGreaterThan(0);
  });
});

describe('sectionsFromShape', () => {
  it('encadena la forma en beats a partir de los compases', () => {
    const out = sectionsFromShape(
      'arr',
      [
        { kind: 'intro', name: 'Intro', bars: 4 },
        { kind: 'drop', name: 'Drop', bars: 8 },
      ],
      4,
    );
    expect(out.map((s) => [s.name, s.start, s.length])).toEqual([
      ['Intro', 0, 16],
      ['Drop', 16, 32],
    ]);
  });

  it('respeta el compás de verdad (3/4 no mide lo mismo)', () => {
    const out = sectionsFromShape('arr', [{ kind: 'intro', name: 'I', bars: 4 }], 3);
    expect(out[0]!.length).toBe(12);
  });

  it('cada sección lleva su id', () => {
    const out = sectionsFromShape(
      'arr',
      [
        { kind: 'intro', name: 'A', bars: 1 },
        { kind: 'drop', name: 'B', bars: 1 },
      ],
      4,
    );
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
  });
});
