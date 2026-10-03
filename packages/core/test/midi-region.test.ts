import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, decodeMidi, encodeMidi, newId, type Note } from '../src/index';

function fixture(notes: Note[]) {
  const project = createEmptyProject();
  const channel = createChannel('synth', 0);
  const patternId = project.patternOrder[0]!;
  const lane = Object.keys(project.playlistTracks)[0]!;
  applyCommand(project, { type: 'addChannel', channel });
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id, notes });
  applyCommand(project, { type: 'addClips', clips: [{ id: 'clip', kind: 'pattern', patternId, playlistTrackId: lane, start: 0, length: 8, muted: false }] });
  return { project, patternId, lane };
}

const note = (start: number, duration: number, key: number): Note => ({ id: newId(), start, duration, key, velocity: 1, pan: 0, slide: false });

describe('MIDI de una selección', () => {
  it('recorta ambos límites, desplaza al origen y excluye notas que solo tocan el borde', () => {
    const { project } = fixture([note(0, 1, 60), note(0.5, 1, 61), note(1.5, 2, 62), note(2, 1, 63)]);
    const before = structuredClone(project);
    const midi = decodeMidi(encodeMidi(project, { mode: 'song', region: { start: 1, end: 2 } }));
    expect(midi.tracks[0]!.notes.map(({ start, duration, key }) => ({ start, duration, key }))).toEqual([
      { start: 0, duration: 0.5, key: 61 }, { start: 0.5, duration: 0.5, key: 62 },
    ]);
    expect(project).toEqual(before);
  });

  it('resuelve primero offset de clip y respeta mute de clip/carril', () => {
    const { project, patternId, lane } = fixture([note(2, 4, 60)]);
    applyCommand(project, { type: 'patchClips', patches: [{ id: 'clip', start: 4, length: 3, patternOffset: 2 }] });
    const otherLane = Object.keys(project.playlistTracks)[1]!;
    applyCommand(project, { type: 'patchPlaylistTrack', trackId: otherLane, patch: { muted: true } });
    applyCommand(project, { type: 'addClips', clips: [
      { id: 'muted-clip', kind: 'pattern', patternId, playlistTrackId: lane, start: 4, length: 3, patternOffset: 2, muted: true },
      { id: 'muted-lane', kind: 'pattern', patternId, playlistTrackId: otherLane, start: 4, length: 3, patternOffset: 2, muted: false },
    ] });
    const midi = decodeMidi(encodeMidi(project, { mode: 'song', region: { start: 5, end: 6 } }));
    expect(midi.tracks[0]!.notes).toHaveLength(1);
    expect(midi.tracks[0]!.notes[0]).toMatchObject({ start: 0, duration: 1, key: 60 });
  });

  it('inicia con tempo y compás vigentes, sin modificar el proyecto', () => {
    const { project } = fixture([note(0, 8, 60)]);
    applyCommand(project, { type: 'addMarker', marker: { id: 'antes', name: 'Antes', time: 1, color: '#fff', tempo: 90, timeSigNum: 3 } });
    applyCommand(project, { type: 'addMarker', marker: { id: 'futuro', name: 'Fuera', time: 6, color: '#fff', tempo: 180 } });
    const midi = decodeMidi(encodeMidi(project, { mode: 'song', region: { start: 2, end: 4 } }));
    expect(midi.tempo).toBeCloseTo(90, 3);
    expect(midi.timeSig.num).toBe(3);
    expect(midi.tracks[0]!.notes[0]).toMatchObject({ start: 0, duration: 2 });
  });

  it.each([{ start: -1, end: 2 }, { start: 2, end: 1 }, { start: 2, end: 2 }, { start: 0, end: Infinity }])('rechaza una región inválida %j', (region) => {
    const { project } = fixture([note(0, 1, 60)]);
    expect(() => encodeMidi(project, { mode: 'song', region })).toThrow(/región/i);
  });
});
