/**
 * Historial en ÁRBOL: deshacer, divergir, y que la rama vieja SIGA ALCANZABLE.
 *
 * El test que da sentido a todo esto es el primero: probar una variación del
 * drop, no gustar, volver atrás, seguir por otro lado — y poder recuperar la
 * variación. Con el undo lineal eso se perdía para siempre.
 *
 * Lo demás protege que el árbol no rompa el tronco: los stacks quedan
 * coherentes tras cambiar de rama, un Ctrl+Z posterior sigue siendo un undo
 * normal, el salto respeta el origen y las ramas de la sala (`remote:*`) NO se
 * archivan (ver `docs/HISTORY.md`).
 */

import { describe, expect, it } from 'vitest';
import {
  branchChain,
  buildTreeView,
  createChannel,
  isBranchableOrigin,
  newId,
  ProjectStore,
  type HistoryBranch,
  type HistoryEntry,
  type HistoryView,
  type Note,
} from '../src/index';

function makeNote(start: number, key: number): Note {
  return { id: newId(), start, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

// ── Lo que pedía la tarea ────────────────────────────────────────────────────

describe('deshacer, divergir y volver a la rama abandonada', () => {
  it('la variación del drop no se pierde al seguir por otro lado', () => {
    const store = new ProjectStore();
    const ch = createChannel('sub808', 0);
    const patternId = store.project.patternOrder[0]!;
    store.dispatch({ type: 'addChannel', channel: ch });

    // ── Camino A: la variación del drop ──────────────────────────────────
    const variacion = [makeNote(0, 36), makeNote(2, 43)];
    store.dispatch({ type: 'addNotes', patternId, channelId: ch.id, notes: variacion });
    store.dispatch({ type: 'setTempo', tempo: 76 }, { label: 'Tempo del drop' });
    expect(store.project.patterns[patternId]!.notes[ch.id]).toHaveLength(2);

    // No gusta: dos Ctrl+Z.
    store.undo();
    store.undo();
    expect(store.project.tempo).toBe(140);
    expect(store.project.patterns[patternId]!.notes[ch.id]).toBeUndefined();

    // ── Camino B: se sigue por otro lado ─────────────────────────────────
    // Aquí es donde el undo lineal BORRABA el camino A.
    store.dispatch({ type: 'setSwing', swing: 0.22 }, { label: 'Swing nuevo' });

    const tree = store.historyTree();
    expect(tree.branches).toHaveLength(1);
    const rama = tree.branches[0]!;
    expect(rama.size).toBe(2);
    expect(rama.reachable).toBe(true);
    expect(rama.steps.map((s) => s.label)).toEqual(['2 nota(s)', 'Tempo del drop']);
    // Cuelga justo del "añadir canal": un cambio aplicado, el punto de la bifurcación.
    expect(rama.anchorIndex).toBe(1);
    expect(rama.anchorLabel).toBe(`Añadir canal "${ch.name}"`);

    // ── Volver a la variación ────────────────────────────────────────────
    expect(store.switchToBranch(rama.id)).toBe(2);
    expect(store.project.tempo).toBe(76);
    expect(store.project.patterns[patternId]!.notes[ch.id]).toHaveLength(2);
    expect(store.project.swing).toBe(0);

    // Y el camino B tampoco se perdió: ahora la rama es él.
    const after = store.historyTree();
    expect(after.branches).toHaveLength(1);
    expect(after.branches[0]!.steps.map((s) => s.label)).toEqual(['Swing nuevo']);

    // Ir y volver todas las veces que haga falta.
    expect(store.switchToBranch(after.branches[0]!.id)).toBe(1);
    expect(store.project.swing).toBeCloseTo(0.22);
    expect(store.project.tempo).toBe(140);
    expect(store.historyTree().branches[0]!.size).toBe(2);
  });

  it('cambiar de rama deja los stacks coherentes: undo y redo siguen siendo normales', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 120 });
    store.undo();
    store.undo();
    store.dispatch({ type: 'setTempo', tempo: 95 });

    const rama = store.historyTree().branches[0]!;
    store.switchToBranch(rama.id);
    expect(store.project.tempo).toBe(120);

    // Ctrl+Z desde la rama recién sacada: un paso atrás, no un salto raro.
    expect(store.undo()).toBe(true);
    expect(store.project.tempo).toBe(110);
    expect(store.redo()).toBe(true);
    expect(store.project.tempo).toBe(120);
    expect(store.redo()).toBe(false);

    const view = store.historyView();
    expect(view.entries.map((e) => e.label)).toEqual([
      'Tempo → 100 BPM',
      'Tempo → 110 BPM',
      'Tempo → 120 BPM',
    ]);
    expect(view.present).toBe(3);
    // Sin clones: los ids del tronco son únicos.
    expect(new Set(view.entries.map((e) => e.id)).size).toBe(3);
  });

  it('las entradas de la rama conservan su id al volver (el panel no las pierde)', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setSwing', swing: 0.3 });
    const idsOriginales = store.historyView().entries.map((e) => e.id);

    store.undo();
    store.dispatch({ type: 'setTimeSig', timeSig: { num: 3, den: 4 } });

    const rama = store.historyTree().branches[0]!;
    expect(rama.steps[0]!.id).toBe(idsOriginales[1]);
    store.switchToBranch(rama.id);
    expect(store.historyView().entries.map((e) => e.id)).toEqual(idsOriginales);
  });
});

// ── Bifurcaciones de bifurcaciones ───────────────────────────────────────────

describe('ramas de ramas', () => {
  it('una rama colgada de otra rama se alcanza sacando las dos en orden', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 }); // base

    // Camino A: 110 → 111
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 111 });
    // Volvemos a 110 y divergimos: A queda como rama de A (cuelga de "110").
    store.undo();
    store.dispatch({ type: 'setTempo', tempo: 112 });
    expect(store.historyTree().branches).toHaveLength(1); // [111]

    // Ahora abandonamos TODO el camino A: volvemos a la base y vamos por B.
    store.jumpTo(store.historyView().entries[0]!.id);
    store.dispatch({ type: 'setTempo', tempo: 200 });
    expect(store.project.tempo).toBe(200);

    const tree = store.historyTree();
    expect(tree.branches).toHaveLength(2);
    const nieta = tree.branches.find((b) => b.steps[0]!.label === 'Tempo → 111 BPM')!;
    const madre = tree.branches.find((b) => b.steps[0]!.label === 'Tempo → 110 BPM')!;
    // La nieta cuelga de una entrada que hoy vive DENTRO de la otra rama.
    expect(nieta.anchorIndex).toBe(-1);
    expect(nieta.depth).toBe(1);
    expect(nieta.reachable).toBe(true);
    expect(madre.depth).toBe(0);

    // Volver a la nieta saca antes a su madre: 100 → 110 → 111.
    expect(store.switchToBranch(nieta.id)).toBe(3);
    expect(store.project.tempo).toBe(111);
    expect(store.historyView().entries.map((e) => e.label)).toEqual([
      'Tempo → 100 BPM',
      'Tempo → 110 BPM',
      'Tempo → 111 BPM',
    ]);
    // Y lo abandonado por el camino sigue archivado: 112 y 200.
    const labels = store.historyTree().branches.map((b) => b.steps[0]!.label);
    expect(labels.sort()).toEqual(['Tempo → 112 BPM', 'Tempo → 200 BPM']);
  });
});

// ── Convivencia con el undo por origen ───────────────────────────────────────

describe('el árbol respeta el origen', () => {
  it('una rama local no se lleva por delante lo de Claude', () => {
    const store = new ProjectStore();
    const ch = createChannel('nova', 0);

    store.dispatch({ type: 'setTempo', tempo: 90 }, { origin: 'local' });
    store.dispatch({ type: 'addChannel', channel: ch }, { origin: 'claude' });
    store.dispatch({ type: 'setSwing', swing: 0.4 }, { origin: 'local' });

    store.undo('local'); // el swing se va al futuro
    store.dispatch({ type: 'setTimeSig', timeSig: { num: 6, den: 8 } }, { origin: 'local' });

    const rama = store.historyTree().branches[0]!;
    expect(rama.origin).toBe('local');
    expect(rama.steps).toHaveLength(1);

    // Volver a la rama del swing no toca el canal de Claude.
    store.switchToBranch(rama.id);
    expect(store.project.swing).toBeCloseTo(0.4);
    expect(store.project.timeSig.num).toBe(4);
    expect(store.project.channels[ch.id]).toBeDefined();
    expect(store.undo('claude')).toBe(true);
    expect(store.project.channels[ch.id]).toBeUndefined();
  });

  it('lo que llega de la sala NO se archiva como rama', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'remote:ana' });
    store.undo('remote:ana');
    store.dispatch({ type: 'setSwing', swing: 0.1 }, { origin: 'remote:ana' });

    // El redo remoto se descartó como siempre, y NO hay rama que ofrecer:
    // rehacerla aquí no llegaría al log de la sala (ver docs/HISTORY.md).
    expect(store.historyTree().branches).toHaveLength(0);
    expect(store.branchCount).toBe(0);
    expect(isBranchableOrigin('remote:ana')).toBe(false);
    expect(isBranchableOrigin('local')).toBe(true);
    expect(isBranchableOrigin('claude')).toBe(true);
  });

  it('un cambio de otro origen no crea ramas ni toca las mías', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'local' });
    store.undo('local');
    // Llega algo de la sala mientras yo tengo futuro pendiente.
    store.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'remote:ana' });
    // Mi Ctrl+Y sigue vivo: no se convirtió en rama ni se perdió.
    expect(store.historyTree().branches).toHaveLength(0);
    expect(store.redo('local')).toBe(true);
    expect(store.project.tempo).toBe(100);
  });
});

// ── Higiene ──────────────────────────────────────────────────────────────────

describe('mantenimiento del árbol', () => {
  it('cargar un proyecto tira las ramas y sube historyEpoch', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.undo();
    store.dispatch({ type: 'setTempo', tempo: 120 });
    expect(store.branchCount).toBe(1);

    const epoch = store.historyEpoch;
    store.replaceProject(store.project);
    expect(store.branchCount).toBe(0);
    expect(store.historyTree().branches).toHaveLength(0);
    expect(store.historyEpoch).toBe(epoch + 1);
  });

  it('descartar una rama se lleva las que colgaban de ella', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 111 });
    store.undo();
    store.dispatch({ type: 'setTempo', tempo: 112 });
    store.jumpTo(store.historyView().entries[0]!.id);
    store.dispatch({ type: 'setTempo', tempo: 200 });

    const tree = store.historyTree();
    const madre = tree.branches.find((b) => b.depth === 0 && b.size === 2)!;
    expect(store.dropBranch(madre.id)).toBe(true);
    // La nieta colgaba de dentro de la madre: sin ella no se llega.
    expect(store.branchCount).toBe(0);
    expect(store.dropBranch('no-existe')).toBe(false);
  });

  it('switchToBranch con un id desconocido no hace nada', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    expect(store.switchToBranch('no-existe')).toBe(0);
    expect(store.project.tempo).toBe(100);
  });

  it('las ráfagas fusionadas (perillas) no ensucian el árbol', () => {
    const store = new ProjectStore();
    const ch = createChannel('sub808', 0);
    store.dispatch({ type: 'addChannel', channel: ch });
    for (const v of [0.2, 0.4, 0.6]) {
      store.dispatch(
        { type: 'setChannelParam', channelId: ch.id, key: 'drive', value: v },
        { mergeKey: `drive:${ch.id}` },
      );
    }
    expect(store.historyView().entries).toHaveLength(2);
    expect(store.branchCount).toBe(0);
  });
});

// ── Módulo puro ──────────────────────────────────────────────────────────────

describe('history-tree (puro)', () => {
  function entry(id: string, label: string): HistoryEntry {
    return {
      id,
      label,
      command: { type: 'setTempo', tempo: 1 },
      inverse: { type: 'setTempo', tempo: 1 },
      origin: 'local',
      at: 0,
    };
  }

  function branch(id: string, anchorId: string | null, entryIds: string[]): HistoryBranch {
    return {
      id,
      anchorId,
      origin: 'local',
      at: 0,
      entries: entryIds.map((e) => entry(e, `paso ${e}`)),
    };
  }

  const view: HistoryView = {
    entries: [
      { id: 'A', label: 'A', origin: 'local', at: 0, done: true },
      { id: 'B', label: 'B', origin: 'local', at: 0, done: true },
    ],
    present: 2,
  };

  it('branchChain devuelve la cadena de ramas a sacar, en orden', () => {
    const madre = branch('m', 'A', ['x', 'y']);
    const nieta = branch('n', 'x', ['z']);
    const inTrunk = (id: string) => id === 'A' || id === 'B';
    expect(branchChain([madre, nieta], 'n', inTrunk)?.map((b) => b.id)).toEqual(['m', 'n']);
    expect(branchChain([madre, nieta], 'm', inTrunk)?.map((b) => b.id)).toEqual(['m']);
  });

  it('branchChain devuelve null si el ancla se perdió', () => {
    const huerfana = branch('h', 'ZZ', ['q']);
    expect(branchChain([huerfana], 'h', () => false)).toBeNull();
    expect(branchChain([], 'no-existe', () => true)).toBeNull();
  });

  it('branchChain corta un ciclo en vez de colgarse', () => {
    const a = branch('a', 'x2', ['x1']);
    const b = branch('b', 'x1', ['x2']);
    expect(branchChain([a, b], 'a', () => false)).toBeNull();
  });

  it('buildTreeView resuelve dónde cuelga cada rama y en qué orden se pintan', () => {
    const raiz = branch('r', null, ['p']);
    const enB = branch('b1', 'B', ['q']);
    const perdida = branch('x', 'ZZ', ['w']);
    const tree = buildTreeView(view, [enB, perdida, raiz]);
    expect(tree.branches.map((b) => b.id)).toEqual(['r', 'b1', 'x']);
    expect(tree.branches[0]!.anchorIndex).toBe(0);
    expect(tree.branches[0]!.anchorLabel).toBeNull();
    expect(tree.branches[1]!.anchorIndex).toBe(2);
    expect(tree.branches[1]!.anchorLabel).toBe('B');
    expect(tree.branches[2]!.reachable).toBe(false);
    // El tronco se pasa tal cual: la vista lineal no cambia.
    expect(tree.entries).toBe(view.entries);
    expect(tree.present).toBe(2);
  });
});
