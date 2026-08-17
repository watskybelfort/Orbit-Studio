/**
 * Historial navegable: `historyView()` + `jumpTo()` sobre un ProjectStore real.
 *
 * Lo que se protege aquí: saltar a un punto deja el proyecto EXACTAMENTE como
 * estaba en ese momento, los stacks quedan coherentes (un Ctrl+Z posterior
 * sigue siendo un undo normal) y el salto respeta el origen — lo que hizo otro
 * (Claude, un remoto) no se toca nunca.
 */

import { describe, expect, it } from 'vitest';
import {
  createChannel,
  createPattern,
  newId,
  ProjectStore,
  type Clip,
  type Note,
} from '../src/index';

function makeNote(start: number, key: number): Note {
  return { id: newId(), start, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

describe('historyView', () => {
  it('lista el pasado y el futuro con el presente marcado', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 120 });

    const view = store.historyView();
    expect(view.entries).toHaveLength(3);
    expect(view.present).toBe(3);
    expect(view.entries.map((e) => e.done)).toEqual([true, true, true]);
    expect(view.entries.map((e) => e.label)).toEqual([
      'Tempo → 100 BPM',
      'Tempo → 110 BPM',
      'Tempo → 120 BPM',
    ]);
    expect(view.entries.every((e) => e.origin === 'local')).toBe(true);

    // Tras un undo, la entrada pasa al futuro pero no se pierde ni cambia de id.
    store.undo();
    const after = store.historyView();
    expect(after.present).toBe(2);
    expect(after.entries.map((e) => e.id)).toEqual(view.entries.map((e) => e.id));
    expect(after.entries.map((e) => e.done)).toEqual([true, true, false]);
  });

  it('las entradas tienen id estable y distinto', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 90 });
    store.dispatch({ type: 'setSwing', swing: 0.2 });
    const ids = store.historyView().entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('jumpTo', () => {
  it('salta atrás a un punto intermedio y vuelve adelante', () => {
    const store = new ProjectStore();
    const ch = createChannel('sub808', 0);
    const patternId = store.project.patternOrder[0]!;
    const notes = [makeNote(0, 36), makeNote(1, 38)];

    store.dispatch({ type: 'setTempo', tempo: 76 });
    store.dispatch({ type: 'addChannel', channel: ch });
    store.dispatch({ type: 'addNotes', patternId, channelId: ch.id, notes });
    store.dispatch({ type: 'patchChannel', channelId: ch.id, patch: { name: 'Sub grave' } });

    const view = store.historyView();
    expect(view.entries).toHaveLength(4);

    // Atrás hasta justo después de "añadir canal": el canal existe, sin notas
    // y con su nombre original.
    expect(store.jumpTo(view.entries[1]!.id)).toBe(2);
    expect(store.project.tempo).toBe(76);
    expect(store.project.channels[ch.id]).toBeDefined();
    expect(store.project.channels[ch.id]!.name).toBe(ch.name);
    expect(store.project.patterns[patternId]!.notes[ch.id]).toBeUndefined();

    const mid = store.historyView();
    expect(mid.present).toBe(2);
    expect(mid.entries.map((e) => e.done)).toEqual([true, true, false, false]);

    // Adelante otra vez hasta el final: el proyecto vuelve al estado completo.
    expect(store.jumpTo(view.entries[3]!.id)).toBe(2);
    expect(store.project.channels[ch.id]!.name).toBe('Sub grave');
    expect(store.project.patterns[patternId]!.notes[ch.id]).toHaveLength(2);
    expect(store.historyView().present).toBe(4);
  });

  it('deja los stacks coherentes: undo y redo siguen funcionando tras el salto', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 120 });
    store.dispatch({ type: 'setTempo', tempo: 130 });
    const view = store.historyView();

    store.jumpTo(view.entries[1]!.id);
    expect(store.project.tempo).toBe(110);

    // Ctrl+Z desde el punto nuevo: un paso atrás, no un salto raro.
    expect(store.undo()).toBe(true);
    expect(store.project.tempo).toBe(100);
    expect(store.historyView().present).toBe(1);

    // Y el redo recupera en orden todo lo que quedó en el futuro.
    expect(store.redo()).toBe(true);
    expect(store.project.tempo).toBe(110);
    expect(store.redo()).toBe(true);
    expect(store.project.tempo).toBe(120);
    expect(store.redo()).toBe(true);
    expect(store.project.tempo).toBe(130);
    expect(store.redo()).toBe(false);

    // Ningún clon ni pérdida por el camino.
    const end = store.historyView();
    expect(end.entries).toHaveLength(4);
    expect(end.present).toBe(4);
    expect(end.entries.map((e) => e.id)).toEqual(view.entries.map((e) => e.id));
  });

  it('un dispatch después del salto tira el futuro (como manda el undo clásico)', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 120 });
    const view = store.historyView();

    store.jumpTo(view.entries[0]!.id);
    store.dispatch({ type: 'setTempo', tempo: 95 });

    const after = store.historyView();
    expect(after.entries).toHaveLength(2);
    expect(after.present).toBe(2);
    expect(after.entries[1]!.label).toBe('Tempo → 95 BPM');
    expect(store.undo()).toBe(true);
    expect(store.project.tempo).toBe(100);
  });

  it('null vuelve al estado inicial y un id desconocido no hace nada', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 88 });
    store.dispatch({ type: 'setSwing', swing: 0.4 });

    expect(store.jumpTo('no-existe')).toBe(0);
    expect(store.project.swing).toBe(0.4);

    expect(store.jumpTo(null)).toBe(2);
    expect(store.project.tempo).toBe(140);
    expect(store.project.swing).toBe(0);
    expect(store.historyView().present).toBe(0);

    // Idempotente: ya estamos ahí.
    expect(store.jumpTo(null)).toBe(0);
  });
});

describe('borrar patrones por el ProjectStore', () => {
  /** Patrón con notas en un canal y dos clips en la playlist. */
  function conContenido(store: ProjectStore) {
    const ch = createChannel('sub808', 0);
    store.dispatch({ type: 'addChannel', channel: ch });
    const pat = createPattern(1);
    store.dispatch({ type: 'addPattern', pattern: pat });
    const notes = [makeNote(0, 36), makeNote(1, 38), makeNote(2, 41)];
    store.dispatch({ type: 'addNotes', patternId: pat.id, channelId: ch.id, notes });

    const trackId = Object.keys(store.project.playlistTracks)[0]!;
    const clips: Clip[] = [0, 8].map((start) => ({
      id: newId(), kind: 'pattern', playlistTrackId: trackId,
      start, length: 4, muted: false, patternId: pat.id,
    }));
    store.dispatch({ type: 'addClips', clips });
    return { ch, pat, notes, clips };
  }

  it('borrar → undo → redo devuelve las notas Y los clips', () => {
    const store = new ProjectStore();
    const { ch, pat, clips } = conContenido(store);
    const before = JSON.stringify(store.project);
    const orderBefore = [...store.project.patternOrder];

    store.dispatch({ type: 'removePattern', patternId: pat.id }, { label: `Borrar "${pat.name}"` });
    expect(store.project.patterns[pat.id]).toBeUndefined();
    expect(store.project.patternOrder).not.toContain(pat.id);
    for (const c of clips) expect(store.project.clips[c.id]).toBeUndefined();
    // El canal no se va con el patrón (sus notas viven DENTRO del patrón).
    expect(store.project.channels[ch.id]).toBeDefined();

    // Un solo Ctrl+Z devuelve el patrón entero: notas, clips y su posición.
    expect(store.undo()).toBe(true);
    expect(JSON.stringify(store.project)).toBe(before);
    expect(store.project.patternOrder).toEqual(orderBefore);
    expect(store.project.patterns[pat.id]!.notes[ch.id]).toHaveLength(3);
    for (const c of clips) expect(store.project.clips[c.id]!.start).toBe(c.start);

    // Y el redo se lo vuelve a llevar todo.
    expect(store.redo()).toBe(true);
    expect(store.project.patterns[pat.id]).toBeUndefined();
    for (const c of clips) expect(store.project.clips[c.id]).toBeUndefined();

    // La entrada queda en el historial con su etiqueta (panel + jumpTo).
    const view = store.historyView();
    expect(view.entries.at(-1)!.label).toBe(`Borrar "${pat.name}"`);
    expect(view.present).toBe(view.entries.length);
  });

  it('el último patrón no se puede borrar y el historial no se ensucia', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 90 });
    const entries = store.historyView().entries.length;

    expect(() =>
      store.dispatch({ type: 'removePattern', patternId: store.project.patternOrder[0]! }),
    ).toThrow(/último patrón/);
    expect(store.project.patternOrder).toHaveLength(1);
    expect(store.historyView().entries).toHaveLength(entries);
    // El undo sigue siendo el del cambio anterior, no un paso roto.
    expect(store.undo()).toBe(true);
    expect(store.project.tempo).toBe(140);
  });
});

describe('jumpTo respeta el origen', () => {
  it('no toca las entradas de otro origen al saltar atrás', () => {
    const store = new ProjectStore();
    const ch = createChannel('nova', 0);

    store.dispatch({ type: 'setTempo', tempo: 90 }, { origin: 'local' });
    store.dispatch({ type: 'addChannel', channel: ch }, { origin: 'claude' });
    store.dispatch({ type: 'setTempo', tempo: 140 }, { origin: 'local' });
    store.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'local' });

    const view = store.historyView();
    // Saltar al primer cambio local deshace los dos locales de arriba…
    expect(store.jumpTo(view.entries[0]!.id, 'local')).toBe(2);
    expect(store.project.tempo).toBe(90);
    expect(store.project.swing).toBe(0);
    // …y el canal de Claude sigue en su sitio.
    expect(store.project.channels[ch.id]).toBeDefined();

    const mid = store.historyView();
    const claudeItem = mid.entries.find((e) => e.origin === 'claude')!;
    expect(claudeItem.done).toBe(true);
    expect(mid.present).toBe(2); // local#1 + el de Claude siguen aplicados

    // Claude conserva su propio undo intacto.
    expect(store.undo('claude')).toBe(true);
    expect(store.project.channels[ch.id]).toBeUndefined();
    expect(store.project.tempo).toBe(90);
  });

  it('saltar adelante solo rehace lo del origen pedido', () => {
    const store = new ProjectStore();
    const ch = createChannel('sampler', 0);

    store.dispatch({ type: 'setTempo', tempo: 90 }, { origin: 'local' });
    store.dispatch({ type: 'addChannel', channel: ch }, { origin: 'remote:ana' });
    store.dispatch({ type: 'setTempo', tempo: 120 }, { origin: 'local' });

    // Ana deshace lo suyo y el usuario se va al principio de lo suyo.
    expect(store.undo('remote:ana')).toBe(true);
    expect(store.project.channels[ch.id]).toBeUndefined();
    store.jumpTo(null, 'local');
    expect(store.project.tempo).toBe(140);

    const past = store.historyView();
    expect(past.present).toBe(0);
    expect(past.entries).toHaveLength(3);

    // Saltar adelante al último cambio local rehace los dos locales y deja la
    // entrada de Ana donde estaba: en el futuro, sin aplicar.
    const lastLocal = past.entries.filter((e) => e.origin === 'local').at(-1)!;
    expect(store.jumpTo(lastLocal.id, 'local')).toBe(2);
    expect(store.project.tempo).toBe(120);
    expect(store.project.channels[ch.id]).toBeUndefined();
    expect(store.historyView().entries.find((e) => e.origin === 'remote:ana')!.done).toBe(false);

    // Y Ana puede rehacer lo suyo cuando quiera.
    expect(store.redo('remote:ana')).toBe(true);
    expect(store.project.channels[ch.id]).toBeDefined();
  });
});
