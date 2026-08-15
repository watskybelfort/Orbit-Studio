/**
 * Convergencia del log de comandos SIN red: dos Y.Doc conectados a mano
 * (cada update de uno se aplica al otro) + dos ProjectStore con el mismo
 * proyecto inicial. Tras secuencias intercaladas y concurrentes de comandos,
 * serializeProject debe ser idéntico byte a byte en todos los clientes.
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
import { CommandLogBinding, type LogEntry } from '../src/command-log';

// ── Utilidades ───────────────────────────────────────────────────────────────

function cloneProject(p: Project): Project {
  return parseProject(serializeProject(p));
}

function makeNote(start: number, key: number): Note {
  return { id: newId(), start, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

interface Link {
  /** Retiene los updates (simula latencia / edición concurrente). */
  hold(): void;
  /** Suelta lo retenido en ambas direcciones y vuelve al relay inmediato. */
  release(): void;
}

/**
 * Conecta dos docs: cada update local de uno se aplica al otro. El origen es
 * único por enlace, así el eco se corta pero los updates que llegan por OTRO
 * enlace sí se reenvían (mesh por relay, como haría un servidor).
 */
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

interface TwoClients {
  storeA: ProjectStore;
  storeB: ProjectStore;
  docA: Y.Doc;
  docB: Y.Doc;
  link: Link;
  bindA: CommandLogBinding;
  bindB: CommandLogBinding;
}

function setupTwoClients(opts: { compactThreshold?: number; hostA?: boolean } = {}): TwoClients {
  const base = createEmptyProject('Convergencia');
  const storeA = new ProjectStore(cloneProject(base));
  const storeB = new ProjectStore(cloneProject(base));
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const link = linkDocs(docA, docB);
  const bindA = new CommandLogBinding(
    storeA,
    docA,
    { name: 'Ana', color: '#e6675a' },
    { compactThreshold: opts.compactThreshold, isHost: () => opts.hostA ?? true },
  );
  const bindB = new CommandLogBinding(
    storeB,
    docB,
    { name: 'Beto', color: '#5aa9e6' },
    { compactThreshold: opts.compactThreshold, isHost: () => false },
  );
  bindA.start(); // crea: publica snapshot base
  bindB.start(); // se une: el snapshot ya llegó por el enlace
  return { storeA, storeB, docA, docB, link, bindA, bindB };
}

function expectConverged(...stores: ProjectStore[]): void {
  const [first, ...rest] = stores;
  const expected = serializeProject(first!.project);
  for (const store of rest) {
    expect(serializeProject(store.project)).toBe(expected);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('CommandLogBinding: convergencia', () => {
  it('unirse a un room recibe el proyecto del creador', () => {
    const base = createEmptyProject('De Ana');
    const storeA = new ProjectStore(cloneProject(base));
    // Ana edita ANTES de crear la sesión: el snapshot debe incluirlo.
    storeA.dispatch({ type: 'addChannel', channel: createChannel('sub808', 0) });
    storeA.dispatch({ type: 'setTempo', tempo: 76 });

    const storeB = new ProjectStore(); // Beto llega con OTRO proyecto
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    const bindA = new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' });
    const bindB = new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' });
    bindA.start();
    bindB.start();

    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(76);
  });

  it('secuencias intercaladas de dos clientes convergen byte a byte', () => {
    const { storeA, storeB } = setupTwoClients();

    const ch = createChannel('sub808', 0);
    storeA.dispatch({ type: 'addChannel', channel: ch });

    // Beto ya ve el canal de Ana y le mete notas.
    const patternId = storeB.project.patternOrder[0]!;
    const notes = [makeNote(0, 36), makeNote(1, 38), makeNote(2, 36)];
    storeB.dispatch({ type: 'addNotes', patternId, channelId: ch.id, notes });

    storeA.dispatch({ type: 'setTempo', tempo: 76 });
    storeB.dispatch({
      type: 'patchMixerTrack',
      trackIndex: 1,
      patch: { volume: 0.6, name: 'Drums' },
    });
    // Ana edita una nota que creó Beto.
    storeA.dispatch({
      type: 'patchNotes',
      patternId,
      channelId: ch.id,
      patches: [{ id: notes[1]!.id, key: 40, velocity: 1 }],
    });
    storeB.dispatch({ type: 'setSwing', swing: 0.25 });
    storeA.dispatch({
      type: 'setEffect',
      trackIndex: 1,
      slotIndex: 0,
      slot: {
        id: newId(),
        kind: 'reverb',
        enabled: true,
        mix: 0.3,
        params: { size: 0.7, damp: 0.4 },
      },
    });

    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(76);
    expect(storeA.project.mixer[1]!.name).toBe('Drums');
  });

  it('el undo de un cliente se replica en el otro', () => {
    const { storeA, storeB } = setupTwoClients();

    storeA.dispatch({ type: 'setTempo', tempo: 100 });
    storeB.dispatch({ type: 'setSwing', swing: 0.5 });
    expect(storeB.project.tempo).toBe(100);

    // Ana deshace SU cambio: el inverso viaja como comando normal.
    expect(storeA.undo('local')).toBe(true);
    expect(storeA.project.tempo).toBe(140); // tempo por defecto del proyecto
    expectConverged(storeA, storeB);
    expect(storeB.project.swing).toBe(0.5); // lo de Beto sigue
  });

  it('ediciones concurrentes (updates retenidos) convergen al soltar', () => {
    const { storeA, storeB, link } = setupTwoClients();

    // Base compartida antes del corte.
    const ch = createChannel('drums', 0);
    storeA.dispatch({ type: 'addChannel', channel: ch });
    const patternId = storeA.project.patternOrder[0]!;

    // Corte: cada uno edita sin ver al otro (fuerza el re-derivado por
    // orden total del log en al menos un cliente).
    link.hold();
    storeA.dispatch({ type: 'setTempo', tempo: 96 });
    storeA.dispatch({
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: [makeNote(0, 42), makeNote(0.5, 42)],
    });
    storeB.dispatch({ type: 'setTempo', tempo: 128 });
    storeB.dispatch({
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: [makeNote(1, 46)],
    });
    storeB.dispatch({ type: 'patchChannel', channelId: ch.id, patch: { name: 'Batería' } });
    link.release();

    expectConverged(storeA, storeB);
    // El tempo final es el mismo en ambos (el que quede último en el log).
    expect([96, 128]).toContain(storeA.project.tempo);
    // Las notas de ambos están.
    expect(storeA.project.patterns[patternId]!.notes[ch.id]!.length).toBe(3);

    // Tras reconectar se sigue editando con normalidad.
    storeA.dispatch({ type: 'setTempo', tempo: 140 });
    storeB.dispatch({ type: 'setSwing', swing: 0.1 });
    expectConverged(storeA, storeB);
  });

  it('varios cortes concurrentes seguidos convergen', () => {
    const { storeA, storeB, link } = setupTwoClients();
    const patternId = storeA.project.patternOrder[0]!;
    const chA = createChannel('synth', 0);
    const chB = createChannel('supersaw', 1);

    link.hold();
    storeA.dispatch({ type: 'addChannel', channel: chA });
    storeB.dispatch({ type: 'addChannel', channel: chB });
    link.release();
    expectConverged(storeA, storeB);
    // Los dos canales existen y en el mismo orden en ambos.
    expect(storeA.project.channelOrder.length).toBe(2);

    link.hold();
    storeA.dispatch({
      type: 'addNotes',
      patternId,
      channelId: chB.id,
      notes: [makeNote(0, 60)],
    });
    storeB.dispatch({
      type: 'addNotes',
      patternId,
      channelId: chA.id,
      notes: [makeNote(0, 48)],
    });
    storeB.dispatch({ type: 'moveChannel', channelId: chB.id, toIndex: 0 });
    link.release();
    expectConverged(storeA, storeB);
  });
});

describe('CommandLogBinding: compactación', () => {
  it('el host recorta el log y un cliente nuevo entra por snapshot', () => {
    const threshold = 8;
    const { storeA, storeB, docA, docB } = setupTwoClients({
      compactThreshold: threshold,
      hostA: true,
    });

    // Muchos comandos intercalados → supera el umbral varias veces.
    for (let i = 0; i < 12; i++) {
      if (i % 2 === 0) storeA.dispatch({ type: 'setTempo', tempo: 60 + i });
      else storeB.dispatch({ type: 'setSwing', swing: i / 20 });
    }

    const logA = docA.getArray<LogEntry>('commands');
    const logB = docB.getArray<LogEntry>('commands');
    expect(logA.length).toBeLessThanOrEqual(threshold);
    expect(logB.length).toBe(logA.length);
    const snapshotSeq = docA.getMap('meta').get('snapshotSeq');
    expect(typeof snapshotSeq).toBe('number');
    expect(snapshotSeq as number).toBeGreaterThan(0);
    expectConverged(storeA, storeB);

    // Cari se une con el doc ya compactado: snapshot + cola del log.
    const docC = new Y.Doc();
    Y.applyUpdate(docC, Y.encodeStateAsUpdate(docA));
    const storeC = new ProjectStore();
    const bindC = new CommandLogBinding(storeC, docC, { name: 'Cari', color: '#7ce65a' });
    bindC.start();
    expectConverged(storeA, storeC);

    // Y sigue recibiendo comandos nuevos por el enlace.
    linkDocs(docA, docC);
    storeA.dispatch({ type: 'setTempo', tempo: 90 });
    expectConverged(storeA, storeB, storeC);
    expect(storeC.project.tempo).toBe(90);
  });

  it('la compactación no rompe la edición concurrente', () => {
    const threshold = 4;
    const { storeA, storeB, link } = setupTwoClients({
      compactThreshold: threshold,
      hostA: true,
    });

    link.hold();
    for (let i = 0; i < 6; i++) storeA.dispatch({ type: 'setTempo', tempo: 100 + i });
    for (let i = 0; i < 6; i++) storeB.dispatch({ type: 'setSwing', swing: i / 10 });
    link.release();

    expectConverged(storeA, storeB);
    storeA.dispatch({ type: 'setTempo', tempo: 77 });
    expectConverged(storeA, storeB);
    expect(storeB.project.tempo).toBe(77);
  });
});
