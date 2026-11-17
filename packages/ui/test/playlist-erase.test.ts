/**
 * Borrar con el clic derecho MANTENIDO: todo lo que toca el cursor se va, sin
 * soltar y volver a pulsar por cada clip.
 *
 * El gesto vive en los manejadores de `Playlist.tsx` (canvas), así que se fija
 * leyendo la fuente (convención del repo, sin jsdom), y la parte que importa
 * de verdad —que el borrado sea UN comando y un solo Ctrl+Z lo devuelva
 * todo— se prueba contra el `ProjectStore` real.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

describe('clic derecho mantenido en la Playlist', () => {
  const src = readSource('editors/playlist/Playlist.tsx');

  it('arma el modo erase al pulsar y no borra todavía', () => {
    expect(src).toContain("drag.current = { mode: 'erase', ids, x, y };");
  });

  it('al moverse recorre el tramo en pasos de 4 px (un gesto rápido no salta clips)', () => {
    expect(src).toContain('Math.ceil(Math.hypot(x - d.x, y - d.y) / 4)');
  });

  it('lo tocado deja de pintarse al momento', () => {
    expect(src).toContain("const erasing = drag.current?.mode === 'erase' ? drag.current.ids : null;");
    expect(src).toContain('if (erasing?.has(c.id)) continue;');
  });

  it('al soltar borra todo en UN removeClips', () => {
    expect(src).toMatch(/if \(d\.mode === 'erase'\) \{[\s\S]{0,400}store\.dispatch\(\{ type: 'removeClips', clipIds: ids \}, \{ label \}\);/);
  });

  it('un Ctrl+Z devuelve todos los clips borrados juntos', async () => {
    const core = await import('@orbit/core');
    const store = new core.ProjectStore();
    const track = Object.values(store.project.playlistTracks)[0]!;
    const patternId = store.project.patternOrder[0]!;
    const clips = [0, 4, 8].map((start, i) => ({
      id: `c${i}`, kind: 'pattern' as const, playlistTrackId: track.id, start, length: 4, muted: false, patternId,
    }));
    store.dispatch({ type: 'addClips', clips });
    store.dispatch({ type: 'removeClips', clipIds: ['c0', 'c1', 'c2'] }, { label: 'Borrar 3 clips' });
    expect(Object.keys(store.project.clips)).toHaveLength(0);
    store.undo();
    expect(Object.keys(store.project.clips).sort()).toEqual(['c0', 'c1', 'c2']);
  });
});
