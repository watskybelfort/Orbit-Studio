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

type OpenResult = { path: string; json: string } | null;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Arnés: store y parse REALES; el IPC son promesas que el test controla. */
async function rig({ deferSaves = false } = {}) {
  vi.resetModules();
  const guardados: Guardado[] = [];

  const openings: ReturnType<typeof deferred<OpenResult>>[] = [];
  const recents: ReturnType<typeof deferred<OpenResult>>[] = [];
  const refreshRecents = vi.fn(async () => []);
  const saves: (Guardado & ReturnType<typeof deferred<string | null>>)[] = [];
  const saveWaiters = new Map<number, ReturnType<typeof deferred<(typeof saves)[number]>>>();
  const versionWrites: { projectId: string; label: string; json: string }[] = [];
  const versionsApi = {
    save: vi.fn(async (projectId: string, label: string, json: string) => {
      versionWrites.push({ projectId, label, json });
      return 'version.orbit';
    }),
    list: vi.fn(async (): Promise<{ file: string; at: number; bytes: number }[]> => []),
  };

  vi.stubGlobal('window', {
    confirm: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    orbit: {
      app: { setDirty: () => undefined },
      project: {
        open: () => {
          const pending = deferred<OpenResult>();
          openings.push(pending);
          return pending.promise;
        },
        openRecent: () => {
          const pending = deferred<OpenResult>();
          recents.push(pending);
          return pending.promise;
        },
        save: async (path: string | null, json: string) => {
          guardados.push({ path, json });
          if (deferSaves) {
            const pending = { path, json, ...deferred<string | null>() };
            saves.push(pending);
            saveWaiters.get(saves.length - 1)?.resolve(pending);
            return pending.promise;
          }
          return path ?? 'C:/Music/nuevo-orbit';
        },
        recent: refreshRecents,
        forgetRecent: async () => undefined,
      },
      versions: versionsApi,
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
  const versions = await import('../src/state/versions');
  const sounds = await import('../src/browser/sound-actions');
  const rehydrate = vi.spyOn(sounds, 'rehydrateSamples').mockResolvedValue([]);

  return {
    core,
    app,
    projectFile,
    autosave,
    guardados,
    openings,
    recents,
    refreshRecents,
    rehydrate,
    versions,
    versionsApi,
    versionWrites,
    saves,
    waitForSave: (index: number) => {
      if (saves[index]) return Promise.resolve(saves[index]);
      const waiter = deferred<(typeof saves)[number]>();
      saveWaiters.set(index, waiter);
      return waiter.promise;
    },
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

/** Foto de todo lo que una respuesta obsoleta NO debe tocar, incluidos los
 * efectos que cargan audio o actualizan los menús. */
function currentState(r: Rig) {
  return {
    project: serializeProject(r.app.store.project),
    version: r.app.store.version,
    epoch: r.app.store.historyEpoch,
    file: { ...r.projectFile.useProjectFile.getState() },
    dirty: r.autosave.isDirty(),
    rehydrates: r.rehydrate.mock.calls.length,
    refreshes: r.refreshRecents.mock.calls.length,
  };
}

function beginOpen(r: Rig, kind: 'dialog' | 'recent') {
  const done = kind === 'dialog' ? r.projectFile.openProject() : r.projectFile.openRecentProject('C:/Music/recent.orbit');
  const queue = kind === 'dialog' ? r.openings : r.recents;
  return { done, ...queue[queue.length - 1]! };
}

describe('BUG 020: solo la apertura vigente puede sustituir el proyecto', () => {
  it.each([
    ['dialog', 'dialog'], ['dialog', 'recent'], ['recent', 'dialog'], ['recent', 'recent'],
  ] as const)('A %s lenta no pisa B %s ya abierta ni sus ediciones', async (first, second) => {
    const r = await rig();
    const a = beginOpen(r, first);
    const b = beginOpen(r, second);
    b.resolve(orbitDe(r, 'B'));
    await b.done;
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    const before = currentState(r);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
    expect(r.app.store.project.meta.title).toBe('B');
  });

  it('A tampoco puede aplicarse mientras B más reciente sigue leyendo', async () => {
    const r = await rig();
    const a = beginOpen(r, 'dialog');
    const b = beginOpen(r, 'recent');
    const before = currentState(r);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
    b.resolve(orbitDe(r, 'B'));
    await b.done;
    expect(r.app.store.project.meta.title).toBe('B');
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/B.orbit');
  });

  it.each(['dialog', 'recent'] as const)('cancelar B %s mantiene el proyecto vigente e invalida A anterior', async (kind) => {
    const r = await rig();
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/current.orbit' });
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    const a = beginOpen(r, 'dialog');
    const b = beginOpen(r, kind);
    const before = currentState(r);
    b.resolve(null);
    await b.done;
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
  });

  it.each(['dialog', 'recent'] as const)('proyecto nuevo invalida la apertura %s pendiente', async (kind) => {
    const r = await rig();
    const a = beginOpen(r, kind);
    r.projectFile.newProject();
    const before = currentState(r);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
    expect(r.projectFile.useProjectFile.getState().path).toBeNull();
  });

  it('recuperar un autosave invalida una apertura sin tocar autosave ni perder el dirty', async () => {
    const r = await rig();
    const a = beginOpen(r, 'dialog');
    expect(r.autosave.applyRecovery({ json: orbitDe(r, 'Recuperado').json, mtimeMs: 1 })).toBe(true);
    const before = currentState(r);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
    expect(r.autosave.isDirty()).toBe(true);
  });

  it.each(['mismo-id', 'misma-referencia', 'otra-sala'])('un replaceProject externo (%s) invalida la lectura pendiente', async (kind) => {
    const r = await rig();
    const a = beginOpen(r, 'recent');
    // Versiones y salas usan esta misma puerta del store. Una restauración
    // puede conservar id; una re-derivación incluso entregar el mismo objeto.
    const replacement = kind === 'misma-referencia' ? r.app.store.project : conTitulo(r, 'Restaurado/sala');
    if (kind === 'mismo-id') replacement.id = r.app.store.project.id;
    r.app.store.replaceProject(replacement);
    const before = currentState(r);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
  });

  it('editar normalmente durante la lectura no bloquea edición ni invalida la apertura elegida', async () => {
    const r = await rig();
    const a = beginOpen(r, 'dialog');
    const epoch = r.app.store.historyEpoch;
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    expect(r.app.store.project.tempo).toBe(177);
    expect(r.app.store.historyEpoch).toBe(epoch);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(r.app.store.project.meta.title).toBe('A');
  });

  it('rechazar confirmDiscard no inicia otra solicitud ni cambia la intención anterior', async () => {
    const r = await rig();
    const a = beginOpen(r, 'dialog');
    r.autosave.markCleanAt(r.app.store.version - 1);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const before = currentState(r);
    r.projectFile.newProject();
    await r.projectFile.openRecentProject('C:/Music/B.orbit');
    expect(r.recents).toHaveLength(0);
    expect(currentState(r)).toEqual(before);
    a.resolve(orbitDe(r, 'A'));
    await a.done;
    expect(r.app.store.project.meta.title).toBe('A');
  });

  it.each(['dialog', 'recent'] as const)('el error tardío de %s no pisa avisos ni refresca recientes', async (kind) => {
    const r = await rig();
    const a = beginOpen(r, kind);
    r.projectFile.newProject();
    const before = currentState(r);
    a.reject(new Error('No se puede leer A'));
    await a.done;
    expect(currentState(r)).toEqual(before);
  });

  it('un error vigente informa sin destruir proyecto, ruta o cambios', async () => {
    const r = await rig();
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/current.orbit' });
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    const before = currentState(r);
    const a = beginOpen(r, 'dialog');
    a.reject(new Error('No se puede leer A'));
    await a.done;
    expect(currentState(r)).toEqual({ ...before, file: { ...before.file, notice: 'No se puede leer A' } });
  });

  it('el error de A tampoco se publica mientras B más reciente sigue pendiente', async () => {
    const r = await rig();
    const a = beginOpen(r, 'recent');
    const b = beginOpen(r, 'dialog');
    const before = currentState(r);
    a.reject(new Error('Fallo viejo'));
    await a.done;
    expect(currentState(r)).toEqual(before);
    b.resolve(null);
    await b.done;
  });

  it('un JSON inválido obsoleto no se parsea ni pisa el aviso de B', async () => {
    const r = await rig();
    const a = beginOpen(r, 'recent');
    const b = beginOpen(r, 'dialog');
    b.resolve(orbitDe(r, 'B'));
    await b.done;
    const before = currentState(r);
    a.resolve({ path: 'C:/Music/A.orbit', json: 'no es JSON' });
    await a.done;
    expect(currentState(r)).toEqual(before);
  });

  it('el parse inválido vigente avisa y conserva la ruta y la música actual', async () => {
    const r = await rig();
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/current.orbit' });
    const before = currentState(r);
    const a = beginOpen(r, 'dialog');
    a.resolve({ path: 'C:/Music/A.orbit', json: 'no es JSON' });
    await a.done;
    expect(r.projectFile.useProjectFile.getState().notice).toBeTruthy();
    const after = currentState(r);
    expect({ ...after, file: { ...after.file, notice: before.file.notice } }).toEqual(before);
  });
});

describe('BUG 021: guardar conserva la identidad y la foto del proyecto solicitado', () => {
  it.each([false, true])('saveAs=%s de A no adopta ruta/clean/aviso tras crear B', async (saveAs) => {
    const r = await rig({ deferSaves: true });
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/A.orbit' });
    const originalId = r.app.store.project.id;
    const originalJson = serializeProject(r.app.store.project);
    const saving = r.projectFile.saveProject(saveAs);
    r.projectFile.newProject();
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    const before = currentState(r);
    const versionsBefore = { ...r.versions.useVersions.getState() };
    r.saves[0]!.resolve('C:/Music/A.orbit');
    await saving;
    expect(currentState(r)).toEqual(before);
    expect(r.versions.useVersions.getState()).toEqual(versionsBefore);
    expect(r.versionWrites.every((v) => v.projectId === originalId && v.json === originalJson)).toBe(true);
  });

  it('abrir B antes de que termine Guardar A conserva la ruta de B y su dirty', async () => {
    const r = await rig({ deferSaves: true });
    const saving = r.projectFile.saveProject(true);
    const b = beginOpen(r, 'dialog');
    b.resolve(orbitDe(r, 'B'));
    await b.done;
    const before = currentState(r);
    r.saves[0]!.resolve('C:/Music/A.orbit');
    await saving;
    expect(currentState(r)).toEqual(before);
  });

  it('restaurar el mismo id invalida metadatos de un guardado anterior', async () => {
    const r = await rig({ deferSaves: true });
    const saving = r.projectFile.saveProject();
    r.app.store.replaceProject(r.app.store.project);
    const before = currentState(r);
    r.saves[0]!.resolve('C:/Music/A.orbit');
    await saving;
    expect(currentState(r)).toEqual(before);
  });

  it('la versión archivada contiene el mismo JSON enviado al archivo y editar durante el save sigue dirty', async () => {
    const r = await rig({ deferSaves: true });
    const originalJson = serializeProject(r.app.store.project);
    const originalId = r.app.store.project.id;
    const saving = r.projectFile.saveProject();
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    r.saves[0]!.resolve('C:/Music/A.orbit');
    await saving;
    expect(r.saves[0]!.json).toBe(originalJson);
    expect(r.versionWrites).toEqual([{ projectId: originalId, label: 'guardado', json: originalJson }]);
    expect(r.autosave.isDirty()).toBe(true);
  });

  it('dos guardados se escriben en orden y capturan la foto al solicitar, no al entrar a la cola', async () => {
    const r = await rig({ deferSaves: true });
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/old.orbit' });
    const firstJson = serializeProject(r.app.store.project);
    const first = r.projectFile.saveProject(true);
    r.app.store.dispatch({ type: 'setTempo', tempo: 155 });
    const secondJson = serializeProject(r.app.store.project);
    const second = r.projectFile.saveProject();
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    // Control negativo de la carrera: sin cola ya habría dos IPC en vuelo y
    // el primero podría escribir su foto vieja DESPUÉS de la foto del segundo.
    expect(r.saves).toHaveLength(1);
    r.saves[0]!.resolve('C:/Music/renamed.orbit');
    await first;
    const secondWrite = await r.waitForSave(1);
    expect(secondWrite.path).toBe('C:/Music/renamed.orbit');
    expect(secondWrite.json).toBe(secondJson);
    secondWrite.resolve('C:/Music/renamed.orbit');
    await second;
    expect(r.versionWrites.map((v) => v.json)).toEqual([firstJson, secondJson]);
    expect(r.autosave.isDirty()).toBe(true);
  });

  it.each(['cancelar', 'fallar'] as const)('SaveAs puede %s y la cola continúa usando la ruta anterior de su sesión', async (outcome) => {
    const r = await rig({ deferSaves: true });
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/old.orbit' });
    const first = r.projectFile.saveProject(true);
    const second = r.projectFile.saveProject();
    expect(r.saves).toHaveLength(1);
    if (outcome === 'cancelar') r.saves[0]!.resolve(null);
    else r.saves[0]!.reject(new Error('Disco lleno'));
    await first;
    const secondWrite = await r.waitForSave(1);
    expect(secondWrite.path).toBe('C:/Music/old.orbit');
    secondWrite.resolve('C:/Music/old.orbit');
    await second;
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/old.orbit');
    expect(r.autosave.isDirty()).toBe(false);
  });

  it('SaveAs A → nuevo B → Save B no hereda el destino A aunque esté en la cola', async () => {
    const r = await rig({ deferSaves: true });
    const a = r.projectFile.saveProject(true);
    r.projectFile.newProject();
    const b = r.projectFile.saveProject();
    expect(r.saves).toHaveLength(1);
    r.saves[0]!.resolve('C:/Music/A.orbit');
    await a;
    const secondWrite = await r.waitForSave(1);
    expect(secondWrite.path).toBeNull();
    secondWrite.resolve('C:/Music/B.orbit');
    await b;
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/B.orbit');
  });

  it('un fallo tardío de A no reemplaza el aviso ni el dirty de B', async () => {
    const r = await rig({ deferSaves: true });
    const saving = r.projectFile.saveProject();
    r.projectFile.newProject();
    const before = currentState(r);
    r.saves[0]!.reject(new Error('Fallo escribiendo A'));
    await saving;
    expect(currentState(r)).toEqual(before);
  });

  it('cancelar el guardado vigente no cambia ruta, limpio o versiones', async () => {
    const r = await rig({ deferSaves: true });
    r.projectFile.useProjectFile.setState({ path: 'C:/Music/old.orbit' });
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    const before = currentState(r);
    const saving = r.projectFile.saveProject(true);
    r.saves[0]!.resolve(null);
    await saving;
    expect(currentState(r)).toEqual(before);
    expect(r.versionWrites).toEqual([]);
  });

  it('dos Guardar como conservan su orden, y cancelar el segundo no revierte el primero', async () => {
    const r = await rig({ deferSaves: true });
    const first = r.projectFile.saveProject(true);
    r.app.store.dispatch({ type: 'setTempo', tempo: 177 });
    const second = r.projectFile.saveProject(true);
    r.saves[0]!.resolve('C:/Music/first.orbit');
    await first;
    const secondWrite = await r.waitForSave(1);
    expect(secondWrite.path).toBeNull();
    secondWrite.resolve(null);
    await second;
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/first.orbit');
    expect(r.autosave.isDirty()).toBe(true);
    expect(r.versionWrites).toHaveLength(1);
  });

  it('dos Guardar como exitosos dejan el destino elegido por el segundo', async () => {
    const r = await rig({ deferSaves: true });
    const first = r.projectFile.saveProject(true);
    const second = r.projectFile.saveProject(true);
    r.saves[0]!.resolve('C:/Music/first.orbit');
    await first;
    const secondWrite = await r.waitForSave(1);
    expect(secondWrite.path).toBeNull();
    secondWrite.resolve('C:/Music/second.orbit');
    await second;
    expect(r.projectFile.useProjectFile.getState().path).toBe('C:/Music/second.orbit');
    expect(r.autosave.isDirty()).toBe(false);
  });
});

describe('BUG 021: archivo histórico del snapshot sin publicar sobre otra sesión', () => {
  it.each(['éxito', 'error'] as const)('la versión que acaba con %s tras cambiar a B no toca su estado', async (outcome) => {
    const r = await rig();
    const gate = deferred<string>();
    r.versionsApi.save.mockImplementationOnce(() => gate.promise);
    const saving = r.versions.saveVersion('A');
    expect(r.versions.useVersions.getState().busy).toBe(true);
    r.projectFile.newProject();
    expect(r.versions.useVersions.getState().busy).toBe(false);
    r.versions.useVersions.setState({ busy: true, notice: 'Operación de B' });
    const before = { ...r.versions.useVersions.getState() };
    if (outcome === 'éxito') gate.resolve('a.orbit');
    else gate.reject(new Error('Fallo viejo de A'));
    expect(await saving).toBe(outcome === 'éxito');
    expect(r.versions.useVersions.getState()).toEqual(before);
    expect(r.versionsApi.list).not.toHaveBeenCalled();
  });

  it.each(['éxito', 'error'] as const)('el listener busy se desuscribe tras %s sin cambiar de proyecto', async (outcome) => {
    const r = await rig();
    const subscribe = r.app.store.subscribeBeforeReplace.bind(r.app.store);
    const unsubscribe = vi.fn();
    vi.spyOn(r.app.store, 'subscribeBeforeReplace').mockImplementation((listener) => {
      const off = subscribe(listener);
      return () => { unsubscribe(); off(); };
    });
    if (outcome === 'error') r.versionsApi.save.mockRejectedValueOnce(new Error('No cabe'));
    expect(await r.versions.saveVersion('Actual')).toBe(outcome === 'éxito');
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(r.versions.useVersions.getState().busy).toBe(false);
  });

  it('el finally de una versión anterior no apaga busy de la siguiente en la misma sesión', async () => {
    const r = await rig();
    const first = deferred<string>();
    const second = deferred<string>();
    r.versionsApi.save.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const a = r.versions.saveVersion('Primera');
    const b = r.versions.saveVersion('Segunda');
    first.resolve('first.orbit');
    await a;
    expect(r.versions.useVersions.getState()).toMatchObject({ busy: true, notice: null });
    second.resolve('second.orbit');
    await b;
    expect(r.versions.useVersions.getState()).toMatchObject({ busy: false, notice: 'Versión guardada: Segunda' });
  });

  it.each(['éxito', 'error'] as const)('el refresco que acaba con %s tras guardar A tampoco publica sobre B', async (outcome) => {
    const r = await rig();
    const started = deferred<void>();
    const list = deferred<{ file: string; at: number; bytes: number }[]>();
    r.versionsApi.list.mockImplementationOnce(() => { started.resolve(); return list.promise; });
    const saving = r.versions.saveVersion('A');
    await started.promise;
    r.projectFile.newProject();
    const bEntry = { file: '1700000000000-b.orbit', at: 1, bytes: 1, label: 'B' };
    r.versions.useVersions.setState({ entries: [bEntry], busy: true, notice: 'Lista de B' });
    const before = { ...r.versions.useVersions.getState() };
    if (outcome === 'éxito') list.resolve([{ file: '1700000000000-a.orbit', at: 1, bytes: 1 }]);
    else list.reject(new Error('No se puede listar A'));
    await saving;
    expect(r.versions.useVersions.getState()).toEqual(before);
  });

  it('refrescos simultáneos dejan la lista más reciente incluso en la misma epoch', async () => {
    const r = await rig();
    const first = deferred<{ file: string; at: number; bytes: number }[]>();
    const second = deferred<{ file: string; at: number; bytes: number }[]>();
    r.versionsApi.list.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const a = r.versions.refreshVersions();
    const b = r.versions.refreshVersions();
    second.resolve([{ file: '1700000000000-b.orbit', at: 2, bytes: 1 }]);
    await b;
    const before = { ...r.versions.useVersions.getState() };
    first.resolve([{ file: '1700000000000-a.orbit', at: 1, bytes: 1 }]);
    await a;
    expect(r.versions.useVersions.getState()).toEqual(before);
  });
});
