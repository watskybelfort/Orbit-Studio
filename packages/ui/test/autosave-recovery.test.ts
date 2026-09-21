/**
 * El cartel de recuperación del autosave, por los dos lados que nadie cubría:
 *
 * - **«Recuperar» es un reemplazo total del proyecto**, igual que abrir un
 *   `.orbit` o cargar una plantilla, y esos caminos preguntan por los cambios
 *   sin guardar (`confirmDiscard`, ver `project-file.ts`). El botón no lo hacía:
 *   pulsarlo con trabajo sucio encima lo enterraba sin decir nada.
 * - **Mientras el cartel sigue sin resolver**, el bucle del autosave (que
 *   arranca justo después de ofrecer la recuperación) seguía escribiendo
 *   `pending.orbit`: la red que el usuario tiene delante podía dejar de ser
 *   la que le ofrecieron y pasar a ser lo que se acaba de editar. Se impide
 *   escribir hasta que el usuario pulse Recuperar o Descartar.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

interface FakeAutosaveApi {
  check: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
}

interface Rig {
  core: typeof import('@orbit/core');
  store: typeof import('../src/state/app')['store'];
  mod: typeof import('../src/state/autosave');
  confirm: ReturnType<typeof vi.fn>;
  autosave: FakeAutosaveApi;
}

/**
 * Un `autosave` recién nacido por test: los contadores de versión y el flag de
 * recuperación pendiente viven en variables de módulo, así que sin
 * `vi.resetModules()` un test heredaría el estado del anterior.
 */
async function rig(): Promise<Rig> {
  vi.resetModules();
  const confirm = vi.fn(() => false);
  const autosave: FakeAutosaveApi = {
    check: vi.fn(async () => null),
    write: vi.fn(async (_json: string) => undefined),
    clear: vi.fn(async () => undefined),
  };
  vi.stubGlobal('window', {
    confirm,
    orbit: {
      autosave,
      app: { setDirty: vi.fn() },
      settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
    },
  });
  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const mod = await import('../src/state/autosave');
  return { core, store, mod, confirm, autosave };
}

describe('autosave: «Recuperar» no pisa el proyecto sin preguntar', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('con cambios sin guardar y confirm=false: no reemplaza y devuelve false', async () => {
    const { core, store, mod, confirm } = await rig();
    store.dispatch({ type: 'setTempo', tempo: 99 }, { label: 'tempo' });
    expect(mod.isDirty()).toBe(true);

    const json = core.serializeProject(core.createEmptyProject('otro'));
    const ok = mod.applyRecovery({ json, mtimeMs: 1 });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
    // Ni el proyecto ni su historial se tocaron.
    expect(store.project.tempo).toBe(99);
    expect(store.project.meta.title).toBe('Nuevo proyecto');
    expect(store.history.length).toBe(1);
  });

  it('con el usuario de acuerdo: reemplaza y el autosave vuelve a escribir', async () => {
    vi.useFakeTimers();
    const { core, store, mod, confirm, autosave } = await rig();
    confirm.mockReturnValue(true);
    mod.initAutosave();

    const json = core.serializeProject(core.createEmptyProject('recuperado'));
    expect(mod.applyRecovery({ json, mtimeMs: 1 })).toBe(true);
    expect(store.project.meta.title).toBe('recuperado');

    store.dispatch({ type: 'setTempo', tempo: 88 }, { label: 'tempo' });
    vi.advanceTimersByTime(60_000);
    expect(autosave.write).toHaveBeenCalledTimes(1);
  });
});

describe('autosave: el pendiente no se pisa mientras el cartel está sin resolver', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('no escribe pending.orbit hasta que el usuario recupera o descarta', async () => {
    vi.useFakeTimers();
    const { core, store, mod, autosave } = await rig();
    autosave.check.mockResolvedValue({
      json: core.serializeProject(core.createEmptyProject('de la sesión anterior')),
      mtimeMs: 1,
    });
    const offer = await mod.checkRecovery();
    expect(offer).not.toBeNull();

    mod.initAutosave();
    store.dispatch({ type: 'setTempo', tempo: 90 }, { label: 'tempo' });
    vi.advanceTimersByTime(60_000);
    // El cartel sigue ahí: la red no puede dejar de ser lo que se ofreció.
    expect(autosave.write).not.toHaveBeenCalled();

    mod.discardRecovery();
    vi.advanceTimersByTime(60_000);
    // Resuelto el cartel, el bucle vuelve a proteger el trabajo en curso.
    expect(autosave.write).toHaveBeenCalledTimes(1);
  });
});
