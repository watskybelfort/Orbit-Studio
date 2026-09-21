/**
 * Invariantes de los comandos que la auditoría destapó: apply+invert=identidad
 * también cuando la clave no existía o el contenedor era opcional, ids que no
 * se duplican, guardias de índice -1 y rangos de ruta.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createPattern,
  newId,
  ProjectStore,
  type Command,
  type Project,
} from '../src/index';

const snap = (p: Project): string => JSON.stringify(p);

/** apply + inverso = identidad byte a byte. */
function expectInvertible(p: Project, cmd: Command): void {
  const before = snap(p);
  const inv = applyCommand(p, cmd);
  applyCommand(p, inv);
  expect(snap(p)).toBe(before);
}

describe('add* con un id que ya existe: rechaza en vez de duplicar el orden', () => {
  it('addChannel repetido no duplica el id ni borra el original al deshacer', () => {
    const store = new ProjectStore();
    const ch = createChannel('sub808', 0);
    store.dispatch({ type: 'addChannel', channel: ch });
    const before = snap(store.project);
    const entries = store.historyView().entries.length;

    expect(() => store.dispatch({ type: 'addChannel', channel: ch })).toThrow(/Ya existe/);
    expect(snap(store.project)).toBe(before);
    expect(store.project.channelOrder.filter((id) => id === ch.id)).toHaveLength(1);
    expect(store.historyView().entries).toHaveLength(entries);

    // Deshacer el add original borra el canal UNA vez, sin orden colgante.
    expect(store.undo()).toBe(true);
    expect(store.project.channels[ch.id]).toBeUndefined();
    expect(store.project.channelOrder).not.toContain(ch.id);
  });

  it('addPattern, addChannelGroup y addArrangement también rechazan el id repetido', () => {
    const p = createEmptyProject();

    const pat = createPattern(1);
    applyCommand(p, { type: 'addPattern', pattern: pat });
    expect(() => applyCommand(p, { type: 'addPattern', pattern: pat })).toThrow(/Ya existe/);
    expect(p.patternOrder.filter((id) => id === pat.id)).toHaveLength(1);

    const group = { id: newId(), name: 'Batería', color: '#abcdef', collapsed: false };
    applyCommand(p, { type: 'addChannelGroup', group });
    expect(() => applyCommand(p, { type: 'addChannelGroup', group })).toThrow(/Ya existe/);
    expect(p.channelGroupOrder.filter((id) => id === group.id)).toHaveLength(1);

    const arr = { id: newId(), name: 'B' };
    applyCommand(p, { type: 'addArrangement', arrangement: arr });
    expect(() => applyCommand(p, { type: 'addArrangement', arrangement: arr })).toThrow(/Ya existe/);
    expect(p.arrangementOrder.filter((id) => id === arr.id)).toHaveLength(1);
  });
});

describe('set*Param: el inverso borra la clave si no existía (no escribe el 0 por defecto)', () => {
  it('setChannelParam no materializa el default', () => {
    const p = createEmptyProject();
    const ch = createChannel('sub808', 0);
    applyCommand(p, { type: 'addChannel', channel: ch });
    expect('cutoff' in ch.params).toBe(false);
    expectInvertible(p, { type: 'setChannelParam', channelId: ch.id, key: 'cutoff', value: 0.9 });
    expect('cutoff' in ch.params).toBe(false);
  });

  it('setChannelEffectParam no materializa el default', () => {
    const p = createEmptyProject();
    const ch = createChannel('sub808', 0);
    applyCommand(p, { type: 'addChannel', channel: ch });
    const slot = { id: newId(), kind: 'eq' as const, enabled: true, mix: 1, params: { freq: 1 } };
    applyCommand(p, { type: 'setChannelEffect', channelId: ch.id, slotIndex: 0, slot });
    expect('q' in ch.fx![0]!.params).toBe(false);
    expectInvertible(p, {
      type: 'setChannelEffectParam',
      channelId: ch.id,
      slotIndex: 0,
      key: 'q',
      value: 0.7,
    });
    expect('q' in ch.fx![0]!.params).toBe(false);
  });

  it('setEffectParam no materializa el default', () => {
    const p = createEmptyProject();
    const slot = { id: newId(), kind: 'eq' as const, enabled: true, mix: 1, params: {} };
    applyCommand(p, { type: 'setEffect', trackIndex: 1, slotIndex: 0, slot });
    expect('freq' in p.mixer[1]!.slots[0]!.params).toBe(false);
    expectInvertible(p, { type: 'setEffectParam', trackIndex: 1, slotIndex: 0, key: 'freq', value: 500 });
    expect('freq' in p.mixer[1]!.slots[0]!.params).toBe(false);
  });
});

describe('contenedores opcionales: el inverso los quita si antes no existían', () => {
  it('setLayout no deja `layouts` materializado al deshacer el primer layout', () => {
    const store = new ProjectStore();
    expect(store.project.layouts).toBeUndefined();
    const windows = { mixer: { open: true, x: 0, y: 0, w: 100, h: 100 } };
    store.dispatch({ type: 'setLayout', name: 'Mixto', windows });
    expect(store.project.layouts).toBeDefined();
    expect(store.undo()).toBe(true);
    expect(store.project.layouts).toBeUndefined();
    expect(store.redo()).toBe(true);
    expect(store.project.layouts!['Mixto']).toEqual(windows);
  });

  it('setLayout sobre un proyecto que ya traía `layouts` no borra el contenedor', () => {
    const p = createEmptyProject();
    p.layouts = {};
    const cmd: Command = {
      type: 'setLayout',
      name: 'solo',
      windows: { x: { open: false, x: 1, y: 1, w: 2, h: 2 } },
    };
    expectInvertible(p, cmd);
    expect(p.layouts).toEqual({});
  });

  it('el primer efecto sobre un canal legado no deja `fx` materializado al deshacer', () => {
    const store = new ProjectStore();
    const ch = createChannel('sub808', 0);
    delete ch.fx;
    store.dispatch({ type: 'addChannel', channel: ch });
    const slot = { id: newId(), kind: 'eq' as const, enabled: true, mix: 1, params: { freq: 1 } };
    store.dispatch({ type: 'setChannelEffect', channelId: ch.id, slotIndex: 0, slot });
    expect(store.project.channels[ch.id]!.fx).toBeDefined();
    expect(store.undo()).toBe(true);
    expect(store.project.channels[ch.id]!.fx).toBeUndefined();
    expect(store.redo()).toBe(true);
    expect(store.project.channels[ch.id]!.fx![0]).toEqual(slot);
  });
});

describe('removePattern/restorePattern: guardia de índice -1', () => {
  it('un patrón fuera del orden no expulsa al último del orden al borrarlo', () => {
    const p = createEmptyProject();
    const patA = createPattern(1);
    const patB = createPattern(2);
    applyCommand(p, { type: 'addPattern', pattern: patA });
    applyCommand(p, { type: 'addPattern', pattern: patB });
    // Estado desincronizado (merge de colaboración): B está en el pool pero no
    // en el orden. Con index = -1, splice(-1, 1) se llevaría a A.
    p.patternOrder = p.patternOrder.filter((id) => id !== patB.id);
    const orderBefore = [...p.patternOrder];

    const inv = applyCommand(p, { type: 'removePattern', patternId: patB.id });
    expect(p.patternOrder).toEqual(orderBefore);
    expect(p.patterns[patA.id]).toBeDefined();

    applyCommand(p, inv);
    expect(p.patternOrder).toEqual([...orderBefore, patB.id]);
    expect(p.patterns[patA.id]).toBeDefined();
    expect(p.patterns[patB.id]).toBeDefined();
  });
});

describe('setRoute: routeTo debe ser una pista real del mixer', () => {
  it('rechaza índices fuera de rango y deja la ruta anterior intacta', () => {
    const p = createEmptyProject();
    const n = p.mixer.length;
    for (const bad of [-1, n, 1.5, Number.NaN]) {
      expect(() => applyCommand(p, { type: 'setRoute', trackIndex: 1, routeTo: bad })).toThrow(
        /rango/,
      );
    }
    expect(p.mixer[1]!.routeTo).toBe(0);
    // 0 (Master) y el último índice válido se siguen admitiendo.
    expectInvertible(p, { type: 'setRoute', trackIndex: 1, routeTo: 0 });
    expectInvertible(p, { type: 'setRoute', trackIndex: 1, routeTo: n - 1 });
  });
});
