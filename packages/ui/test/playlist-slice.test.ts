/**
 * Cortar la selección en el playhead desde la Playlist.
 *
 * El batch (acortar cabeza + crear cola) se prueba contra un proyecto real;
 * el cableado del botón/tecla se comprueba en la fuente porque el gesto vive
 * en el JSX y montar el canvas no aporta nada aquí.
 */

import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, type Clip, type Project } from '@orbit/core';
import { sliceClipCommands, sliceClipsAt } from '../src/editors/playlist/slice-clip';
import { readSource } from './read-source';

function projectWithClips(): Project {
  const project = createEmptyProject('Cortes');
  project.tempo = 120;
  const trackId = Object.values(project.playlistTracks).find(
    (t) => t.arrangementId === project.activeArrangementId,
  )!.id;
  const base: Clip = {
    id: 'clip',
    kind: 'audio',
    playlistTrackId: trackId,
    start: 0,
    length: 4,
    muted: false,
    sampleId: 'sample',
    audioOffset: 0,
  };
  applyCommand(project, {
    type: 'addClips',
    clips: [base, { ...base, id: 'lejos', start: 10 }],
  });
  return project;
}

describe('sliceClipCommands', () => {
  it('devuelve el patch de la cabeza y el clip de cola en orden', () => {
    const project = projectWithClips();
    const commands = sliceClipCommands(project, project.clips.clip!, 2, 'cola');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      type: 'patchClips',
      patches: [{ id: 'clip', length: 2 }],
    });
    expect(commands[1]).toMatchObject({
      type: 'addClips',
      clips: [{ id: 'cola', start: 2, length: 2 }],
    });
  });

  it('no corta si el punto cae en un borde', () => {
    const project = projectWithClips();
    const clip = project.clips.clip!;
    expect(sliceClipCommands(project, clip, 0)).toEqual([]);
    expect(sliceClipCommands(project, clip, 4)).toEqual([]);
    expect(sliceClipCommands(project, clip, 3.97)).toEqual([]);
  });

  it('corta solo los clips de la selección que cruzan el playhead', () => {
    const project = projectWithClips();
    const ids: string[] = [];
    // IDs deterministas para comparar sin depender de newId.
    const commands = sliceClipsAt(project, ['clip', 'lejos'], 2, () => {
      const id = `cola-${ids.length}`;
      ids.push(id);
      return id;
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({ type: 'addClips', clips: [{ id: 'cola-0', start: 2 }] });
  });
});

describe('el botón Dividir y la tecla S', () => {
  const src = readSource('editors/playlist/Playlist.tsx');

  it('usa el playhead y manda la selección en un solo batch', () => {
    expect(src).toContain('const cut = useUiStore.getState().positionBeats;');
    expect(src).toContain('sliceClipsAt(project, selectedIds, cut)');
    expect(src).toContain("const label = count === 1 ? 'Cortar clip'");
    expect(src).toMatch(/Cortar \$\{count\} clips/);
  });

  it('tiene botón y atajo, además del Shift+clic que ya existía', () => {
    expect(src).toContain('onClick={splitSelectionAtPlayhead}');
    expect(src).toContain("e.code === 'KeyS'");
    expect(src).toContain('Dividir');
    expect(src).toContain('Shift+clic corta justo donde pulses');
  });

  it('la regla entera hace seek y el arrastre superior sigue creando loop', () => {
    expect(src).toContain("drag.current = { mode: 'loop', anchor: beat, moved: false, x0: x };");
    expect(src).toContain('doSeek(d.anchor);');
  });
});
