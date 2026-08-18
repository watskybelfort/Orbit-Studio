/**
 * Diff musical entre dos versiones del proyecto.
 *
 * Lo que importa: que MOVER una nota no se cuente como borrarla y crearla
 * (por eso se casan por id), que mover un efecto de ranura no parezca
 * añadirlo, que un roce de perilla no ensucie el informe, y que dos proyectos
 * iguales no digan nada — un historial que siempre tiene algo que contar no
 * sirve para mirar atrás.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand } from '../src/commands';
import { createChannel, createEmptyProject } from '../src/model/defaults';
import { describeDiff, diffProjects, isEmptyDiff, summarizeDiff } from '../src/model/diff';
import { newId } from '../src/ids';
import { parseProject, serializeProject } from '../src/format';
import type { Note, Project } from '../src/model/types';

function clone(project: Project): Project {
  return parseProject(serializeProject(project));
}

function note(start: number, key: number, id = newId()): Note {
  return { id, start, duration: 1, key, velocity: 0.8, pan: 0, slide: false };
}

/** Proyecto con un canal y cuatro notas en el primer patrón. */
function base(): { project: Project; channelId: string; patternId: string; notes: Note[] } {
  const project = createEmptyProject('Tema');
  const channel = createChannel('sub808', 0, 'Orbit Sub');
  applyCommand(project, { type: 'addChannel', channel });
  const patternId = project.patternOrder[0]!;
  const notes = [note(0, 36), note(1, 38), note(2, 36), note(3, 41)];
  applyCommand(project, { type: 'addNotes', patternId, channelId: channel.id, notes });
  return { project, channelId: channel.id, patternId, notes };
}

describe('sin cambios', () => {
  it('un proyecto consigo mismo no dice nada', () => {
    const { project } = base();
    const diff = diffProjects(project, clone(project));
    expect(isEmptyDiff(diff)).toBe(true);
    expect(describeDiff(diff)).toEqual([]);
    expect(summarizeDiff(diff)).toBe('Sin cambios');
  });
});

describe('notas', () => {
  it('cuenta las nuevas por patrón y canal, con nombres', () => {
    const { project, channelId, patternId } = base();
    const antes = clone(project);
    applyCommand(project, {
      type: 'addNotes',
      patternId,
      channelId,
      notes: [note(4, 43), note(5, 45)],
    });

    const diff = diffProjects(antes, project);
    expect(diff.notes).toHaveLength(1);
    expect(diff.notes[0]).toMatchObject({
      channelName: 'Orbit Sub',
      added: 2,
      removed: 0,
      moved: 0,
    });
    expect(describeDiff(diff)[0]).toContain('+2 notas');
    expect(summarizeDiff(diff)).toContain('+2 notas');
  });

  it('mover una nota NO es borrarla y crearla', () => {
    const { project, channelId, patternId, notes } = base();
    const antes = clone(project);
    applyCommand(project, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [{ id: notes[0]!.id, start: 2.5 }],
    });

    const diff = diffProjects(antes, project);
    expect(diff.notes[0]).toMatchObject({ added: 0, removed: 0, moved: 1, retuned: 0 });
  });

  it('distingue afinar de mover y de cambiar la fuerza', () => {
    const { project, channelId, patternId, notes } = base();
    const antes = clone(project);
    applyCommand(project, {
      type: 'patchNotes',
      patternId,
      channelId,
      patches: [
        { id: notes[0]!.id, key: 40 },
        { id: notes[1]!.id, velocity: 0.3 },
      ],
    });

    const diff = diffProjects(antes, project);
    expect(diff.notes[0]).toMatchObject({ retuned: 1, revoiced: 1, moved: 0, added: 0 });
  });

  it('borrar notas se ve como tal', () => {
    const { project, channelId, patternId, notes } = base();
    const antes = clone(project);
    applyCommand(project, {
      type: 'removeNotes',
      patternId,
      channelId,
      noteIds: [notes[0]!.id, notes[1]!.id],
    });
    expect(diffProjects(antes, project).notes[0]).toMatchObject({ removed: 2, added: 0 });
  });
});

describe('estructura', () => {
  it('canales nuevos, borrados, renombrados y re-enrutados', () => {
    const { project, channelId } = base();
    const antes = clone(project);
    const otro = createChannel('drums', 1, 'Kit');
    applyCommand(project, { type: 'addChannel', channel: otro });
    applyCommand(project, {
      type: 'patchChannel',
      channelId,
      patch: { name: 'Sub Grave', mixerTrack: 3 },
    });

    const diff = diffProjects(antes, project);
    expect(diff.channels.added).toEqual(['Kit']);
    expect(diff.channels.renamed).toEqual([['Orbit Sub', 'Sub Grave']]);
    expect(diff.channels.rerouted).toEqual([{ name: 'Sub Grave', from: 0, to: 3 }]);
    expect(describeDiff(diff).join('\n')).toContain('Canal nuevo: «Kit»');
  });

  it('tempo y swing salen con su antes y su después', () => {
    const { project } = base();
    const antes = clone(project);
    applyCommand(project, { type: 'setTempo', tempo: 76.25 });
    const diff = diffProjects(antes, project);
    expect(diff.tempo).toEqual([140, 76.25]);
    expect(describeDiff(diff)[0]).toContain('140.00 → 76.25');
  });

  it('los clips de la playlist se cuentan por lo que les pasa', () => {
    const { project, patternId } = base();
    const antes = clone(project);
    const trackId = Object.keys(project.playlistTracks)[0]!;
    const clip = {
      id: newId(),
      kind: 'pattern' as const,
      playlistTrackId: trackId,
      start: 0,
      length: 4,
      muted: false,
      patternId,
    };
    applyCommand(project, { type: 'addClips', clips: [clip] });
    const conClip = clone(project);
    expect(diffProjects(antes, conClip).clips).toEqual({ added: 1, removed: 0, moved: 0 });

    applyCommand(project, { type: 'patchClips', patches: [{ id: clip.id, start: 8 }] });
    expect(diffProjects(conClip, project).clips).toEqual({ added: 0, removed: 0, moved: 1 });
  });
});

describe('mezcla', () => {
  it('el fader sale en dB y el roce de perilla no cuenta', () => {
    const { project } = base();
    const antes = clone(project);
    applyCommand(project, { type: 'patchMixerTrack', trackIndex: 2, patch: { volume: 1.5 } });
    const diff = diffProjects(antes, project);
    expect(diff.mixer).toHaveLength(1);
    expect(diff.mixer[0]!.volumeDb?.[1]).toBeCloseTo(3.5, 1);
    expect(describeDiff(diff).join('\n')).toContain('fader');

    // Un movimiento inapreciable no ensucia el informe.
    const casiIgual = clone(project);
    applyCommand(casiIgual, {
      type: 'patchMixerTrack',
      trackIndex: 2,
      patch: { volume: 1.5005 },
    });
    expect(diffProjects(project, casiIgual).mixer).toEqual([]);
  });

  it('mover un efecto de ranura no es ni añadirlo ni quitarlo', () => {
    const { project } = base();
    const slot = { id: newId(), kind: 'reverb' as const, enabled: true, mix: 0.3, params: {} };
    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    const antes = clone(project);

    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot: null });
    applyCommand(project, { type: 'setEffect', trackIndex: 1, slotIndex: 3, slot });

    const diff = diffProjects(antes, project);
    expect(diff.mixer).toEqual([]);
  });

  it('un efecto nuevo sí sale, con su tipo', () => {
    const { project } = base();
    const antes = clone(project);
    applyCommand(project, {
      type: 'setEffect',
      trackIndex: 0,
      slotIndex: 0,
      slot: { id: newId(), kind: 'limiter', enabled: true, mix: 1, params: {} },
    });
    const diff = diffProjects(antes, project);
    expect(diff.mixer[0]!.effectsAdded).toEqual(['limiter']);
    expect(describeDiff(diff).join('\n')).toContain('efecto nuevo: limiter');
  });
});

describe('resumen', () => {
  it('junta lo gordo en una línea', () => {
    const { project, channelId, patternId } = base();
    const antes = clone(project);
    applyCommand(project, { type: 'setTempo', tempo: 150 });
    applyCommand(project, {
      type: 'addNotes',
      patternId,
      channelId,
      notes: [note(6, 48), note(7, 50), note(8, 52)],
    });
    applyCommand(project, { type: 'addChannel', channel: createChannel('drums', 1, 'Kit') });

    const resumen = summarizeDiff(diffProjects(antes, project));
    expect(resumen).toContain('+3 notas');
    expect(resumen).toContain('1 canal');
    expect(resumen).toContain('tempo');
  });
});
