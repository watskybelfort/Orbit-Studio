/**
 * Un destino ESTÁTICO no se automatiza.
 *
 * La auditoría midió que un LFO sobre `convolver.size` reconstruía la IR dentro
 * del hilo de audio 25 veces por segundo: 11 ms y ~650 KB por reconstrucción.
 * La UI ya no ofrece esos destinos, pero un proyecto viejo (o de la sala) puede
 * traerlos; el compilador es la puerta que de verdad los cierra. El swing, que
 * se hornea al compilar, tampoco puede fingir que se automatiza.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createEmptyProject,
  createLfo,
  defaultEffectParams,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';

function projectWithConvolver(): { project: Project; trackId: string } {
  const project = createEmptyProject('Estático');
  applyCommand(project, {
    type: 'setEffect',
    trackIndex: 0,
    slotIndex: 0,
    slot: {
      id: 'fx-conv',
      kind: 'convolver',
      enabled: true,
      mix: 1,
      params: defaultEffectParams('convolver'),
    },
  });
  const trackId = Object.values(project.playlistTracks)[0]!.id;
  return { project, trackId };
}

describe('convolver: la IR no se reconstruye por automatización', () => {
  it('un clip sobre size no llega al proyecto compilado', () => {
    const { project, trackId } = projectWithConvolver();
    applyCommand(project, {
      type: 'addClips',
      clips: [{
        id: 'auto-size',
        kind: 'automation',
        playlistTrackId: trackId,
        start: 0,
        length: 4,
        muted: false,
        target: { kind: 'effect', trackIndex: 0, slotIndex: 0, param: 'size' },
        points: [{ id: 'p1', time: 0, value: 0.2, tension: 0 }],
      }],
    });

    const compiled = compileProject(project, { mode: 'song' });
    expect(compiled.automation).toHaveLength(0);
  });

  it('un LFO sobre damp tampoco', () => {
    const { project } = projectWithConvolver();
    applyCommand(project, {
      type: 'addLfos',
      lfos: [createLfo({ kind: 'effect', trackIndex: 0, slotIndex: 0, param: 'damp' }, 2)],
    });

    expect(compileProject(project, { mode: 'song' }).lfos).toHaveLength(0);
  });

  it('predelay, que no toca la IR, sí se puede automatizar', () => {
    const { project } = projectWithConvolver();
    applyCommand(project, {
      type: 'addLfos',
      lfos: [createLfo({ kind: 'effect', trackIndex: 0, slotIndex: 0, param: 'predelay' }, 2)],
    });

    expect(compileProject(project, { mode: 'song' }).lfos).toHaveLength(1);
  });
});

describe('swing: no se ofrece lo que el kernel no lee', () => {
  it('un LFO sobre swing se descarta al compilar', () => {
    const project = createEmptyProject('Swing');
    applyCommand(project, {
      type: 'addLfos',
      lfos: [createLfo({ kind: 'transport', param: 'swing' }, 4)],
    });
    expect(compileProject(project, { mode: 'song' }).lfos).toHaveLength(0);
  });

  it('el tempo sigue siendo automatizable', () => {
    const project = createEmptyProject('Tempo');
    applyCommand(project, {
      type: 'addLfos',
      lfos: [createLfo({ kind: 'transport', param: 'tempo' }, 4)],
    });
    expect(compileProject(project, { mode: 'song' }).lfos).toHaveLength(1);
  });
});
