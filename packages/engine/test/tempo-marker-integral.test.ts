import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore } from '../src/kernel-core';
import { secondsAtBeat } from '../src/tempo';

describe('la integral del kernel respeta el lado izquierdo de cada marcador', () => {
  for (const tempo of [60, 240]) {
    it(`120 a ${tempo} en beat1 no introduce una rampa antes del marcador`, () => {
      const project = createEmptyProject('Cambio de tempo');
      project.tempo = 120;
      project.markers.change = {id: 'change', time: 1, tempo, name: 'Cambio', color: '#fff'};
      const lane = Object.keys(project.playlistTracks)[0]!;
      for (const [id, start] of [['at', 1], ['after', 1.137], ['late', 2.713]] as const) {
        project.clips[id] = {id, start, length: 1, kind: 'audio', sampleId: 'tone', muted: false, playlistTrackId: lane};
      }
      const compiled = compileProject(project, {mode: 'song'});
      const kernel = new KernelCore(8000);
      kernel.handleMessage({type: 'snapshot', project: compiled});
      const cache = kernel as unknown as {clipStartSecs: Float64Array; clipEndSecs: Float64Array};
      for (let i = 0; i < compiled.audioClips.length; i++) {
        const clip = compiled.audioClips[i]!;
        expect(cache.clipStartSecs[i]).toBeCloseTo(secondsAtBeat(compiled.tempoMap!, clip.start, project.tempo), 12);
        expect(cache.clipEndSecs[i]).toBeCloseTo(secondsAtBeat(compiled.tempoMap!, clip.start + clip.length, project.tempo), 12);
      }
      expect(cache.clipStartSecs[0]).toBe(0.5);
    });
  }
});
