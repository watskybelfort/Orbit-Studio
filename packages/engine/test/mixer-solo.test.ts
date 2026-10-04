import { describe, expect, it } from 'vitest';
import { applyCommand, createChannel, createEmptyProject, type Project } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';

const options = { sampleRate: 8000, tailSeconds: 0 };
function addVoice(project: Project, track: number, key = 60): string {
  const channel = createChannel('synth', project.channelOrder.length);
  channel.mixerTrack = track;
  applyCommand(project, { type: 'addChannel', channel });
  applyCommand(project, { type: 'addNotes', patternId: project.patternOrder[0]!, channelId: channel.id,
    notes: [{ id: `n${track}`, start: 0, duration: 1, key, velocity: 0.8, pan: 0, slide: false }] });
  return channel.id;
}
function compile(project: Project) {
  return compileProject(project, { mode: 'pattern', patternId: project.patternOrder[0]! });
}
function render(project: Project) { return renderProject(compile(project), options).left; }
function peak(audio: Float32Array) { return audio.reduce((max, v) => Math.max(max, Math.abs(v)), 0); }
function scene() {
  const project = createEmptyProject();
  project.tempo = 240;
  addVoice(project, 1);
  project.mixer[1]!.routeTo = 2;
  return project;
}

describe('solo de buses: fuentes, caminos y señal aislada', () => {
  it('conserva la fuente del bus y excluye el instrumento ajeno', () => {
    const project = scene();
    const expected = render(project);
    const foreign = addVoice(project, 4, 76);
    expect(render(project)).not.toEqual(expected);
    project.mixer[2]!.solo = true;
    expect(peak(expected)).toBeGreaterThan(0.1);
    expect(render(project)).toEqual(expected);
    expect(compile(project).channels.find((ch) => ch.id === foreign)?.audible).toBe(false);
  });

  it('conserva la salida encadenada sin abrir otros afluentes ni fuentes del bus de salida o Master', () => {
    const project = scene();
    project.mixer[2]!.routeTo = 3;
    const expected = render(project);
    addVoice(project, 3, 72); // fuente propia del bus de salida
    addVoice(project, 4, 76);
    addVoice(project, 0, 79); // directo al Master
    project.mixer[4]!.routeTo = 3; // otro afluente del bus compartido
    project.mixer[2]!.solo = true;
    expect(render(project)).toEqual(expected);
    expect(compile(project).mixer.slice(0, 5).map((track) => track.audible)).toEqual([true, true, true, true, false]);
  });

  it('el solo de un retorno conserva el envío y excluye el bypass seco de su fuente', () => {
    const project = scene();
    project.mixer[1]!.routeTo = null;
    project.mixer[1]!.sends = [{ target: 2, level: 0.3 }];
    const expected = render(project);
    project.mixer[1]!.routeTo = 0;
    expect(render(project)).not.toEqual(expected);
    project.mixer[2]!.solo = true;
    expect(peak(expected)).toBeGreaterThan(0.01);
    expect(render(project)).toEqual(expected);
    // Compilar no modifica los cables guardados ni su undo.
    expect(project.mixer[1]!.routeTo).toBe(0);
    expect(project.mixer[1]!.sends[0]).toEqual({ target: 2, level: 0.3 });
  });

  it('el solo de una fuente conserva sus salidas secas y envíos', () => {
    const project = scene();
    project.mixer[1]!.routeTo = 0;
    project.mixer[1]!.sends = [{ target: 2, level: 0.3 }];
    project.mixer[2]!.routeTo = 3;
    const expected = render(project);
    addVoice(project, 2, 76); // el retorno transporta, no abre su instrumento
    project.mixer[1]!.solo = true;
    expect(render(project)).toEqual(expected);
  });

  it.each([{ level: 0 }, { level: 1, mute: true }])('un envío inactivo no incorpora su fuente: %j', (send) => {
    const project = scene();
    project.mixer[1]!.routeTo = 0;
    project.mixer[1]!.sends = [{ target: 2, ...send }];
    project.mixer[2]!.solo = true;
    expect(peak(render(project))).toBe(0);
    expect(compile(project).channels[0]!.audible).toBe(false);
  });

  it.each([1, 3])('respeta el mute de la pista auxiliar %d', (track) => {
    const project = scene();
    project.mixer[2]!.routeTo = 3;
    project.mixer[2]!.solo = true;
    project.mixer[track]!.mute = true;
    expect(peak(render(project))).toBe(0);
  });

  it('une varios solos sin abrir pistas ajenas', () => {
    const project = scene();
    addVoice(project, 4, 67);
    const expected = render(project);
    addVoice(project, 5, 79);
    project.mixer[2]!.solo = true;
    project.mixer[4]!.solo = true;
    expect(render(project)).toEqual(expected);
  });

  it('resuelve el bus de una carpeta antes de decidir sus fuentes', () => {
    const project = scene();
    project.mixer[1]!.routeTo = 0;
    const channelId = project.channelOrder[0]!;
    applyCommand(project, { type: 'addChannelGroup', group: { id: 'g', name: 'Grupo', color: '', collapsed: false, busTrack: 2 } });
    applyCommand(project, { type: 'patchChannel', channelId, patch: { groupId: 'g' } });
    const expected = render(project);
    project.mixer[2]!.solo = true;
    expect(peak(expected)).toBeGreaterThan(0.1);
    expect(render(project)).toEqual(expected);
  });

  it('aísla también clips de audio: no se cuela un clip propio del bus de salida', () => {
    const project = createEmptyProject();
    project.tempo = 240;
    const lane = Object.values(project.playlistTracks)[0]!;
    applyCommand(project, { type: 'patchPlaylistTrack', trackId: lane.id, patch: { mixerTrack: 1 } });
    applyCommand(project, { type: 'addClips', clips: [{ id: 'voice', kind: 'audio', playlistTrackId: lane.id,
      start: 0, length: 4, muted: false, sampleId: 'sample' }] });
    project.mixer[1]!.routeTo = 2;
    project.mixer[2]!.routeTo = 3;
    const tone = Float32Array.from({ length: 8000 }, (_, i) => 0.1 * Math.sin(i * 0.2));
    const samples = new Map([['sample', { left: tone, right: tone, rate: 8000 }]]);
    const expected = renderProject(compileProject(project, { mode: 'song' }), { ...options, samples }).left;
    applyCommand(project, { type: 'addPlaylistTrack', track: { ...lane, id: 'foreign', mixerTrack: 3 } });
    applyCommand(project, { type: 'addClips', clips: [{ id: 'foreign', kind: 'audio', playlistTrackId: 'foreign',
      start: 0, length: 4, muted: false, sampleId: 'sample' }] });
    project.mixer[2]!.solo = true;
    const compiled = compileProject(project, { mode: 'song' });
    expect(peak(expected)).toBeGreaterThan(0.05);
    expect(compiled.audioClips).toHaveLength(1);
    expect(renderProject(compiled, { ...options, samples }).left).toEqual(expected);
  });
});
