/**
 * El contrato del bus con el historial: un inverso que no aplica (la entidad la
 * borró otro origen, una guardia de forward lo veta…) no puede llevarse por
 * delante la entrada. Antes de la revisión, `undo()`/`redo()` hacían `splice`
 * ANTES de aplicar y la entrada desaparecía del historial, con la excepción
 * subiendo a la UI (que no la captura).
 */

import { describe, expect, it } from 'vitest';
import { createChannel, ProjectStore } from '../src/index';

describe('undo/redo: un inverso que lanza no se lleva la entrada por delante', () => {
  it('la entidad la borró otro origen: undo local devuelve false y deja todo igual', () => {
    const store = new ProjectStore();
    const ch = createChannel('sub808', 0);
    store.dispatch({ type: 'addChannel', channel: ch }, { origin: 'local' });
    store.dispatch({ type: 'removeChannel', channelId: ch.id }, { origin: 'claude' });

    const view = store.historyView();
    const version = store.version;

    expect(store.undo('local')).toBe(false);
    // Ni el proyecto, ni la versión (no hubo emit), ni el historial se movieron.
    expect(store.project.channels[ch.id]).toBeUndefined();
    expect(store.version).toBe(version);
    expect(store.historyView().entries.map((e) => e.id)).toEqual(view.entries.map((e) => e.id));
    expect(store.historyView().present).toBe(view.present);

    // La entrada local sobrevive: en cuanto Claude repone el canal, el undo aplica.
    expect(store.undo('claude')).toBe(true);
    expect(store.project.channels[ch.id]).toBeDefined();
    expect(store.undo('local')).toBe(true);
    expect(store.project.channels[ch.id]).toBeUndefined();
    expect(store.project.channelOrder).not.toContain(ch.id);
  });

  it('setRoute cuyo inverso cerraría ciclo: undo local devuelve false y la entrada sobrevive', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 2 });
    store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 3 }, { origin: 'local' });
    // Un send de la 2 a la 1 convierte el inverso (1 → 2) en ciclo.
    store.dispatch({ type: 'setSend', trackIndex: 2, target: 1, level: 0.5 }, { origin: 'claude' });

    const view = store.historyView();
    expect(store.undo('local')).toBe(false);
    expect(store.project.mixer[1]!.routeTo).toBe(3);
    expect(store.historyView().entries.map((e) => e.id)).toEqual(view.entries.map((e) => e.id));
    expect(store.historyView().present).toBe(view.present);

    // Sin el send, el mismo undo ya aplica: la entrada no se perdió.
    store.dispatch({ type: 'setSend', trackIndex: 2, target: 1, level: null }, { origin: 'claude' });
    expect(store.undo('local')).toBe(true);
    expect(store.project.mixer[1]!.routeTo).toBe(2);
  });

  it('redo: si el inverso lanza, la entrada del futuro tampoco se pierde', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 2 });
    store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 3 }, { origin: 'local' });
    expect(store.undo('local')).toBe(true); // vuelve a 2 → queda en el futuro
    // 3 →(send)→ 1 hace que rehacer 1 → 3 cierre ciclo.
    store.dispatch({ type: 'setSend', trackIndex: 3, target: 1, level: 0.5 }, { origin: 'claude' });

    const view = store.historyView();
    expect(store.redo('local')).toBe(false);
    expect(store.project.mixer[1]!.routeTo).toBe(2);
    expect(store.historyView().entries.map((e) => e.id)).toEqual(view.entries.map((e) => e.id));
    expect(store.historyView().present).toBe(view.present);

    store.dispatch({ type: 'setSend', trackIndex: 3, target: 1, level: null }, { origin: 'claude' });
    expect(store.redo('local')).toBe(true);
    expect(store.project.mixer[1]!.routeTo).toBe(3);
  });
});
