/**
 * La identidad de las operaciones que traen un proyecto de fuera (la clase de
 * los BUG 019–022 y 031/032/034): una operación asíncrona que termina tarde
 * tiene que aplicarse SOLO si todavía es la que el usuario quiso.
 *
 * BUG 019 — recuperar un autosave conservaba la ruta del proyecto que estaba
 * abierto: el proyecto recuperado es trabajo SIN guardar (el propio autosave es
 * su única red), y con la ruta heredada el siguiente Ctrl+S escribía POR
 * ENCIMA de la otra canción. Aceptación: recuperación deja `path: null`,
 * Guardar pide destino y el archivo de antes queda intacto.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, serializeProject } from '@orbit/core';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

interface Guardado {
  path: string | null;
  json: string;
}

/** Arnés: store y parse REALES; el IPC son promesas que el test controla. */
async function rig() {
  vi.resetModules();
  const guardados: Guardado[] = [];

  let resolverOpen: (r: { path: string; json: string } | null) => void = () => undefined;
  let resolverRecent: (r: { path: string; json: string } | null) => void = () => undefined;

  vi.stubGlobal('window', {
    confirm: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    orbit: {
      app: { setDirty: () => undefined },
      project: {
        open: () =>
          new Promise<{ path: string; json: string } | null>((r) => (resolverOpen = r)),
        openRecent: () =>
          new Promise<{ path: string; json: string } | null>((r) => (resolverRecent = r)),
        save: async (path: string | null, json: string) => {
          guardados.push({ path, json });
          return path ?? 'C:/Music/nuevo-orbit';
        },
        recent: async () => [],
        forgetRecent: async () => undefined,
      },
      autosave: {
        check: async () => null,
        clear: async () => undefined,
        read: async () => null,
        write: async () => undefined,
      },
      recording: {
        save: async (name: string) => name,
        read: async () => new ArrayBuffer(8),
        discard: async (files: readonly string[]) => [...files],
      },
      settings: { get: async () => ({}), set: async () => undefined },
    },
  });
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const projectFile = await import('../src/state/project-file');
  const autosave = await import('../src/state/autosave');

  return {
    core,
    app,
    projectFile,
    autosave,
    guardados,
    abrirA: (r: { path: string; json: string } | null) => resolverOpen(r),
    abrirReciente: (r: { path: string; json: string } | null) => resolverRecent(r),
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Un .orbit de mentira con título propio, tal cual lo leería `applyOpened`. */
function orbitDe(r: Rig, titulo: string, path = `C:/Music/${titulo}.orbit`) {
  return { path, json: serializeProject(conTitulo(r, titulo)) };
}

function conTitulo(r: Rig, titulo: string) {
  const p = createEmptyProject(titulo);
  p.meta.title = titulo;
  return p;
}

describe('BUG 019: recuperar un autosave no hereda la ruta del proyecto anterior', () => {
  it('la recuperación deja path: null y Guardar pide destino en vez de pisar A', async () => {
    const r = await rig();
    // Proyecto A abierto y guardado: hay una ruta que proteger.
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/project-A.orbit' });
    r.autosave.markClean();

    const ok = r.autosave.applyRecovery({
      json: serializeProject(conTitulo(r, 'Recovered B')),
      mtimeMs: 1,
    });

    expect(ok).toBe(true);
    expect(r.app.store.project.meta.title).toBe('Recovered B');
    // Sin ruta: el proyecto recuperado no es el archivo A.
    expect(r.projectFile.useProjectFile.getState().path).toBeNull();
    // Y como no está guardado como .orbit, tiene cambios sin guardar.
    expect(r.autosave.isDirty()).toBe(true);

    // El siguiente Guardar pide destino (path null → diálogo)…
    await r.projectFile.saveProject();
    expect(r.guardados).toHaveLength(1);
    expect(r.guardados[0]!.path).toBeNull();
    // …y nunca se escribió en la ruta A: el archivo de antes queda intacto.
    expect(r.guardados.map((g) => g.path)).not.toContain('C:/Music/project-A.orbit');
    // Tras guardar con destino, el proyecto YA tiene su propia ruta.
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/nuevo-orbit');
  });

  it('si el usuario cancela la guardia, ni el proyecto ni la ruta se tocan', async () => {
    const r = await rig();
    vi.stubGlobal('window', {
      ...((globalThis as { window?: unknown }).window as object),
      confirm: () => false,
    });
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/project-A.orbit' });
    // Con cambios sin guardar, la guardia pregunta (y la respuesta es NO).
    r.autosave.markCleanAt(r.app.store.version - 1);

    const ok = r.autosave.applyRecovery({
      json: serializeProject(conTitulo(r, 'Recovered B')),
      mtimeMs: 1,
    });

    expect(ok).toBe(false);
    expect(r.app.store.project.meta.title).not.toBe('Recovered B');
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/project-A.orbit');
    expect(r.guardados).toEqual([]);
  });
});
