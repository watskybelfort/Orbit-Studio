/**
 * Info del proyecto: la `mergeKey` es por CAMPO, no `'meta'` a secas.
 *
 * Con `mergeKey: 'meta'`, escribir el título y el autor con menos de 800 ms de
 * diferencia (la ventana de fusión del store) fundía las dos ráfagas en UNA
 * entrada: se conservaba el inverso de la PRIMERA y el comando pasaba a ser el
 * último, así que un Ctrl+Z devolvía solo uno de los dos campos y el otro se
 * quedaba escrito. La clave lleva las claves del patch ordenadas — el mismo
 * criterio que `SendMenu.patch` en Mixer.tsx (`send-merge.test.ts`).
 *
 * La forma exacta de la clave se fija leyendo el fuente de `ProjectInfo.tsx`
 * (convención del repo: nada de jsdom para un .tsx) y el comportamiento se
 * ejercita despachando `setMeta` con esa misma forma contra un `ProjectStore`
 * real.
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore } from '@orbit/core';
import { readSource } from './read-source';

/** Las claves del patch que se están escribiendo, igual que en ProjectInfo. */
function metaMergeKey(patch: Record<string, unknown>): string {
  const fields = Object.keys(patch).sort().join('+');
  return `meta:${fields}`;
}

function dispatchMeta(store: ProjectStore, patch: { title?: string; author?: string }): void {
  store.dispatch(
    { type: 'setMeta', patch },
    { label: 'Info del proyecto', mergeKey: metaMergeKey(patch) },
  );
}

describe('el fuente de ProjectInfo deriva la mergeKey del patch', () => {
  it('usa una clave por campo, no la constante "meta"', () => {
    const src = readSource('editors/project-info/ProjectInfo.tsx');
    expect(src).not.toContain("mergeKey: 'meta'");
    // Por trozos: escribir `mergeKey: \`meta:${fields}\`` entero en un literal
    // dispara no-template-curly-in-string (aquí ${...} es TEXTO, no plantilla).
    expect(src).toContain(['mergeKey: `meta:', '$', '{fields}`'].join(''));
    expect(src).toContain('Object.keys(patch).sort().join');
  });
});

describe('setMeta con mergeKey por campo (ProjectStore real)', () => {
  it('dos campos escritos seguidos son DOS entradas y cada undo revierte la suya', () => {
    const store = new ProjectStore();
    const title0 = store.project.meta.title;
    const author0 = store.project.meta.author;

    // Ráfaga del título (teclas seguidas: misma clave, se funden en una).
    for (const v of ['B', 'Be', 'Bea', 'Beat']) dispatchMeta(store, { title: v });
    // Y acto seguido —dentro de la ventana de 800 ms— la ráfaga del autor.
    for (const v of ['A', 'An', 'Ana']) dispatchMeta(store, { author: v });

    expect(store.history).toHaveLength(2);
    expect(store.history.map((e) => e.mergeKey)).toEqual(['meta:title', 'meta:author']);

    // El primer Ctrl+Z revierte SOLO el autor; el título queda.
    store.undo();
    expect(store.project.meta.author).toBe(author0);
    expect(store.project.meta.title).toBe('Beat');

    // El segundo revierte el título.
    store.undo();
    expect(store.project.meta.title).toBe(title0);
  });

  it('las notas (textarea) no se funden con el título ni con el autor', () => {
    const store = new ProjectStore();
    for (const v of ['i', 'id', 'idea']) dispatchMeta(store, { title: v });
    store.dispatch(
      { type: 'setMeta', patch: { comments: 'idea' } },
      { label: 'Info del proyecto', mergeKey: metaMergeKey({ comments: 'idea' }) },
    );
    expect(store.history.map((e) => e.mergeKey)).toEqual(['meta:title', 'meta:comments']);

    store.undo();
    expect(store.project.meta.comments).toBe('');
    expect(store.project.meta.title).toBe('idea');
  });
});
