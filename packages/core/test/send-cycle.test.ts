import { describe, expect, it } from 'vitest';
import { applyCommand, createEmptyProject, ProjectStore, type Command } from '../src/index';

describe('conexiones del mixer: ningún comando puede cerrar un ciclo', () => {
  it.each(['local', 'claude', 'remote'] as const)('rechaza el envío sin mutar proyecto ni historial (%s)', (origin) => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setRoute', trackIndex: 1, routeTo: 2 });
    const before = structuredClone(store.project);
    const history = store.historyView();
    const version = store.version;
    expect(() => store.dispatch({ type: 'setSend', trackIndex: 2, target: 1, level: 0.5 }, { origin })).toThrow(/ciclo/);
    expect(store.project).toEqual(before);
    expect(store.historyView()).toEqual(history);
    expect(store.version).toBe(version);
  });

  it.each([
    { type: 'setSend', trackIndex: 2, target: 2, level: 1 },
    { type: 'setSend', trackIndex: 2, target: 1, level: 0 },
    { type: 'setSend', trackIndex: 2, target: 1, level: 1, send: { target: 1, level: 1, mute: true } },
    { type: 'patchMixerTrack', trackIndex: 2, patch: { name: 'No debe cambiar', routeTo: 1 } },
  ] satisfies Command[])('también valida autoenvíos, nivel cero, restauración silenciada y patch: %j', (command) => {
    const project = createEmptyProject();
    applyCommand(project, { type: 'setRoute', trackIndex: 1, routeTo: 2 });
    const before = structuredClone(project);
    expect(() => applyCommand(project, command)).toThrow(/ciclo/);
    expect(project).toEqual(before);
  });

  it('recorre rutas y envíos intermedios, sin limitarse al cable inverso', () => {
    const project = createEmptyProject();
    applyCommand(project, { type: 'setSend', trackIndex: 1, target: 2, level: 1 });
    applyCommand(project, { type: 'setRoute', trackIndex: 2, routeTo: 3 });
    expect(() => applyCommand(project, { type: 'setSend', trackIndex: 3, target: 1, level: 1 })).toThrow(/ciclo/);
    expect(project.mixer[3]!.sends).toEqual([]);
  });

  it.each([-1, 999, 1.5, NaN])('rechaza destinos fuera de rango: %s', (target) => {
    const project = createEmptyProject();
    expect(() => applyCommand(project, { type: 'setSend', trackIndex: 1, target, level: 1 })).toThrow(/rango/);
    expect(() => applyCommand(project, { type: 'patchMixerTrack', trackIndex: 1, patch: { routeTo: target } })).toThrow(/rango/);
    expect(project.mixer[1]!.sends).toEqual([]);
    expect(project.mixer[1]!.routeTo).toBe(0);
  });

  it('un envío completo no puede esconder otro destino dentro de send', () => {
    const project = createEmptyProject();
    applyCommand(project, { type: 'setRoute', trackIndex: 1, routeTo: 2 });
    expect(() => applyCommand(project, {
      type: 'setSend', trackIndex: 2, target: 3, level: 1, send: { target: 1, level: 1 },
    })).toThrow(/destino/);
    expect(project.mixer[2]!.sends).toEqual([]);
  });

  it('permite retirar conexiones inválidas heredadas y desconectar una ruta', () => {
    const project = createEmptyProject();
    project.mixer[1]!.sends = [{ target: 1, level: 1 }, { target: 999, level: 1 }];
    applyCommand(project, { type: 'setSend', trackIndex: 1, target: 1, level: null });
    applyCommand(project, { type: 'setSend', trackIndex: 1, target: 999, level: null });
    applyCommand(project, { type: 'patchMixerTrack', trackIndex: 1, patch: { routeTo: null } });
    expect(project.mixer[1]!.sends).toEqual([]);
    expect(project.mixer[1]!.routeTo).toBeNull();
  });

  it('undo conserva el envío entero y espera si otro origen volvió cíclica su restauración', () => {
    const store = new ProjectStore();
    const send = { target: 2, level: 0.4, pan: -0.2, mute: true };
    store.dispatch({ type: 'setSend', trackIndex: 1, target: 2, level: send.level, send });
    store.dispatch({ type: 'setSend', trackIndex: 1, target: 2, level: null }, { origin: 'local' });
    store.dispatch({ type: 'setRoute', trackIndex: 2, routeTo: 1 }, { origin: 'claude' });
    const history = store.historyView();
    expect(store.undo('local')).toBe(false);
    expect(store.historyView()).toEqual(history);
    expect(store.project.mixer[1]!.sends).toEqual([]);
    store.dispatch({ type: 'setRoute', trackIndex: 2, routeTo: 0 }, { origin: 'claude' });
    expect(store.undo('local')).toBe(true);
    expect(store.project.mixer[1]!.sends).toEqual([send]);
    expect(store.redo('local')).toBe(true);
    expect(store.project.mixer[1]!.sends).toEqual([]);
  });
});
