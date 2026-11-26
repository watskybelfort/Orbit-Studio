/**
 * El aviso del panel de versiones cuando algo falla.
 *
 * Las dos rutas que leen por IPC (`refreshVersions` para la lista y
 * `readVersion` para abrir/restaurar) tuvieron durante mucho tiempo un `catch`
 * sin binding que publicaba siempre el mismo texto: «No se pudieron leer las
 * versiones» / «Esa versión no se puede leer». El usuario no podía distinguir
 * un archivo que ya no está de un JSON corrupto o del puente caído, y el
 * mensaje no cambiaba aunque el motivo sí.
 *
 * Ahora el aviso es el motivo real, y el texto genérico queda SOLO de respaldo
 * para cuando lo que se rechaza no es un `Error` (un canal IPC roto puede
 * rechazar con cualquier cosa). Estas dos mitades —propagar y no perder el
 * respaldo— son las que se prueban aquí, una por ruta y por caso.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `versions-race.test.ts`: reimportar el grafo de state/app
// paga la transformación en frío y el primer import se pasa del default de 5 s
// con la máquina cargada.
vi.setConfig({ testTimeout: 60_000 });

async function rig() {
  vi.resetModules();
  const list = vi.fn<() => Promise<{ file: string; at: number; bytes: number }[]>>();
  list.mockResolvedValue([]);
  const read = vi.fn<(projectId: string, file: string) => Promise<string>>();
  const remove = vi.fn<(projectId: string, file: string) => Promise<void>>();
  remove.mockResolvedValue(undefined);
  vi.stubGlobal('window', {
    confirm: () => true,
    orbit: {
      versions: {
        list,
        read,
        save: vi.fn(async () => 'version.orbit'),
        remove,
      },
      app: { setDirty: () => undefined },
      autosave: { clear: async () => undefined },
      project: { open: async () => null, recent: async () => [], save: async () => 'saved.orbit' },
      settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
    },
  });
  const app = await import('../src/state/app');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const mod = await import('../src/state/versions');
  const sounds = await import('../src/browser/sound-actions');
  vi.spyOn(sounds, 'rehydrateSamples').mockResolvedValue([]);
  return { mod, list, read, remove };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('el aviso de versiones lleva el motivo real del fallo', () => {
  it('un error al listar publica el mensaje del IPC, no el genérico', async () => {
    const { mod, list } = await rig();
    list.mockRejectedValueOnce(new Error('EACCES: no se puede leer la carpeta de versiones'));
    await mod.refreshVersions();
    expect(mod.useVersions.getState().notice).toBe('EACCES: no se puede leer la carpeta de versiones');
  });

  it('un rechazo que no es Error al listar conserva el texto de respaldo', async () => {
    const { mod, list } = await rig();
    list.mockRejectedValueOnce('el puente se cayó');
    await mod.refreshVersions();
    expect(mod.useVersions.getState().notice).toBe('No se pudieron leer las versiones');
  });

  it('un error al abrir una versión publica su mensaje y libera busy', async () => {
    const { mod, read } = await rig();
    read.mockRejectedValueOnce(new Error('Esa versión ya no está en el disco'));
    await mod.restoreVersion('1700000000000-vieja.orbit');
    expect(mod.useVersions.getState()).toMatchObject({
      busy: false,
      notice: 'Esa versión ya no está en el disco',
    });
  });

  it('un rechazo que no es Error al abrir una versión conserva el texto de respaldo', async () => {
    const { mod, read } = await rig();
    read.mockRejectedValueOnce(undefined);
    await mod.restoreVersion('1700000000000-vieja.orbit');
    expect(mod.useVersions.getState()).toMatchObject({
      busy: false,
      notice: 'Esa versión no se puede leer',
    });
  });
});

describe('el aviso al borrar una versión', () => {
  it('un error al borrar publica el motivo y deja el diff abierto', async () => {
    const { mod, remove } = await rig();
    mod.useVersions.setState({ openFile: '1700000000000-vieja.orbit' });
    remove.mockRejectedValueOnce(new Error('EPERM: la carpeta de versiones está protegida'));
    await mod.removeVersion('1700000000000-vieja.orbit');
    // Antes el `catch` se comía el motivo: la ✕ no borraba y nada lo decía.
    expect(mod.useVersions.getState()).toMatchObject({
      notice: 'EPERM: la carpeta de versiones está protegida',
      openFile: '1700000000000-vieja.orbit',
    });
  });

  it('un rechazo que no es Error nombra la versión que no se pudo borrar', async () => {
    const { mod, remove } = await rig();
    remove.mockRejectedValueOnce('sin detalle');
    await mod.removeVersion('1700000000000-antes-del-drop.orbit');
    expect(mod.useVersions.getState().notice).toBe('No se pudo borrar la versión «Antes del drop»');
  });

  it('un borrado que va bien no inventa aviso y la versión sale de la lista', async () => {
    const { mod, list } = await rig();
    list.mockResolvedValueOnce([{ file: '1700000000001-otra.orbit', at: 2, bytes: 3 }]);
    await mod.removeVersion('1700000000000-vieja.orbit');
    expect(mod.useVersions.getState().notice).toBeNull();
    expect(mod.useVersions.getState().entries.map((e) => e.file)).toEqual(['1700000000001-otra.orbit']);
  });
});
