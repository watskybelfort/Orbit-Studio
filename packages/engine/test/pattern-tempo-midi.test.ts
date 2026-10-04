import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, decodeMidi, encodeMidi } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';
import { encodeWav } from '../src/render/wav';
import { MAX_BLOCK } from '../src/kernel-core';

function fixture() {
  const project = createEmptyProject();
  project.tempo = 140;
  const channel = createChannel('synth', 0);
  applyCommand(project, { type: 'addChannel', channel });
  const patternId = project.patternOrder[0]!;
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id,
    notes: [{ id: 'n', start: 0, duration: 4, key: 60, velocity: 1, pan: 0, slide: false }] });
  applyCommand(project, { type: 'addClips', clips: [{ id: 'clip', kind: 'pattern', patternId,
    playlistTrackId: Object.keys(project.playlistTracks)[0]!, start: 0, length: 4, muted: false }] });
  const control = structuredClone(project);
  applyCommand(project, { type: 'addMarker', marker: { id: 'zero', name: 'Intro', color: '', time: 0, tempo: 180, timeSigNum: 3 } });
  applyCommand(project, { type: 'addMarker', marker: { id: 'middle', name: 'Cambio', color: '', time: 2, tempo: 90, timeSigNum: 7 } });
  return { project, control, patternId };
}

function wavSeconds(left: Float32Array, right: Float32Array, rate: number): number {
  const bytes = encodeWav(left, right, rate, 16);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(40, true) / view.getUint32(28, true);
}

describe('BUG044: el patrón no hereda los marcadores de la canción', () => {
  it('PAT usa el mismo tempo y compás que su MIDI, con WAV de igual duración musical', () => {
    const { project, control, patternId } = fixture();
    const play = { mode: 'pattern' as const, patternId };
    const compiled = compileProject(project, play);
    const midi = decodeMidi(encodeMidi(project, play));
    expect(compiled.tempo).toBeCloseTo(midi.tempo, 3);
    expect(compiled.tempoMap).toEqual([{ beat: 0, tempo: 140 }]);
    expect(compiled.meterMap).toEqual([{ beat: 0, num: midi.timeSig.num }]);
    expect(midi.timeSig).toEqual({ num: 4, den: 4 });
    const options = { sampleRate: 8000, tailSeconds: 0 };
    const audio = renderProject(compiled, options);
    const expected = renderProject(compileProject(control, play), options);
    expect(audio.left.some((value) => Math.abs(value) > .1)).toBe(true);
    expect(audio.left.every((value, i) => value === expected.left[i])).toBe(true);
    const endBeat = Math.max(...midi.tracks.flatMap((track) => track.notes.map((n) => n.start + n.duration)));
    expect(Math.abs(wavSeconds(audio.left, audio.right, audio.sampleRate) - endBeat * 60 / midi.tempo)).toBeLessThan(MAX_BLOCK / audio.sampleRate);
  });

  it('SONG conserva ambos cambios de tempo/compás y su duración real', () => {
    const { project } = fixture();
    const compiled = compileProject(project, { mode: 'song' });
    expect(compiled.tempoMap).toEqual([{ beat: 0, tempo: 180 }, { beat: 2, tempo: 90 }]);
    expect(compiled.meterMap).toEqual([{ beat: 0, num: 3 }, { beat: 2, num: 7 }]);
    const audio = renderProject(compiled, { sampleRate: 8000, tailSeconds: 0 });
    expect(audio.left.some((value) => Math.abs(value) > .1)).toBe(true);
    const expectedSeconds = 2 * 60 / 180 + 2 * 60 / 90;
    expect(Math.abs(wavSeconds(audio.left, audio.right, audio.sampleRate) - expectedSeconds)).toBeLessThan(MAX_BLOCK / audio.sampleRate);
  });
});
