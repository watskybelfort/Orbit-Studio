/**
 * Un clip de audio va por la pista de mixer de su CARRIL de playlist, no clavado
 * al master. Es lo que da a las tomas de voz y a las pistas congeladas su propio
 * canal (EQ, compresor, sends) — clave para mezclar voz sobre un beat.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, newId, type Clip, type Project } from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';

const SR = 44100;

function rms(xs: Float32Array): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, xs.length));
}

/** Proyecto con un clip de audio de 4 beats en el primer carril de playlist. */
function projectWithAudioClip(): { project: Project; trackId: string; sampleId: string } {
  const project = createEmptyProject('AudioMix');
  project.tempo = 240;
  const track = Object.values(project.playlistTracks).find(
    (t) => t.arrangementId === project.activeArrangementId,
  )!;
  const sampleId = newId();
  const clip: Clip = {
    id: newId(),
    kind: 'audio',
    playlistTrackId: track.id,
    start: 0,
    length: 4,
    muted: false,
    sampleId,
    audioGain: 1,
  };
  applyCommand(project, { type: 'addClips', clips: [clip] });
  return { project, trackId: track.id, sampleId };
}

function tone(): Float32Array {
  const out = new Float32Array(SR);
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
  return out;
}

describe('mixerTrack por carril de playlist', () => {
  it('sin elegir carril, el clip va al master (0)', () => {
    const { project } = projectWithAudioClip();
    const c = compileProject(project, { mode: 'song' });
    expect(c.audioClips).toHaveLength(1);
    expect(c.audioClips[0]!.mixerTrack).toBe(0);
  });

  it('al enrutar el carril a una pista, el clip la sigue', () => {
    const { project, trackId } = projectWithAudioClip();
    applyCommand(project, { type: 'patchPlaylistTrack', trackId, patch: { mixerTrack: 2 } });
    const c = compileProject(project, { mode: 'song' });
    expect(c.audioClips[0]!.mixerTrack).toBe(2);

    // Y deshacer lo devuelve al master.
    applyCommand(project, { type: 'patchPlaylistTrack', trackId, patch: { mixerTrack: 0 } });
    expect(compileProject(project, { mode: 'song' }).audioClips[0]!.mixerTrack).toBe(0);
  });

  it('el clip suena por esa pista: mutearla lo silencia', () => {
    const { project, trackId, sampleId } = projectWithAudioClip();
    applyCommand(project, { type: 'patchPlaylistTrack', trackId, patch: { mixerTrack: 1 } });
    const samples = new Map([[sampleId, { left: tone(), right: tone(), rate: SR }]]);

    // Muteada la pista 1, el clip que va por ella sale en silencio.
    project.mixer[1]!.mute = true;
    const muted = renderProject(compileProject(project, { mode: 'song' }), {
      sampleRate: SR,
      tailSeconds: 0.1,
      samples,
    });
    expect(rms(muted.left)).toBeLessThan(1e-4);

    // Sin mutear, suena (prueba de que de verdad pasa por la pista 1).
    project.mixer[1]!.mute = false;
    const audible = renderProject(compileProject(project, { mode: 'song' }), {
      sampleRate: SR,
      tailSeconds: 0.1,
      samples,
    });
    expect(rms(audible.left)).toBeGreaterThan(1e-3);
  });

  it('un mixerTrack fuera de rango se acota al mixer', () => {
    const { project, trackId } = projectWithAudioClip();
    applyCommand(project, { type: 'patchPlaylistTrack', trackId, patch: { mixerTrack: 9999 } });
    const c = compileProject(project, { mode: 'song' });
    expect(c.audioClips[0]!.mixerTrack).toBe(project.mixer.length - 1);
  });
});
