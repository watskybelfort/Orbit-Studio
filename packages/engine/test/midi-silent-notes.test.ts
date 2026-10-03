import { expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, decodeMidi, encodeMidi, newId, type Note } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';

function fixture(notes: Note[]) {
  const project = createEmptyProject();
  const channel = createChannel('synth', 0);
  const patternId = project.patternOrder[0]!;
  applyCommand(project, { type: 'addChannel', channel });
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id, notes });
  return { project, patternId };
}

function peak({ project, patternId }: ReturnType<typeof fixture>): number {
  const audio = renderProject(compileProject(project, { mode: 'pattern', patternId }), {
    sampleRate: 8000, tailSeconds: 0, endBeat: 2,
  });
  return audio.left.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}

it.each([0, 1 / 127, 0.5, 1])('MIDI y audio conservan silencio o señal para velocity %s', (velocity) => {
  const original = fixture([{ id: newId(), start: 0, duration: 1, key: 60, velocity, pan: 0, slide: false }]);
  const decoded = decodeMidi(encodeMidi(original.project, { mode: 'pattern', patternId: original.patternId }));
  const notes = decoded.tracks.flatMap((track) => track.notes);
  const roundTrip = fixture(notes);
  if (velocity === 0) {
    expect(peak(original)).toBe(0);
    expect(notes).toHaveLength(0);
    expect(peak(roundTrip)).toBe(0);
  } else {
    expect(peak(original)).toBeGreaterThan(0);
    expect(peak(roundTrip)).toBeGreaterThan(0);
    expect(notes).toHaveLength(1);
    expect(Math.abs(notes[0]!.velocity - velocity)).toBeLessThanOrEqual(0.5 / 127);
  }
});
