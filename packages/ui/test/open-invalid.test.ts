/**
 * BUG 017 del lado de la UI: abrir un `.orbit` que no se puede leer tiene que
 * dejar la sesión como estaba.
 *
 * Es la otra mitad del contrato. El validador de `parseProject` rechaza el
 * archivo (eso está en core), pero lo que de verdad importa para quien está
 * delante es que un archivo roto no se coma el proyecto que tenía abierto: el
 * proyecto, el historial y la marca de cambios sin guardar tienen que ser los
 * mismos después del intento, y el error tienen que salir en el aviso.
 *
 * Sin DOM: el store es un zustand, el aviso es un estado, y el diálogo de abrir
 * se sustituye por un `window.orbit` de mentira (mismo arnés que
 * `autosave-recovery.test.ts`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `autosave-recovery.test.ts`: reimportar el grafo de
// state/app paga la transformación, y con la máquina bajo carga el primer import
// se pasa de los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

interface Rig {
  core: typeof import('@orbit/core');
  store: typeof import('../src/state/app')['store'];
  mod: typeof import('../src/state/project-file');
  autosave: typeof import('../src/state/autosave');
  archivo: { open: ReturnType<typeof vi.fn> };
}

/** Un solo módulo por test: el store es singleton dentro del registro. */
async function rig(): Promise<Rig> {
  vi.resetModules();
  const archivo = { open: vi.fn(async () => null) };
  vi.stubGlobal('window', {
    confirm: vi.fn(() => true),
    orbit: {
      project: { open: archivo.open, save: vi.fn(), saveAs: vi.fn() },
      autosave: { check: vi.fn(async () => null), write: vi.fn(), clear: vi.fn() },
      app: { setDirty: vi.fn(), play: vi.fn() },
      settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
      recents: { list: vi.fn(async () => []), touch: vi.fn(), remove: vi.fn() },
    },
  });
  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const mod = await import('../src/state/project-file');
  // La marca de cambios sin guardar vive en el modulo del autosave, no en el store.
  const autosave = await import('../src/state/autosave');
  return { core, store, mod, archivo, autosave };
}

/** Un `.orbit` inválido por partida doble: tipo raro y obligatorio que falta. */
function invalido(core: typeof import('@orbit/core'), rompe: (d: Record<string, unknown>) => void) {
  const data = JSON.parse(core.serializeProject(core.createEmptyProject('nuevo'))) as Record<
    string,
    unknown
  >;
  rompe(data);
  return JSON.stringify(data);
}

describe('abrir un .orbit inválido no deja la sesión a medias', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('el proyecto, el historial y la marca de cambios siguen como estaban', async () => {
    const { core, store, mod, archivo, autosave } = await rig();
    // Sesión real antes del intento: un comando y cambios sin guardar.
    store.dispatch({ type: 'setTempo', tempo: 99 }, { label: 'tempo' });
    const historialAntes = store.history.length;
    const tituloAntes = store.project.meta.title;
    expect(autosave.isDirty()).toBe(true);

    archivo.open.mockResolvedValue({
      path: '/x/roto.orbit',
      json: invalido(core, (d) => (d.swing = 'wrong')),
    });
    await mod.openProject();

    // El proyecto sigue siendo el de antes, con su historial y su marca.
    expect(store.project.tempo).toBe(99);
    expect(store.project.meta.title).toBe(tituloAntes);
    expect(store.history.length).toBe(historialAntes);
    expect(autosave.isDirty()).toBe(true);
    // Y el error se dice, con el campo que lo causó.
    expect(mod.useProjectFile.getState().notice).toMatch(/swing/);
  });

  it('un patrón sin `notes` tampoco, y sigue sonando el proyecto anterior', async () => {
    const { core, store, mod, archivo, autosave } = await rig();
    store.dispatch({ type: 'setTempo', tempo: 128 }, { label: 'tempo' });
    const historialAntes = store.history.length;

    archivo.open.mockResolvedValue({
      path: '/x/sin-notes.orbit',
      json: invalido(core, (d) => {
        const patron = Object.values(d.patterns as Record<string, Record<string, unknown>>)[0]!;
        delete patron.notes;
      }),
    });
    await mod.openProject();

    expect(store.project.tempo).toBe(128);
    expect(store.history.length).toBe(historialAntes);
    expect(mod.useProjectFile.getState().notice).toMatch(/notes/);
    // La ruta del proyecto abierto tampoco se movió: sigue el que estaba.
    expect(mod.useProjectFile.getState().path).toBeNull();
  });

  it('un .orbit bueno sí reemplaza (el camino feliz no se rompió)', async () => {
    const { core, store, mod, archivo, autosave } = await rig();
    store.dispatch({ type: 'setTempo', tempo: 99 }, { label: 'tempo' });

    const bueno = core.serializeProject(core.createEmptyProject('el bueno'));
    archivo.open.mockResolvedValue({ path: '/x/bueno.orbit', json: bueno });
    await mod.openProject();

    expect(store.project.meta.title).toBe('el bueno');
    expect(mod.useProjectFile.getState().path).toBe('/x/bueno.orbit');
    expect(autosave.isDirty()).toBe(false);
  });
});