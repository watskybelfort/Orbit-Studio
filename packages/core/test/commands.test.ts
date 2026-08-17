import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createPattern,
  createPlaylistTrack,
  newId,
  parseProject,
  ProjectStore,
  serializeProject,
  type Command,
  type Note,
  type Project,
} from '../src/index';

function snapshot(p: Project): string {
  return JSON.stringify(p);
}

function makeNote(start: number, key: number): Note {
  return { id: newId(), start, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

/** Aplica cmd y su inverso: el proyecto debe quedar byte a byte igual. */
function expectInvertible(project: Project, cmd: Command) {
  const before = snapshot(project);
  const inverse = applyCommand(project, cmd);
  applyCommand(project, inverse);
  expect(snapshot(project)).toBe(before);
}

describe('comandos: apply + inverso = identidad', () => {
  it('transport y meta', () => {
    const p = createEmptyProject();
    expectInvertible(p, { type: 'setTempo', tempo: 92 });
    expectInvertible(p, { type: 'setSwing', swing: 0.3 });
    expectInvertible(p, { type: 'setTimeSig', timeSig: { num: 3, den: 4 } });
    expectInvertible(p, { type: 'setMeta', patch: { title: 'Test', author: 'Orbit' } });
  });

  it('canales', () => {
    const p = createEmptyProject();
    const ch = createChannel('sub808', 0);
    expectInvertible(p, { type: 'addChannel', channel: ch });

    applyCommand(p, { type: 'addChannel', channel: ch });
    expectInvertible(p, { type: 'patchChannel', channelId: ch.id, patch: { volume: 0.5, name: 'Sub' } });
    expectInvertible(p, { type: 'setChannelParam', channelId: ch.id, key: 'drive', value: 0.9 });
    expectInvertible(p, { type: 'removeChannel', channelId: ch.id });
  });

  it('removeChannel restaura también las notas de todos los patrones', () => {
    const p = createEmptyProject();
    const ch = createChannel('synth', 0);
    const patternId = p.patternOrder[0]!;
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, {
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: [makeNote(0, 60), makeNote(1, 63)],
    });
    expectInvertible(p, { type: 'removeChannel', channelId: ch.id });
  });

  it('notas: add / patch / remove', () => {
    const p = createEmptyProject();
    const ch = createChannel('synth', 0);
    const patternId = p.patternOrder[0]!;
    applyCommand(p, { type: 'addChannel', channel: ch });
    const notes = [makeNote(0, 60), makeNote(0.5, 62)];
    expectInvertible(p, { type: 'addNotes', patternId, channelId: ch.id, notes });

    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes });
    expectInvertible(p, {
      type: 'patchNotes',
      patternId,
      channelId: ch.id,
      patches: [{ id: notes[0]!.id, start: 2, key: 65 }],
    });
    expectInvertible(p, {
      type: 'removeNotes',
      patternId,
      channelId: ch.id,
      noteIds: notes.map((n) => n.id),
    });
  });

  it('patrones con clips que los referencian', () => {
    const p = createEmptyProject();
    const pat = createPattern(1);
    applyCommand(p, { type: 'addPattern', pattern: pat });
    const trackId = Object.keys(p.playlistTracks)[0]!;
    applyCommand(p, {
      type: 'addClips',
      clips: [{
        id: newId(), kind: 'pattern', playlistTrackId: trackId,
        start: 0, length: 4, muted: false, patternId: pat.id,
      }],
    });
    // Borrar el patrón se lleva su clip; el inverso restaura ambos.
    expectInvertible(p, { type: 'removePattern', patternId: pat.id });
  });

  it('borrar el ÚLTIMO patrón lanza y no deja el proyecto a medias', () => {
    const p = createEmptyProject();
    expect(p.patternOrder).toHaveLength(1);
    const only = p.patternOrder[0]!;
    // Sin patrones, el rack, el modo PAT y la grabación en vivo se quedan sin
    // destino: core lo prohíbe igual que con el último arrangement. Toda la UI
    // que ofrezca borrar tiene que preguntar ANTES en vez de comerse esto.
    expect(() => applyCommand(p, { type: 'removePattern', patternId: only })).toThrow(
      /último patrón/,
    );
    expect(p.patternOrder).toEqual([only]);
    expect(p.patterns[only]).toBeDefined();
  });

  it('borrar un patrón con notas y varios clips: cascada e inverso exacto', () => {
    const p = createEmptyProject();
    const kick = createChannel('drums', 0);
    const bass = createChannel('sub808', 1);
    applyCommand(p, { type: 'addChannel', channel: kick });
    applyCommand(p, { type: 'addChannel', channel: bass });

    const pat = createPattern(1);
    applyCommand(p, { type: 'addPattern', pattern: pat });
    applyCommand(p, {
      type: 'addNotes',
      patternId: pat.id,
      channelId: kick.id,
      notes: [makeNote(0, 36), makeNote(2, 36)],
    });
    applyCommand(p, {
      type: 'addNotes',
      patternId: pat.id,
      channelId: bass.id,
      notes: [makeNote(0, 28)],
    });

    // Tres clips del patrón repartidos por la playlist + uno de OTRO patrón,
    // que la cascada no puede tocar. El ajeno va PRIMERO porque restorePattern
    // reinserta los suyos al final y el snapshot compara JSON (y el JSON de un
    // objeto sí depende del orden de las claves, aunque el modelo no).
    const trackId = Object.keys(p.playlistTracks)[0]!;
    const ajeno = {
      id: newId(), kind: 'pattern' as const, playlistTrackId: trackId,
      start: 16, length: 4, muted: false, patternId: p.patternOrder[0]!,
    };
    const mine = [0, 4, 8].map((start) => ({
      id: newId(), kind: 'pattern' as const, playlistTrackId: trackId,
      start, length: 4, muted: false, patternId: pat.id,
    }));
    applyCommand(p, { type: 'addClips', clips: [ajeno, ...mine] });

    // Es expectInvertible desplegado: hace falta mirar el estado intermedio.
    const before = snapshot(p);
    const inverse = applyCommand(p, { type: 'removePattern', patternId: pat.id });

    expect(p.patterns[pat.id]).toBeUndefined();
    expect(p.patternOrder).not.toContain(pat.id);
    for (const c of mine) expect(p.clips[c.id]).toBeUndefined();
    expect(p.clips[ajeno.id]).toBeDefined(); // el del otro patrón sigue ahí
    expect(p.channels[kick.id]).toBeDefined(); // los canales no son del patrón
    expect(p.channels[bass.id]).toBeDefined();

    // El inverso devuelve el patrón entero (notas incluidas), sus clips en su
    // sitio y el patrón en su MISMA posición del orden.
    applyCommand(p, inverse);
    expect(snapshot(p)).toBe(before);
    expect(p.patterns[pat.id]!.notes[kick.id]).toHaveLength(2);
    expect(p.patterns[pat.id]!.notes[bass.id]).toHaveLength(1);
  });

  it('playlist: pistas y clips', () => {
    const p = createEmptyProject();
    const arrId = p.activeArrangementId;
    const track = createPlaylistTrack(arrId, 99);
    expectInvertible(p, { type: 'addPlaylistTrack', track });

    applyCommand(p, { type: 'addPlaylistTrack', track });
    const clip = {
      id: newId(), kind: 'pattern' as const, playlistTrackId: track.id,
      start: 8, length: 4, muted: false, patternId: p.patternOrder[0]!,
    };
    expectInvertible(p, { type: 'addClips', clips: [clip] });
    applyCommand(p, { type: 'addClips', clips: [clip] });
    expectInvertible(p, { type: 'patchClips', patches: [{ id: clip.id, start: 16, length: 8 }] });
    expectInvertible(p, { type: 'removeClips', clipIds: [clip.id] });
    expectInvertible(p, { type: 'removePlaylistTrack', trackId: track.id });
  });

  it('mixer: efectos, sends, routing', () => {
    const p = createEmptyProject();
    const slot = {
      id: newId(), kind: 'reverb' as const, enabled: true, mix: 0.3,
      params: { size: 0.7, damp: 0.4, width: 1, predelay: 0.02 },
    };
    expectInvertible(p, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    applyCommand(p, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    expectInvertible(p, { type: 'setEffectParam', trackIndex: 1, slotIndex: 0, key: 'size', value: 0.9 });
    expectInvertible(p, { type: 'patchEffect', trackIndex: 1, slotIndex: 0, patch: { enabled: false } });
    expectInvertible(p, { type: 'patchMixerTrack', trackIndex: 1, patch: { volume: 0.6, name: 'Drums' } });
    expectInvertible(p, { type: 'setSend', trackIndex: 1, target: 2, level: 0.5 });
    expectInvertible(p, { type: 'setRoute', trackIndex: 1, routeTo: 3 });
  });

  it('arrangements', () => {
    const p = createEmptyProject();
    const arr = { id: newId(), name: 'B-side' };
    expectInvertible(p, { type: 'addArrangement', arrangement: arr });
    applyCommand(p, { type: 'addArrangement', arrangement: arr });
    expectInvertible(p, { type: 'setActiveArrangement', arrangementId: arr.id });
    expectInvertible(p, { type: 'removeArrangement', arrangementId: arr.id });
  });

  it('batch: inverso en orden inverso', () => {
    const p = createEmptyProject();
    const ch = createChannel('fm', 0);
    expectInvertible(p, {
      type: 'batch',
      label: 'Canal con notas',
      commands: [
        { type: 'addChannel', channel: ch },
        {
          type: 'addNotes',
          patternId: p.patternOrder[0]!,
          channelId: ch.id,
          notes: [makeNote(0, 48)],
        },
        { type: 'setTempo', tempo: 76 },
      ],
    });
  });
});

describe('ProjectStore', () => {
  it('dispatch + undo + redo', () => {
    const store = new ProjectStore();
    const before = snapshot(store.project);
    store.dispatch({ type: 'setTempo', tempo: 100 });
    expect(store.project.tempo).toBe(100);
    expect(store.undo()).toBe(true);
    expect(snapshot(store.project)).toBe(before);
    expect(store.redo()).toBe(true);
    expect(store.project.tempo).toBe(100);
  });

  it('undo por origen: no deshace lo de otro usuario', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'remote:ana' });
    store.dispatch({ type: 'setSwing', swing: 0.5 }, { origin: 'local' });
    expect(store.undo('local')).toBe(true);
    expect(store.project.swing).toBe(0);
    expect(store.project.tempo).toBe(100); // lo de ana sigue
    expect(store.undo('local')).toBe(false);
  });

  it('mergeKey fusiona ráfagas de perilla en un undo', () => {
    const store = new ProjectStore();
    for (const v of [0.1, 0.2, 0.3, 0.4]) {
      store.dispatch(
        { type: 'patchMixerTrack', trackIndex: 1, patch: { volume: v } },
        { mergeKey: 'mixer:1:volume' },
      );
    }
    expect(store.project.mixer[1]!.volume).toBeCloseTo(0.4);
    store.undo();
    expect(store.project.mixer[1]!.volume).toBe(1); // valor original, un solo undo
  });
});

describe('formato .orbit', () => {
  it('round-trip serialize → parse', () => {
    const p = createEmptyProject('Demo');
    const ch = createChannel('sub808', 0);
    applyCommand(p, { type: 'addChannel', channel: ch });
    const json = serializeProject(p);
    const back = parseProject(json);
    expect(snapshot(back)).toBe(snapshot(p));
  });

  it('rechaza JSON corrupto y versiones desconocidas', () => {
    expect(() => parseProject('{no json')).toThrow();
    expect(() => parseProject('{"formatVersion": 99}')).toThrow(/Versión/);
  });
});
