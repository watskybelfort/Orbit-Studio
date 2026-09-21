/**
 * Carreras de lectura en el panel de versiones.
 *
 * `openVersionDiff` y `restoreVersion` leen el `.orbit` de la versión por IPC:
 * entre pedirlo y tenerlo pasa tiempo real, y el usuario puede pedir OTRA cosa
 * mientras. Sin token de petición, la respuesta lenta pisa el estado de la
 * nueva: abres la versión A, te arrepientes y abres la B, y cuando por fin
 * llega A el panel enseña el diff de A como si fuera lo que pediste.
 *
 * La salida es un contador de secuencia por panel: cada respuesta comprueba
 * que sigue siendo la última antes de escribir nada.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

interface Rig {
  core: typeof import('@orbit/core');
  store: typeof import('../src/state/app')['store'];
  mod: typeof import('../src/state/versions');
  read: ReturnType<typeof vi.fn>;
  /** Resuelve la lectura pendiente de ese archivo con el JSON dado. */
  resolveRead: (file: string, json: string) => void;
}

async function rig(): Promise<Rig> {
  vi.resetModules();
  const pending = new Map<string, (json: string) => void>();
  const read = vi.fn(
    (_projectId: string, file: string) =>
      new Promise<string>((resolve) => {
        pending.set(file, resolve);
      }),
  );
  vi.stubGlobal('window', {
    orbit: {
      versions: {
        list: vi.fn(async () => []),
        save: vi.fn(async () => 'version.orbit'),
        read,
        remove: vi.fn(async () => undefined),
      },
      settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
    },
  });

  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const mod = await import('../src/state/versions');

  return {
    core,
    store,
    mod,
    read,
    resolveRead: (file, json) => {
      const resolve = pending.get(file);
      if (!resolve) throw new Error(`no hay lectura pendiente de ${file}`);
      resolve(json);
    },
  };
}

describe('versions: una lectura lenta no pisa lo que se abrió después', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('el diff de la versión abierta después sobrevive a la respuesta vieja', async () => {
    const { core, mod, resolveRead } = await rig();
    const slow = core.createEmptyProject('lenta');
    slow.tempo = 100;
    const fast = core.createEmptyProject('rápida');
    fast.tempo = 150;

    const slowCall = mod.openVersionDiff('slow.orbit');
    const fastCall = mod.openVersionDiff('fast.orbit');

    resolveRead('fast.orbit', core.serializeProject(fast));
    await fastCall;
    expect(mod.useVersions.getState().openFile).toBe('fast.orbit');

    resolveRead('slow.orbit', core.serializeProject(slow));
    await slowCall;
    // La respuesta de la primera petición llega tarde: se descarta.
    expect(mod.useVersions.getState().openFile).toBe('fast.orbit');
  });

  it('una restauración vieja no reemplaza el proyecto que se restauró después', async () => {
    const { core, store, mod, resolveRead } = await rig();
    const slow = core.createEmptyProject('lenta');
    slow.tempo = 99;
    const fast = core.createEmptyProject('rápida');
    fast.tempo = 111;

    const slowCall = mod.restoreVersion('slow.orbit');
    const fastCall = mod.restoreVersion('fast.orbit');

    resolveRead('fast.orbit', core.serializeProject(fast));
    await fastCall;
    expect(store.project.tempo).toBe(111);

    resolveRead('slow.orbit', core.serializeProject(slow));
    await slowCall;
    expect(store.project.tempo).toBe(111);
    expect(store.project.meta.title).toBe('rápida');
  });
});
