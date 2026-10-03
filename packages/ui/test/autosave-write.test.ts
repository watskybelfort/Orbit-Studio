import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // También permite ejecutar el control negativo sobre el autosave antiguo,
  // que ignoraba por completo la promesa de IPC rechazada.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

async function rig() {
  vi.resetModules();
  vi.useFakeTimers();
  const writes: { json: string; gate: ReturnType<typeof deferred<void>> }[] = [];
  const clears: ReturnType<typeof deferred<void>>[] = [];
  const events: string[] = [];
  const api = {
    check: vi.fn(async () => null),
    write: vi.fn((json: string) => {
      events.push('write');
      const gate = deferred<void>();
      writes.push({ json, gate });
      return gate.promise;
    }),
    clear: vi.fn(() => {
      events.push('clear');
      const gate = deferred<void>();
      clears.push(gate);
      return gate.promise;
    }),
  };
  vi.stubGlobal('window', {
    confirm: () => true,
    orbit: {
      autosave: api,
      app: { setDirty: vi.fn() },
      settings: { get: async () => ({}), set: async (value: unknown) => value },
    },
  });
  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const mod = await import('../src/state/autosave');
  mod.initAutosave();
  return { core, store, mod, api, writes, clears, events };
}

const tick = () => vi.advanceTimersByTimeAsync(60_000);
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('BUG024: autosave confirma la escritura antes de avanzar su checkpoint', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('falla, avisa y reintenta sin nuevas ediciones; solo el éxito detiene los intentos', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    await tick();
    r.writes[0]!.gate.reject(new Error('disk full'));
    await settle();
    expect(r.mod.useAutosave.getState()).toMatchObject({ dirty: true });
    expect(r.mod.useAutosave.getState().error).toMatch(/disk full/);
    expect(r.mod.useAutosave.getState().error).toMatch(/reintentará/i);
    await tick();
    expect(r.writes).toHaveLength(2);
    expect(r.writes[1]!.json).toBe(r.writes[0]!.json);
    r.writes[1]!.gate.resolve();
    await settle();
    expect(r.mod.useAutosave.getState()).toMatchObject({ error: null, dirty: true });
    await tick();
    expect(r.writes).toHaveLength(2);
    expect(r.mod.isDirty()).toBe(true);
  });

  it('un fallo persistente produce como máximo un intento por minuto', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    for (let attempt = 0; attempt < 4; attempt++) {
      await tick();
      expect(r.writes).toHaveLength(attempt + 1);
      r.writes[attempt]!.gate.reject(new Error('sin espacio'));
      await settle();
      expect(r.writes).toHaveLength(attempt + 1);
    }
  });

  it('no solapa escrituras y conserva los cambios hechos durante el IPC', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 110 });
    await tick();
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    await tick();
    await tick();
    expect(r.writes).toHaveLength(1);
    expect(r.core.parseProject(r.writes[0]!.json).tempo).toBe(110);
    r.writes[0]!.gate.resolve();
    await settle();
    await tick();
    expect(r.writes).toHaveLength(2);
    expect(r.core.parseProject(r.writes[1]!.json).tempo).toBe(177);
    r.writes[1]!.gate.resolve();
    await settle();
  });

  it.each(['success', 'error'] as const)('una respuesta %s de A no publica sobre la nueva sesión del mismo id', async (outcome) => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 110 });
    await tick();
    r.store.replaceProject(r.store.project);
    r.mod.useAutosave.setState({ error: 'Aviso de la nueva sesión' });
    if (outcome === 'success') r.writes[0]!.gate.resolve();
    else r.writes[0]!.gate.reject(new Error('Error de A'));
    await settle();
    expect(r.mod.useAutosave.getState().error).toBe('Aviso de la nueva sesión');
    await tick();
    expect(r.writes).toHaveLength(2);
    r.writes[1]!.gate.resolve();
    await settle();
    expect(r.mod.useAutosave.getState().error).toBeNull();
  });

  it('guardar B espera la escritura A y su clear termina antes del autosave de B', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 110 });
    await tick();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    r.mod.markClean();
    expect(r.events).toEqual(['write']);
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    r.writes[0]!.gate.resolve();
    await settle();
    expect(r.events).toEqual(['write', 'clear']);
    await tick();
    expect(r.writes).toHaveLength(1);
    r.clears[0]!.resolve();
    await settle();
    await tick();
    expect(r.events).toEqual(['write', 'clear', 'write']);
    const pendingB = r.core.parseProject(r.writes[1]!.json);
    expect(pendingB.meta.title).toBe('B');
    expect(pendingB.tempo).toBe(177);
    r.writes[1]!.gate.resolve();
    await settle();
  });

  it('un clear encolado de B no se ejecuta si C lo reemplazó sin guardar', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 110 });
    await tick();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    r.mod.markClean();
    r.store.replaceProject(r.core.createEmptyProject('C'));
    r.writes[0]!.gate.resolve();
    await settle();
    expect(r.api.clear).not.toHaveBeenCalled();
    await tick();
    expect(r.core.parseProject(r.writes[1]!.json).meta.title).toBe('C');
    r.writes[1]!.gate.resolve();
    await settle();
  });

  it.each(['success', 'error'] as const)('guardar manualmente invalida el %s del autosave anterior sin reensuciar', async (outcome) => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 110 });
    await tick();
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    r.mod.markClean();
    if (outcome === 'success') r.writes[0]!.gate.resolve();
    else r.writes[0]!.gate.reject(new Error('autosave anterior'));
    await settle();
    r.clears[0]!.resolve();
    await settle();
    await tick();
    expect(r.writes).toHaveLength(1);
    expect(r.mod.useAutosave.getState()).toMatchObject({ dirty: false, error: null });
  });

  it('guardar una foto anterior no limpia el pending de ediciones posteriores', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 110 });
    const saved = r.store.version;
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    r.mod.markCleanAt(saved);
    expect(r.api.clear).not.toHaveBeenCalled();
    await tick();
    expect(r.core.parseProject(r.writes[0]!.json).tempo).toBe(177);
    expect(r.mod.isDirty()).toBe(true);
    r.writes[0]!.gate.resolve();
    await settle();
  });

  it.each(['serialize', 'write'] as const)('captura también el fallo síncrono de %s y reintenta', async (stage) => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    if (stage === 'serialize') vi.spyOn(r.core, 'serializeProject').mockImplementationOnce(() => { throw new Error('no se puede serializar'); });
    else r.api.write.mockImplementationOnce(() => { throw new Error('IPC no disponible'); });
    await tick();
    expect(r.mod.useAutosave.getState().error).toMatch(stage === 'serialize' ? /serializar/ : /IPC/);
    await tick();
    expect(r.writes).toHaveLength(1);
    r.writes[0]!.gate.resolve();
    await settle();
    expect(r.mod.useAutosave.getState().error).toBeNull();
  });

  it('retira el error de escritura al cambiar de proyecto', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    await tick();
    r.writes[0]!.gate.reject(new Error('disco A'));
    await settle();
    expect(r.mod.useAutosave.getState().error).toMatch(/disco A/);
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.mod.useAutosave.getState().error).toBeNull();
  });

  it('el shell muestra el error de autosave aunque no haya oferta de recuperación', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/const autosaveNotice = recovery \? null : recoveryError;/);
    expect(source).toMatch(/bounceBusy \?\? bounceNotice \?\? autosaveNotice \?\? notice/);
    expect(source).toMatch(/className="app-notice popup" role="status"/);
  });
});
