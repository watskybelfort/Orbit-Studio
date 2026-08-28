/**
 * El historial en árbol DENTRO de una sala (docs/HISTORY.md).
 *
 * Lo que se protege aquí es la decisión, no solo el código:
 *
 * 1. El árbol es LOCAL. Cada cliente archiva sus propias ramas y nada más.
 * 2. Cambiar de rama es una tanda de comandos hacia delante (los inversos
 *    hasta la bifurcación + los de la rama), así que la sala CONVERGE.
 * 3. Lo que llega con origen `remote:*` NO se archiva: volver a una rama ajena
 *    re-aplicaría sus comandos sin pasar por el log y sacaría a este cliente
 *    del estado de la sala.
 * 4. Una re-derivación (merge cruzado) borra el árbol — y lo dice subiendo
 *    `historyEpoch`.
 *
 * Sin red: dos Y.Doc conectados a mano, igual que `convergence.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createChannel,
  createEmptyProject,
  newId,
  parseProject,
  ProjectStore,
  serializeProject,
  type Note,
  type Project,
} from '@orbit/core';
import { CommandLogBinding } from '../src/command-log';

function cloneProject(p: Project): Project {
  return parseProject(serializeProject(p));
}

function makeNote(start: number, key: number): Note {
  return { id: newId(), start, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

interface Link {
  hold(): void;
  release(): void;
}

function linkDocs(docA: Y.Doc, docB: Y.Doc): Link {
  const origin = { link: true };
  let holding = false;
  const aToB: Uint8Array[] = [];
  const bToA: Uint8Array[] = [];
  docA.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) aToB.push(u);
    else Y.applyUpdate(docB, u, origin);
  });
  docB.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) bToA.push(u);
    else Y.applyUpdate(docA, u, origin);
  });
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const u of aToB.splice(0)) Y.applyUpdate(docB, u, origin);
      for (const u of bToA.splice(0)) Y.applyUpdate(docA, u, origin);
    },
  };
}

function setupTwoClients() {
  const base = createEmptyProject('Árbol en sala');
  const storeA = new ProjectStore(cloneProject(base));
  const storeB = new ProjectStore(cloneProject(base));
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const link = linkDocs(docA, docB);
  const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }, {
    isHost: () => true,
  });
  const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' }, {
    isHost: () => false,
  });
  bindA.start();
  bindB.start();
  return { storeA, storeB, docA, docB, link, bindA, bindB };
}

function expectConverged(...stores: ProjectStore[]): void {
  const [first, ...rest] = stores;
  const expected = serializeProject(first!.project);
  for (const store of rest) expect(serializeProject(store.project)).toBe(expected);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('el árbol en una sala', () => {
  it('dos clientes con historial propio convergen igual tras deshacer y divergir', () => {
    const { storeA, storeB } = setupTwoClients();
    const ch = createChannel('sub808', 0);
    const patternId = storeA.project.patternOrder[0]!;

    storeA.dispatch({ type: 'addChannel', channel: ch });
    // Camino A de Ana: notas + tempo del drop.
    storeA.dispatch({
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: [makeNote(0, 36), makeNote(2, 43)],
    });
    storeA.dispatch({ type: 'setTempo', tempo: 76 });
    expectConverged(storeA, storeB);

    // Ana deshace las dos cosas: en la sala eso son DOS COMANDOS NUEVOS
    // (los inversos), no un rebobinado. Beto los recibe y converge.
    storeA.undo();
    storeA.undo();
    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(140);

    // Y diverge por otro lado. Aquí se archiva la rama — en el cliente de Ana.
    storeA.dispatch({ type: 'setSwing', swing: 0.22 });
    expectConverged(storeA, storeB);

    expect(storeA.branchCount).toBe(1);
    // El árbol es LOCAL: Beto no ve ninguna rama de Ana.
    expect(storeB.branchCount).toBe(0);
    const rama = storeA.historyTree().branches[0]!;
    expect(rama.size).toBe(2);
    expect(rama.origin).toBe('local');
  });

  it('volver a una rama replica los cambios y la sala converge', () => {
    const { storeA, storeB } = setupTwoClients();
    const ch = createChannel('sub808', 0);
    const patternId = storeA.project.patternOrder[0]!;
    storeA.dispatch({ type: 'addChannel', channel: ch });
    storeA.dispatch({
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: [makeNote(0, 36), makeNote(2, 43)],
    });
    storeA.dispatch({ type: 'setTempo', tempo: 76 });
    storeA.undo();
    storeA.undo();
    storeA.dispatch({ type: 'setSwing', swing: 0.22 });

    const rama = storeA.historyTree().branches[0]!;
    expect(storeA.switchToBranch(rama.id)).toBe(2);

    // Beto no sabe nada de ramas y aun así tiene EXACTAMENTE el proyecto de Ana.
    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(76);
    expect(storeB.project.patterns[patternId]!.notes[ch.id]).toHaveLength(2);
    expect(storeB.project.swing).toBe(0);
    expect(storeB.branchCount).toBe(0);

    // Y el camino que Ana abandonó al volver también converge cuando lo saca.
    const otra = storeA.historyTree().branches[0]!;
    storeA.switchToBranch(otra.id);
    expectConverged(storeA, storeB);
    expect(storeB.project.swing).toBeCloseTo(0.22);
  });

  it('cada uno archiva SOLO sus ramas: lo del otro llega como remote y no se guarda', () => {
    const { storeA, storeB } = setupTwoClients();

    // Beto explora y abandona un camino: la rama es suya y solo suya.
    storeB.dispatch({ type: 'setTempo', tempo: 88 });
    storeB.dispatch({ type: 'setTempo', tempo: 92 });
    storeB.undo();
    storeB.undo();
    storeB.dispatch({ type: 'setTimeSig', timeSig: { num: 3, den: 4 } });
    expectConverged(storeA, storeB);

    expect(storeB.branchCount).toBe(1);
    // En el cliente de Ana esos mismos comandos entraron como `remote:Beto`:
    // no se archivan (volver a ellos no llegaría al log → divergencia).
    expect(storeA.branchCount).toBe(0);
    expect(storeA.historyView().entries.every((e) => e.origin === 'remote:Beto')).toBe(true);

    // Ana hace lo suyo en paralelo y tampoco contamina el árbol de Beto.
    storeA.dispatch({ type: 'setSwing', swing: 0.3 });
    storeA.undo();
    storeA.dispatch({ type: 'setSwing', swing: 0.5 });
    expectConverged(storeA, storeB);
    expect(storeA.branchCount).toBe(1);
    expect(storeB.branchCount).toBe(1); // la suya de antes, ni una más

    // Y cada uno puede volver a la suya sin romper la convergencia.
    storeB.switchToBranch(storeB.historyTree().branches[0]!.id);
    expectConverged(storeA, storeB);
    storeA.switchToBranch(storeA.historyTree().branches[0]!.id);
    expectConverged(storeA, storeB);
  });

  it('las ramas de Claude sí se guardan: su origen no es remote y se replica', () => {
    const { storeA, storeB } = setupTwoClients();
    storeA.dispatch({ type: 'setTempo', tempo: 82 }, { origin: 'claude' });
    storeA.undo('claude');
    storeA.dispatch({ type: 'setSwing', swing: 0.15 }, { origin: 'claude' });
    expectConverged(storeA, storeB);

    expect(storeA.branchCount).toBe(1);
    const rama = storeA.historyTree().branches[0]!;
    expect(rama.origin).toBe('claude');
    expect(storeA.switchToBranch(rama.id)).toBe(1);
    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(82);
  });

  it('una re-derivación por merge cruzado borra el árbol y sube historyEpoch', () => {
    const { storeA, storeB, link } = setupTwoClients();

    // Los DOS se arman un árbol antes del cruce. Quién re-deriva depende del
    // clientID (aleatorio en Yjs), así que el test no puede apostar por uno.
    storeA.dispatch({ type: 'setTempo', tempo: 100 });
    storeA.undo();
    storeA.dispatch({ type: 'setTempo', tempo: 120 });
    storeB.dispatch({ type: 'setSwing', swing: 0.4 });
    storeB.undo();
    storeB.dispatch({ type: 'setSwing', swing: 0.2 });
    expect(storeA.branchCount).toBe(1);
    expect(storeB.branchCount).toBe(1);

    const antes = [storeA, storeB].map((store) => ({ store, epoch: store.historyEpoch }));

    // Edición concurrente: el log ordena entradas por delante de otras ya
    // aplicadas y `CommandLogBinding` re-deriva el proyecto entero.
    link.hold();
    storeA.dispatch({ type: 'setTempo', tempo: 133 });
    storeB.dispatch({ type: 'addChannel', channel: createChannel('sampler', 0) });
    storeB.dispatch({ type: 'setTimeSig', timeSig: { num: 7, den: 8 } });
    link.release();

    expectConverged(storeA, storeB);

    // El cruce re-derivó a alguien: eso es lo que hace este test no ser vacío.
    const rederivados = antes.filter((x) => x.store.historyEpoch > x.epoch);
    expect(rederivados.length).toBeGreaterThan(0);
    for (const { store } of rederivados) {
      // Perdió el árbol Y el tronco, como siempre pasó con el undo lineal…
      expect(store.branchCount).toBe(0);
      expect(store.historyTree().branches).toHaveLength(0);
      expect(store.historyView().entries).toHaveLength(0);
    }
    // …y quien no re-derivó conserva el suyo entero.
    for (const { store } of antes.filter((x) => x.store.historyEpoch === x.epoch)) {
      expect(store.branchCount).toBe(1);
    }

    // La sala sigue viva: se puede seguir editando y sigue convergiendo.
    storeA.dispatch({ type: 'setTempo', tempo: 145 });
    expectConverged(storeA, storeB);
  });

  it('unirse a una sala existente entra sin árbol y con el epoch subido', () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    storeA.dispatch({ type: 'setTempo', tempo: 76 });
    storeA.undo();
    storeA.dispatch({ type: 'setTempo', tempo: 90 });
    expect(storeA.branchCount).toBe(1);

    const storeB = new ProjectStore();
    // Beto llega con un árbol propio de su proyecto anterior.
    storeB.dispatch({ type: 'setSwing', swing: 0.4 });
    storeB.undo();
    storeB.dispatch({ type: 'setSwing', swing: 0.1 });
    expect(storeB.branchCount).toBe(1);
    const epochB = storeB.historyEpoch;

    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }).start();
    new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' }).start();

    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(90);
    // El proyecto de Beto se sustituyó entero: su árbol no valía para el nuevo.
    expect(storeB.branchCount).toBe(0);
    expect(storeB.historyEpoch).toBe(epochB + 1);
    // Ana no se unió a nada: conserva el suyo.
    expect(storeA.branchCount).toBe(1);
  });
});
