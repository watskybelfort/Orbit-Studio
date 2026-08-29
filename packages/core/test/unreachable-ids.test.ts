/**
 * `ProjectStore.unreachableIds`: la pregunta que hace falta para soltar de
 * verdad un dato que un comando lleva embebido (hoy, el `sampleId` de un
 * canal borrado) sin romper undo.
 *
 * La propiedad que importa: un id sigue siendo "alcanzable" mientras exista
 * ALGÚN comando o inverso —en el pasado, en el futuro (redo) o en una rama
 * archivada— que lo mencione, porque ese es justo el camino por el que un
 * undo/redo podría volver a escribirlo en el proyecto. Deja de serlo solo
 * cuando esa entrada cae del historial de verdad (tope de 500).
 */

import { describe, expect, it } from 'vitest';
import { createChannel, ProjectStore } from '../src/index';

function withRemovedChannel(sampleId: string): { store: ProjectStore; channelId: string } {
  const store = new ProjectStore();
  const ch = createChannel('sampler', 0, 'Uno');
  store.dispatch({ type: 'addChannel', channel: ch });
  store.dispatch({ type: 'patchChannel', channelId: ch.id, patch: { sampleId } });
  store.dispatch({ type: 'removeChannel', channelId: ch.id });
  return { store, channelId: ch.id };
}

describe('unreachableIds', () => {
  it('un id que solo vive en el inverso de la entrada recién creada sigue alcanzable', () => {
    const { store } = withRemovedChannel('muestra-1');
    // `restoreChannel` (el inverso de `removeChannel`) guarda el canal
    // ENTERO, `sampleId` incluido: un Ctrl+Z todavía puede devolverlo.
    expect(store.unreachableIds(['muestra-1'])).toEqual([]);
  });

  it('sigue alcanzable mientras espera en el redo, tras deshacer', () => {
    const { store } = withRemovedChannel('muestra-2');
    store.undo();
    expect(store.unreachableIds(['muestra-2'])).toEqual([]);
  });

  it('deja de ser alcanzable en cuanto su entrada cae del historial (tope de 500)', () => {
    const { store } = withRemovedChannel('muestra-3');
    expect(store.unreachableIds(['muestra-3'])).toEqual([]);
    // 500 cambios de relleno, de un origen que no interfiere con la entrada
    // que se quiere expulsar (misma pila, MAX_HISTORY = 500).
    for (let i = 0; i < 500; i++) {
      store.dispatch({ type: 'setTempo', tempo: 100 + (i % 10) });
    }
    expect(store.unreachableIds(['muestra-3'])).toEqual(['muestra-3']);
  });

  it('un id que no aparece en ningún lado ya es inalcanzable desde el principio', () => {
    const store = new ProjectStore();
    expect(store.unreachableIds(['fantasma'])).toEqual(['fantasma']);
  });

  it('lista vacía: no escanea nada y devuelve vacío', () => {
    const store = new ProjectStore();
    expect(store.unreachableIds([])).toEqual([]);
  });

  it('un id que es PREFIJO de otro no se confunde con él (comillas del JSON)', () => {
    const store = new ProjectStore();
    store.dispatch({
      type: 'registerSample',
      sample: { id: 'kick-01-extra', name: 'x', path: 'qa:x', hash: 'x', duration: 1 },
    });
    // 'kick-01' NUNCA se registró — solo 'kick-01-extra', que lo tiene como
    // prefijo. Sin comillas en la búsqueda esto daría un falso "alcanzable".
    expect(store.unreachableIds(['kick-01'])).toEqual(['kick-01']);
    expect(store.unreachableIds(['kick-01-extra'])).toEqual([]);
  });

  it('varios candidatos a la vez: cada uno se juzga por su cuenta', () => {
    const store = new ProjectStore();
    const ch = createChannel('sampler', 0, 'Uno');
    store.dispatch({ type: 'addChannel', channel: ch });
    store.dispatch({ type: 'patchChannel', channelId: ch.id, patch: { sampleId: 'vivo' } });
    // 'ya-cayo' nunca entra al historial de este store: es inalcanzable ya.
    const result = store.unreachableIds(['vivo', 'ya-cayo']);
    expect(result).toEqual(['ya-cayo']);
  });
});
