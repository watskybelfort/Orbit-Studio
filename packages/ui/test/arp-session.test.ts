/**
 * El arpegiador con el panel abierto: qué pasa al pintar una pasada nueva y al
 * cancelar cuando de por medio hubo un Ctrl+Z.
 *
 * El bug medido: 3 notas → pasada del arp → Ctrl+Z → Cancelar = 6 notas. La
 * causa estaba en que "la entrada no está arriba" se leía como "hay que
 * restaurar a mano" sin distinguir si la pasada seguía aplicada debajo o si el
 * Ctrl+Z la había mandado al redoStack (y el proyecto ya tenía las originales).
 *
 * `arp-session.ts` es puro y recibe el store mínimo, así que la secuencia se
 * ejercita contra un `ProjectStore` REAL — con sus comandos y su historial —
 * sin montar el componente.
 */

import { describe, expect, it } from 'vitest';
import {
  arpeggiate,
  createChannel,
  ProjectStore,
  type ArpeggiateOptions,
  type Note,
} from '@orbit/core';
import {
  arpEntryState,
  cancelArpSession,
  openArpSession,
  previewArpSession,
} from '../src/editors/pianoroll/arp-session';
import { readSource } from './read-source';

const OPTS: ArpeggiateOptions = { rate: 0.25, mode: 'up' };

function nota(id: string, key: number): Note {
  return { id, start: 0, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

/** Canal + patrón + tres notas, por el bus de comandos. */
function rig() {
  const store = new ProjectStore();
  const channel = createChannel('sampler', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel });
  const patternId = store.project.patternOrder[0]!;
  const notes = [nota('n0', 60), nota('n1', 64), nota('n2', 67)];
  store.dispatch({ type: 'addNotes', patternId, channelId: channel.id, notes });
  const liveNotes = (): Note[] => store.project.patterns[patternId]!.notes[channel.id] ?? [];
  const ids = () => liveNotes().map((n) => n.id).sort();
  return { store, channelId: channel.id, patternId, notes, liveNotes, ids };
}

describe('arpEntryState', () => {
  it('traduce la vista del historial a un estado sin ambigüedad', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    const primera = store.historyView().entries[0]!.id;
    store.dispatch({ type: 'setSwing', swing: 0.2 });
    const segunda = store.historyView().entries[1]!.id;

    expect(arpEntryState(store.historyView(), null)).toBe('none');
    expect(arpEntryState(store.historyView(), 'no-existe')).toBe('lost');
    // La última aplicada está "arriba"; la anterior sigue aplicada pero debajo.
    expect(arpEntryState(store.historyView(), segunda)).toBe('top');
    expect(arpEntryState(store.historyView(), primera)).toBe('applied');

    // Un Ctrl+Z manda la última al futuro: deshecha, no "debajo".
    store.undo();
    expect(arpEntryState(store.historyView(), segunda)).toBe('undone');
    expect(arpEntryState(store.historyView(), primera)).toBe('top');
  });
});

describe('Ctrl+Z con el panel del arp abierto', () => {
  it('cancelar después del Ctrl+Z deja las 3 notas originales, no 6', () => {
    const { store, channelId, patternId, notes, liveNotes, ids } = rig();
    const session = openArpSession(notes);

    const generadas = previewArpSession(store, session, patternId, channelId, OPTS);
    expect(generadas).not.toBeNull();
    expect(liveNotes()).toHaveLength(generadas!.length);

    // Ctrl+Z del usuario: la pasada se deshace y vuelven las originales.
    store.undo();
    expect(ids()).toEqual(notes.map((n) => n.id).sort());

    // Cancelar con la entrada ya deshecha: no hay nada que restaurar.
    cancelArpSession(store, session, patternId, channelId);
    expect(liveNotes()).toHaveLength(3);
    expect(ids()).toEqual(notes.map((n) => n.id).sort());
  });

  it('mover una perilla después del Ctrl+Z reemplaza las originales, no las duplica', () => {
    const { store, channelId, patternId, notes, liveNotes, ids } = rig();
    const session = openArpSession(notes);

    previewArpSession(store, session, patternId, channelId, OPTS);
    store.undo();
    const segunda = previewArpSession(store, session, patternId, channelId, {
      ...OPTS,
      octaves: 2,
    });

    expect(segunda).not.toBeNull();
    expect(liveNotes()).toHaveLength(segunda!.length);
    // Ninguna de las originales sobrevive: se quitaron antes de añadir.
    for (const n of notes) expect(ids()).not.toContain(n.id);
    // Y la segunda pasada es la de `octaves: 2`, no la primera repetida.
    expect(segunda!.length).toBe(arpeggiate(notes, { ...OPTS, octaves: 2 }).length);
    expect(liveNotes().some((n) => n.key >= 72)).toBe(true);
  });

  it('cancelar con la pasada aplicada pero debajo restaura a mano, sin tocar el cambio de encima', () => {
    const { store, channelId, patternId, notes, liveNotes, ids } = rig();
    const session = openArpSession(notes);

    previewArpSession(store, session, patternId, channelId, OPTS);
    store.dispatch({ type: 'setTempo', tempo: 90 });
    cancelArpSession(store, session, patternId, channelId);

    expect(store.project.tempo).toBe(90);
    expect(liveNotes()).toHaveLength(3);
    expect(ids()).toEqual(notes.map((n) => n.id).sort());
  });

  it('aceptar sin cancelar deja la pasada aplicada y el Ctrl+Z posterior la deshace entera', () => {
    const { store, channelId, patternId, notes, liveNotes, ids } = rig();
    const session = openArpSession(notes);
    previewArpSession(store, session, patternId, channelId, OPTS);
    const conArp = liveNotes().length;

    // Aceptar solo cierra el panel (el componente lo hace): el estado sigue.
    expect(conArp).toBeGreaterThan(3);
    store.undo();
    expect(liveNotes()).toHaveLength(3);
    expect(ids()).toEqual(notes.map((n) => n.id).sort());
  });
});

describe('PianoRoll delega la decisión en arp-session', () => {
  it('usa los planes del módulo y ya no el booleano ambiguo', () => {
    const src = readSource('editors/pianoroll/PianoRoll.tsx');
    expect(src).toContain('previewArpSession(store, session');
    expect(src).toContain('cancelArpSession(store, session');
    expect(src).not.toContain('arpEntryOnTop');
  });
});
