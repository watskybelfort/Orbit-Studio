/**
 * Un snapshot envenenado no puede inutilizar la sala.
 *
 * `meta.snapshot` es la base que carga todo el que entra, y `parseProject` es
 * estricto con la forma. Sin try/catch, un `'{ esto no es JSON'` (un cliente
 * modificado, o un .bin tocado a mano) hacía que `join()` lanzara al unirse y
 * que el veneno se quedara en el .bin: nadie más podía entrar. El receptor no
 * es la autoridad del snapshot, pero SÍ puede negarse a morir por él.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createEmptyProject, parseProject, ProjectStore, serializeProject, type Project } from '@orbit/core';
import { CommandLogBinding } from '../src/command-log';

function cloneProject(p: Project): Project {
  return parseProject(serializeProject(p));
}

/** Relay entre dos docs: cada update local de uno se aplica en el otro. */
function linkDocs(docA: Y.Doc, docB: Y.Doc): { hold(): void; release(): void } {
  const origin = { link: true };
  let holding = false;
  const aToB: Uint8Array[] = [];
  const bToA: Uint8Array[] = [];
  docA.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) aToB.push(u);
    else Y.applyUpdate(docB, u, origin);
  });
  docB.on('update', (u: Uint8Array, o: unknown) => {
    if (o === origin) return;
    if (holding) bToA.push(u);
    else Y.applyUpdate(docA, u, origin);
  });
  return {
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const u of aToB.splice(0)) Y.applyUpdate(docB, u, origin);
      for (const u of bToA.splice(0)) Y.applyUpdate(docA, u, origin);
    },
  };
}

describe('CommandLogBinding: un snapshot ilegible no tumba la sala', () => {
  it('unirse con el snapshot envenenado no lanza y la sala sigue usable', () => {
    const base = createEmptyProject('Base');
    const storeA = new ProjectStore(cloneProject(base));
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    linkDocs(docA, docB);
    new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }).start();
    storeA.dispatch({ type: 'setTempo', tempo: 100 });

    // El .bin se guardó con la base rota (o la metió un cliente modificado).
    docB.getMap<string | number>('meta').set('snapshot', '{ esto no es JSON');

    const storeB = new ProjectStore(cloneProject(base));
    let replaced = 0;
    expect(() =>
      new CommandLogBinding(
        storeB,
        docB,
        { name: 'Beto', color: '#5aa9e6' },
        { isHost: () => false, onProjectReplaced: () => replaced++ },
      ).start(),
    ).not.toThrow();
    // Sin base válida no se sustituye el proyecto: no hay nada en qué basarse.
    expect(replaced).toBe(0);

    // Pero la sala funciona: lo que pasa después llega y se aplica.
    storeA.dispatch({ type: 'setSwing', swing: 0.25 });
    expect(storeB.project.swing).toBe(0.25);
    expect(serializeProject(storeA.project)).toBe(serializeProject(storeB.project));
  });

  it('re-derivar con el snapshot envenenado no lanza y converge', () => {
    const storeA = new ProjectStore(cloneProject(createEmptyProject('Cruce')));
    const storeB = new ProjectStore(cloneProject(createEmptyProject('Cruce')));
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const link = linkDocs(docA, docB);
    new CommandLogBinding(storeA, docA, { name: 'Ana', color: '#e6675a' }).start();
    new CommandLogBinding(storeB, docB, { name: 'Beto', color: '#5aa9e6' }, {
      isHost: () => false,
    }).start();

    // El snapshot que la sala traía está roto: el siguiente merge cruzado
    // fuerza un replay, y es donde antes explotaba `parseProject`.
    docA.getMap<string | number>('meta').set('snapshot', 'no-json');

    link.hold();
    storeA.dispatch({ type: 'setTempo', tempo: 96 });
    storeB.dispatch({ type: 'setSwing', swing: 0.2 });
    expect(() => link.release()).not.toThrow();

    expect(serializeProject(storeA.project)).toBe(serializeProject(storeB.project));
  });
});
