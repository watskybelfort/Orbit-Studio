/**
 * Carreras de lectura en el panel de versiones.
 *
 * `openVersionDiff` y `restoreVersion` leen el `.orbit` de la versión por IPC:
 * entre pedirlo y tenerlo pasa tiempo real, y el usuario puede pedir OTRA cosa
 * mientras. Sin token de petición, la respuesta lenta pisa el estado de la
 * nueva: abres la versión A, te arrepientes y abres la B, y cuando por fin
 * llega A el panel enseña el diff de A como si fuera lo que pediste.
 *
 * Cada respuesta comprueba su solicitud, selección y sesión antes de publicar.
 * Los avisos/busy tienen además un dueño común con guardado/restauración.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectLoadRequests } from '../src/state/project-load-request';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function rig({ deferBackups = false } = {}) {
  vi.resetModules();
  const pending = new Map<string, ReturnType<typeof deferred<string>>[]>();
  const backups: { projectId: string; json: string; label: string; gate: ReturnType<typeof deferred<string>> }[] = [];
  const backupWaiters = new Map<number, ReturnType<typeof deferred<(typeof backups)[number]>>>();
  const backupStarted = deferred<void>();
  const opens: ReturnType<typeof deferred<{ path: string; json: string } | null>>[] = [];
  const read = vi.fn(
    (_projectId: string, file: string) => {
      const gate = deferred<string>();
      const reads = pending.get(file) ?? [];
      reads.push(gate);
      pending.set(file, reads);
      return gate.promise;
    },
  );
  const open = () => {
    const gate = deferred<{ path: string; json: string } | null>();
    opens.push(gate);
    return gate.promise;
  };
  vi.stubGlobal('window', {
    confirm: () => true,
    orbit: {
      versions: {
        list: vi.fn(async () => []),
        save: vi.fn(async (projectId: string, label: string, json: string) => {
          const gate = deferred<string>();
          backups.push({ projectId, label, json, gate });
          backupWaiters.get(backups.length - 1)?.resolve(backups[backups.length - 1]!);
          backupStarted.resolve();
          return deferBackups ? gate.promise : 'version.orbit';
        }),
        read,
        remove: vi.fn(async () => undefined),
      },
      app: { setDirty: () => undefined },
      autosave: { clear: async () => undefined },
      project: { open, openRecent: open, recent: async () => [], save: async () => 'saved.orbit' },
      settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
    },
  });

  const core = await import('@orbit/core');
  const { store, engine } = await import('../src/state/app');
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);
  const mod = await import('../src/state/versions');
  const projectFile = await import('../src/state/project-file');
  const sounds = await import('../src/browser/sound-actions');
  const rehydrate = vi.spyOn(sounds, 'rehydrateSamples').mockResolvedValue([]);

  return {
    core,
    store,
    mod,
    read,
    backups,
    waitForBackup: (index: number) => {
      if (backups[index]) return Promise.resolve(backups[index]);
      const waiter = deferred<(typeof backups)[number]>();
      backupWaiters.set(index, waiter);
      return waiter.promise;
    },
    backupStarted: backupStarted.promise,
    opens,
    projectFile,
    rehydrate,
    resolveRead: (file: string, json: string, index = 0) => {
      const gate = pending.get(file)?.[index];
      if (!gate) throw new Error(`no hay lectura pendiente de ${file}`);
      gate.resolve(json);
    },
    rejectRead: (file: string, index = 0) => pending.get(file)![index]!.reject(new Error('No se puede leer')),
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

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

function stateOf(r: Rig) {
  return {
    project: r.core.serializeProject(r.store.project),
    epoch: r.store.historyEpoch,
    version: r.store.version,
    versions: { ...r.mod.useVersions.getState() },
    file: { ...r.projectFile.useProjectFile.getState() },
    audio: r.rehydrate.mock.calls.length,
  };
}

describe('BUG022: identidad y respaldo antes de restaurar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['nuevo', 'mismo-id', 'misma-referencia'] as const)('un reemplazo %s durante la lectura invalida la restauración', async (kind) => {
    const r = await rig();
    const restore = r.mod.restoreVersion('old.orbit');
    if (kind === 'nuevo') r.projectFile.newProject();
    else {
      const next = kind === 'misma-referencia' ? r.store.project : r.core.createEmptyProject('Otro estado');
      if (kind === 'mismo-id') next.id = r.store.project.id;
      r.store.replaceProject(next);
    }
    expect(r.mod.useVersions.getState().busy).toBe(false);
    const before = stateOf(r);
    r.resolveRead('old.orbit', r.core.serializeProject(r.core.createEmptyProject('Versión antigua')));
    await restore;
    expect(stateOf(r)).toEqual(before);
    expect(r.backups).toHaveLength(0);
  });

  it.each(['éxito', 'error'] as const)('un respaldo que acaba con %s tras cambiar de proyecto no restaura ni publica', async (outcome) => {
    const r = await rig({ deferBackups: true });
    const restore = r.mod.restoreVersion('old.orbit');
    r.resolveRead('old.orbit', r.core.serializeProject(r.core.createEmptyProject('Versión antigua')));
    await r.backupStarted;
    r.projectFile.newProject();
    r.mod.useVersions.setState({ notice: 'Operación de B', busy: true });
    const before = stateOf(r);
    if (outcome === 'éxito') r.backups[0]!.gate.resolve('backup.orbit');
    else r.backups[0]!.gate.reject(new Error('Respaldo de A falló'));
    await restore;
    expect(stateOf(r)).toEqual(before);
  });

  it('fallar al leer una restauración vieja no pisa el busy/aviso de la nueva', async () => {
    const r = await rig();
    const a = r.mod.restoreVersion('a.orbit');
    const b = r.mod.restoreVersion('b.orbit');
    const before = stateOf(r);
    r.rejectRead('a.orbit');
    await a;
    expect(stateOf(r)).toEqual(before);
    r.resolveRead('b.orbit', r.core.serializeProject(r.core.createEmptyProject('B')));
    await b;
    expect(r.store.project.meta.title).toBe('B');
  });

  it('un respaldo viejo no publica mientras otra restauración aún está leyendo', async () => {
    const r = await rig({ deferBackups: true });
    const a = r.mod.restoreVersion('a.orbit');
    r.resolveRead('a.orbit', r.core.serializeProject(r.core.createEmptyProject('A')));
    await r.backupStarted;
    const b = r.mod.restoreVersion('b.orbit');
    const before = stateOf(r);
    r.backups[0]!.gate.resolve('backup-a.orbit');
    await a;
    expect(stateOf(r)).toEqual(before);
    r.rejectRead('b.orbit');
    await b;
  });

  it('ediciones durante la lectura entran al respaldo; ediciones posteriores lo abortan sin perderse', async () => {
    const r = await rig({ deferBackups: true });
    const restore = r.mod.restoreVersion('old.orbit');
    r.store.dispatch({ type: 'setTempo', tempo: 155 });
    const backupJson = r.core.serializeProject(r.store.project);
    r.resolveRead('old.orbit', r.core.serializeProject(r.core.createEmptyProject('Antigua')));
    await r.backupStarted;
    expect(r.backups[0]!.json).toBe(backupJson);
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    const currentJson = r.core.serializeProject(r.store.project);
    const epoch = r.store.historyEpoch;
    r.backups[0]!.gate.resolve('backup.orbit');
    await restore;
    expect(r.core.serializeProject(r.store.project)).toBe(currentJson);
    expect(r.store.historyEpoch).toBe(epoch);
    expect(r.mod.useVersions.getState()).toMatchObject({ busy: false });
    expect(r.mod.useVersions.getState().notice).toContain('cambió');
    expect(r.rehydrate).not.toHaveBeenCalled();
  });

  it('si el respaldo falla se conserva todo el proyecto y se libera busy', async () => {
    const r = await rig({ deferBackups: true });
    const before = r.core.serializeProject(r.store.project);
    const restore = r.mod.restoreVersion('old.orbit');
    r.resolveRead('old.orbit', r.core.serializeProject(r.core.createEmptyProject('Antigua')));
    await r.backupStarted;
    r.backups[0]!.gate.reject(new Error('Sin espacio'));
    await restore;
    expect(r.core.serializeProject(r.store.project)).toBe(before);
    expect(r.mod.useVersions.getState()).toMatchObject({ busy: false, notice: 'No se restauró: no se pudo guardar el respaldo del estado actual' });
    expect(r.rehydrate).not.toHaveBeenCalled();
  });

  it.each(['dialog', 'recent'] as const)('Open %s más nuevo gana incluso si la restauración responde primero', async (kind) => {
    const r = await rig();
    const restore = r.mod.restoreVersion('a.orbit');
    const open = kind === 'dialog' ? r.projectFile.openProject() : r.projectFile.openRecentProject('B.orbit');
    expect(r.mod.useVersions.getState().busy).toBe(false);
    const before = stateOf(r);
    r.resolveRead('a.orbit', r.core.serializeProject(r.core.createEmptyProject('A')));
    await restore;
    expect(stateOf(r)).toEqual(before);
    r.opens[0]!.resolve({ path: 'B.orbit', json: r.core.serializeProject(r.core.createEmptyProject('B')) });
    await open;
    expect(r.store.project.meta.title).toBe('B');
  });

  it('Restore más nuevo gana aunque Open anterior responda primero', async () => {
    const r = await rig();
    const open = r.projectFile.openProject();
    const restore = r.mod.restoreVersion('b.orbit');
    const before = stateOf(r);
    r.opens[0]!.resolve({ path: 'A.orbit', json: r.core.serializeProject(r.core.createEmptyProject('A')) });
    await open;
    expect(stateOf(r)).toEqual(before);
    r.resolveRead('b.orbit', r.core.serializeProject(r.core.createEmptyProject('B')));
    await restore;
    expect(r.store.project.meta.title).toBe('B');
  });

  it('cancelar Open más nuevo no revive la restauración antigua', async () => {
    const r = await rig();
    const restore = r.mod.restoreVersion('a.orbit');
    const open = r.projectFile.openProject();
    r.opens[0]!.resolve(null);
    await open;
    const before = stateOf(r);
    r.resolveRead('a.orbit', r.core.serializeProject(r.core.createEmptyProject('A')));
    await restore;
    expect(stateOf(r)).toEqual(before);
    expect(r.backups).toHaveLength(0);
  });

  it('Open pedido durante el respaldo también toma prioridad sin esperar a reemplazar', async () => {
    const r = await rig({ deferBackups: true });
    const restore = r.mod.restoreVersion('a.orbit');
    r.resolveRead('a.orbit', r.core.serializeProject(r.core.createEmptyProject('A')));
    await r.backupStarted;
    const open = r.projectFile.openProject();
    expect(r.mod.useVersions.getState().busy).toBe(false);
    const before = stateOf(r);
    r.backups[0]!.gate.resolve('backup.orbit');
    await restore;
    expect(stateOf(r)).toEqual(before);
    r.opens[0]!.resolve({ path: 'B.orbit', json: r.core.serializeProject(r.core.createEmptyProject('B')) });
    await open;
    expect(r.store.project.meta.title).toBe('B');
  });

  it('rechazar confirmDiscard de Open no cancela una restauración vigente', async () => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 155 });
    const restore = r.mod.restoreVersion('a.orbit');
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await r.projectFile.openProject();
    expect(r.opens).toHaveLength(0);
    r.resolveRead('a.orbit', r.core.serializeProject(r.core.createEmptyProject('A')));
    await restore;
    expect(r.store.project.meta.title).toBe('A');
  });

  it.each(['éxito', 'lectura fallida', 'nuevo proyecto'] as const)('retira su listener una sola vez tras %s', async (outcome) => {
    const r = await rig();
    const subscribe = r.store.subscribeBeforeReplace.bind(r.store);
    const dispose = vi.fn();
    vi.spyOn(r.store, 'subscribeBeforeReplace').mockImplementation((listener) => {
      const off = subscribe(listener);
      return () => { dispose(); off(); };
    });
    const restore = r.mod.restoreVersion('a.orbit');
    if (outcome === 'nuevo proyecto') r.projectFile.newProject();
    if (outcome === 'lectura fallida') r.rejectRead('a.orbit');
    else r.resolveRead('a.orbit', r.core.serializeProject(r.core.createEmptyProject('A')));
    await restore;
    expect(dispose).toHaveBeenCalledOnce();
    expect(r.mod.useVersions.getState().busy).toBe(false);
    if (outcome === 'lectura fallida') expect(r.mod.useVersions.getState().notice).toBe('Esa versión no se puede leer');
  });
});

describe('árbitro puro de apertura/restauración', () => {
  it('distingue intento reciente de epoch y cede antes de que la siguiente publique estado', () => {
    const requests = createProjectLoadRequests();
    let currentDuringRelease = false;
    const first = requests.begin(7, () => { currentDuringRelease = first.isCurrent(7); });
    const second = requests.begin(7);
    expect(currentDuringRelease).toBe(true);
    expect(first.isCurrent(7)).toBe(false);
    expect(second.isCurrent(7)).toBe(true);
    expect(second.isCurrent(8)).toBe(false);
  });

  it('terminar una solicitud vieja no retira el callback de la que la reemplazó', () => {
    const requests = createProjectLoadRequests();
    const release = vi.fn();
    const first = requests.begin(1);
    const second = requests.begin(1, release);
    first.finish();
    requests.begin(1);
    expect(release).toHaveBeenCalledOnce();
    second.finish();
    requests.begin(1);
    expect(release).toHaveBeenCalledOnce();
  });

  it('finish retira la referencia al callback terminado', () => {
    const requests = createProjectLoadRequests();
    const release = vi.fn();
    requests.begin(1, release).finish();
    requests.begin(1);
    expect(release).not.toHaveBeenCalled();
  });
});

describe('BUG022: publicación compartida entre guardado y restauración', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['éxito', 'error'] as const)('un guardado manual que termina con %s no publica sobre una restauración más nueva', async (outcome) => {
    const r = await rig({ deferBackups: true });
    const save = r.mod.saveVersion('Manual A');
    const restore = r.mod.restoreVersion('b.orbit');
    const before = stateOf(r);
    if (outcome === 'éxito') r.backups[0]!.gate.resolve('a.orbit');
    else r.backups[0]!.gate.reject(new Error('Fallo viejo del guardado'));
    await save;
    expect(stateOf(r)).toEqual(before);
    r.rejectRead('b.orbit');
    await restore;
  });

  it.each(['éxito', 'error'] as const)('el refresco ya iniciado por un save que acaba con %s respeta la nueva restauración', async (outcome) => {
    const r = await rig();
    const list = deferred<{ file: string; at: number; bytes: number }[]>();
    const started = deferred<void>();
    vi.spyOn(window.orbit!.versions, 'list').mockImplementation(() => { started.resolve(); return list.promise; });
    const save = r.mod.saveVersion('Manual A');
    await started.promise;
    const restore = r.mod.restoreVersion('b.orbit');
    const before = stateOf(r);
    if (outcome === 'éxito') list.resolve([{ file: '1700000000000-a.orbit', at: 1, bytes: 1 }]);
    else list.reject(new Error('No se puede listar A'));
    await save;
    expect(stateOf(r)).toEqual(before);
    r.rejectRead('b.orbit');
    await restore;
  });

  it('un error tardío de Restore no apaga el guardado automático que inició Ctrl+S después', async () => {
    const r = await rig({ deferBackups: true });
    const restore = r.mod.restoreVersion('old.orbit');
    const snapshots = vi.spyOn(r.mod, 'saveVersionSnapshot');
    await r.projectFile.saveProject();
    const automaticSave = snapshots.mock.results[0]!.value;
    const before = stateOf(r);
    r.rejectRead('old.orbit');
    await restore;
    expect(stateOf(r)).toEqual(before);
    r.backups[0]!.gate.resolve('automatic.orbit');
    await automaticSave;
    expect(r.mod.useVersions.getState()).toMatchObject({ busy: false, notice: 'Versión guardada: guardado' });
  });

  it('transferir solo la UI al guardado automático NO cancela la restauración musical', async () => {
    const r = await rig({ deferBackups: true });
    const restore = r.mod.restoreVersion('old.orbit');
    const snapshots = vi.spyOn(r.mod, 'saveVersionSnapshot');
    await r.projectFile.saveProject();
    const automaticSave = snapshots.mock.results[0]!.value;
    r.resolveRead('old.orbit', r.core.serializeProject(r.core.createEmptyProject('Restaurado')));
    const backup = await r.waitForBackup(1);
    backup.gate.resolve('before-restore.orbit');
    await restore;
    expect(r.store.project.meta.title).toBe('Restaurado');
    expect(r.mod.useVersions.getState()).toMatchObject({ busy: false, notice: null });
    const before = stateOf(r);
    r.backups[0]!.gate.resolve('automatic.orbit');
    await automaticSave;
    expect(stateOf(r)).toEqual(before);
  });
});

function comparePair(r: Rig, from = 'a', to = 'b') {
  r.mod.useVersions.setState({
    entries: ['a', 'b', 'c'].map((file, at) => ({ file, at, bytes: 1, label: file })),
    compareFrom: from, compareTo: to,
  });
}

function versionJson(r: Rig, title: string, tempo = 100) {
  const project = r.core.createEmptyProject(title);
  project.tempo = tempo;
  return r.core.serializeProject(project);
}

describe('BUG023: las lecturas pertenecen al panel y selección que las pidió', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('A/B lento no pisa B/C ya mostrado', async () => {
    const r = await rig();
    comparePair(r);
    const old = r.mod.runCompare();
    r.mod.setComparePick('from', 'b');
    r.mod.setComparePick('to', 'c');
    const latest = r.mod.runCompare();
    r.resolveRead('b', versionJson(r, 'B'), 1);
    r.resolveRead('c', versionJson(r, 'C'));
    await latest;
    const before = stateOf(r);
    r.resolveRead('a', versionJson(r, 'A'));
    r.resolveRead('b', versionJson(r, 'B'));
    await old;
    expect(stateOf(r)).toEqual(before);
    expect(r.mod.useVersions.getState().compare).toMatchObject({ from: { key: 'b' }, to: { key: 'c' } });
  });

  it.each(['selección', 'intercambio', 'cierre'] as const)('%s sin recalcular invalida la comparación pendiente y libera busy', async (action) => {
    const r = await rig();
    comparePair(r);
    const reading = r.mod.runCompare();
    if (action === 'selección') r.mod.setComparePick('to', 'c');
    else if (action === 'intercambio') r.mod.swapCompare();
    else r.mod.closeCompare();
    expect(r.mod.useVersions.getState().busy).toBe(false);
    const before = stateOf(r);
    r.resolveRead('a', versionJson(r, 'A'));
    r.resolveRead('b', versionJson(r, 'B'));
    await reading;
    expect(stateOf(r)).toEqual(before);
  });

  it('volver a la misma selección no resucita la lectura cancelada', async () => {
    const r = await rig();
    comparePair(r);
    const reading = r.mod.runCompare();
    r.mod.setComparePick('to', 'c');
    r.mod.setComparePick('to', 'b');
    const before = stateOf(r);
    r.resolveRead('a', versionJson(r, 'A'));
    r.resolveRead('b', versionJson(r, 'B'));
    await reading;
    expect(stateOf(r)).toEqual(before);
  });

  it.each(['compare', 'diff'] as const)('cambiar de epoch con el mismo proyecto invalida %s', async (kind) => {
    const r = await rig();
    comparePair(r, 'a', '');
    const reading = kind === 'compare' ? r.mod.runCompare() : r.mod.openVersionDiff('a');
    r.store.replaceProject(r.store.project);
    expect(r.mod.useVersions.getState().busy).toBe(false);
    r.mod.useVersions.setState({ busy: true, notice: 'Operación de la nueva sesión' });
    const before = stateOf(r);
    r.resolveRead('a', versionJson(r, 'A'));
    await reading;
    expect(stateOf(r)).toEqual(before);
  });

  it('error/finally de A/B antiguo no toca B/C que aún está leyendo', async () => {
    const r = await rig();
    comparePair(r);
    const old = r.mod.runCompare();
    r.mod.setComparePick('from', 'b');
    r.mod.setComparePick('to', 'c');
    const latest = r.mod.runCompare();
    const before = stateOf(r);
    r.rejectRead('a');
    r.resolveRead('b', versionJson(r, 'B'));
    await old;
    expect(stateOf(r)).toEqual(before);
    r.resolveRead('b', versionJson(r, 'B'), 1);
    r.resolveRead('c', versionJson(r, 'C'));
    await latest;
  });

  it.each(['compare', 'diff'] as const)('%s usa la foto Current tomada al pedir la lectura', async (kind) => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 140 });
    comparePair(r, 'a', '');
    const reading = kind === 'compare' ? r.mod.runCompare() : r.mod.openVersionDiff('a');
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    r.resolveRead('a', versionJson(r, 'A', 100));
    await reading;
    const state = r.mod.useVersions.getState();
    expect(kind === 'compare' ? state.compare?.diff.tempo : state.diff?.tempo).toEqual([100, 140]);
    expect(r.store.project.tempo).toBe(177);
  });

  it('cerrar el diff A mientras B lee impide que B aparezca después', async () => {
    const r = await rig();
    const first = r.mod.openVersionDiff('a');
    r.resolveRead('a', versionJson(r, 'A'));
    await first;
    const second = r.mod.openVersionDiff('b');
    await r.mod.openVersionDiff('a');
    const before = stateOf(r);
    r.resolveRead('b', versionJson(r, 'B'));
    await second;
    expect(stateOf(r)).toEqual(before);
    expect(r.mod.useVersions.getState().openFile).toBeNull();
  });

  it('pulsar otra vez el diff pendiente cierra sin iniciar otra lectura', async () => {
    const r = await rig();
    const first = r.mod.openVersionDiff('a');
    const close = r.mod.openVersionDiff('a');
    expect(r.read).toHaveBeenCalledTimes(1);
    await close;
    const before = stateOf(r);
    r.rejectRead('a');
    await first;
    expect(stateOf(r)).toEqual(before);
  });

  it.each(['compare', 'diff'] as const)('un save manual anterior no publica busy/notice sobre %s', async (kind) => {
    const r = await rig({ deferBackups: true });
    const save = r.mod.saveVersion('Manual');
    comparePair(r, 'a', '');
    const reading = kind === 'compare' ? r.mod.runCompare() : r.mod.openVersionDiff('a');
    const before = stateOf(r);
    r.backups[0]!.gate.resolve('manual.orbit');
    await save;
    expect(stateOf(r)).toEqual(before);
    r.resolveRead('a', versionJson(r, 'A'));
    await reading;
  });

  it.each(['compare', 'diff'] as const)('%s terminado no apaga un save más nuevo', async (kind) => {
    const r = await rig({ deferBackups: true });
    comparePair(r, 'a', '');
    const reading = kind === 'compare' ? r.mod.runCompare() : r.mod.openVersionDiff('a');
    const save = r.mod.saveVersion('Manual');
    r.resolveRead('a', versionJson(r, 'A'));
    await reading;
    expect(r.mod.useVersions.getState()).toMatchObject({ busy: true, notice: null });
    r.backups[0]!.gate.resolve('manual.orbit');
    await save;
    expect(r.mod.useVersions.getState()).toMatchObject({ busy: false, notice: 'Versión guardada: Manual' });
  });

  it('un lector más nuevo toma UI sin cancelar la restauración musical', async () => {
    const r = await rig({ deferBackups: true });
    const restore = r.mod.restoreVersion('restored');
    comparePair(r, 'a', '');
    const compare = r.mod.runCompare();
    r.resolveRead('restored', versionJson(r, 'Restaurado'));
    const backup = await r.waitForBackup(0);
    backup.gate.resolve('backup.orbit');
    await restore;
    expect(r.store.project.meta.title).toBe('Restaurado');
    const before = stateOf(r);
    r.resolveRead('a', versionJson(r, 'A'));
    await compare;
    expect(stateOf(r)).toEqual(before);
  });

  it('un refresco no restablece una selección válida mientras compare está pendiente', async () => {
    const r = await rig();
    comparePair(r, 'a', 'b');
    const reading = r.mod.runCompare();
    vi.spyOn(window.orbit!.versions, 'list').mockResolvedValue([
      { file: 'a', at: 1, bytes: 1 }, { file: 'b', at: 2, bytes: 1 }, { file: 'c', at: 3, bytes: 1 },
    ]);
    await r.mod.refreshVersions();
    expect(r.mod.useVersions.getState()).toMatchObject({ compareFrom: 'a', compareTo: 'b' });
    r.resolveRead('a', versionJson(r, 'A'));
    r.resolveRead('b', versionJson(r, 'B'));
    await reading;
    expect(r.mod.useVersions.getState().compare).toMatchObject({ from: { key: 'a' }, to: { key: 'b' } });
  });

  it('intercambiar un resultado visible lo retira y recalcula con la dirección inversa', async () => {
    const r = await rig();
    comparePair(r);
    const initial = r.mod.runCompare();
    r.resolveRead('a', versionJson(r, 'A', 100));
    r.resolveRead('b', versionJson(r, 'B', 150));
    await initial;
    expect(r.mod.useVersions.getState().compare?.diff.tempo).toEqual([100, 150]);
    const completed = deferred<void>();
    const off = r.mod.useVersions.subscribe((state) => { if (state.compare && !state.busy) completed.resolve(); });
    r.mod.swapCompare();
    expect(r.mod.useVersions.getState()).toMatchObject({ compareFrom: 'b', compareTo: 'a', compare: null, busy: true });
    r.resolveRead('a', versionJson(r, 'A', 100), 1);
    r.resolveRead('b', versionJson(r, 'B', 150), 1);
    await completed.promise;
    off();
    expect(r.mod.useVersions.getState().compare).toMatchObject({
      from: { key: 'b' }, to: { key: 'a' }, direction: 'backward', diff: { tempo: [150, 100] },
    });
  });

  it('el error de un diff anterior no borra el estado de un diff nuevo pendiente', async () => {
    const r = await rig();
    const old = r.mod.openVersionDiff('a');
    const latest = r.mod.openVersionDiff('b');
    const before = stateOf(r);
    r.rejectRead('a');
    await old;
    expect(stateOf(r)).toEqual(before);
    r.resolveRead('b', versionJson(r, 'B'));
    await latest;
    expect(r.mod.useVersions.getState()).toMatchObject({ openFile: 'b', busy: false, notice: null });
  });

  it.each(['compare', 'diff'] as const)('el error/finally de %s no apaga ni avisa sobre una restauración nueva', async (kind) => {
    const r = await rig();
    comparePair(r, 'a', '');
    const reading = kind === 'compare' ? r.mod.runCompare() : r.mod.openVersionDiff('a');
    const restore = r.mod.restoreVersion('restored');
    const before = stateOf(r);
    r.rejectRead('a');
    await reading;
    expect(stateOf(r)).toEqual(before);
    r.resolveRead('restored', versionJson(r, 'Restaurado'));
    await restore;
    expect(r.store.project.meta.title).toBe('Restaurado');
  });

  it.each(['compare', 'diff'] as const)('%s retira sus suscripciones en éxito, error, cierre y reemplazo', async (kind) => {
    const r = await rig();
    const subscribe = r.store.subscribeBeforeReplace.bind(r.store);
    const disposers: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(r.store, 'subscribeBeforeReplace').mockImplementation((listener) => {
      const off = vi.fn(subscribe(listener));
      disposers.push(off);
      return off;
    });
    for (const outcome of ['success', 'error', 'close', 'replace'] as const) {
      comparePair(r, outcome, '');
      r.mod.useVersions.setState({ entries: [{ file: outcome, at: 1, bytes: 1, label: outcome }] });
      const reading = kind === 'compare' ? r.mod.runCompare() : r.mod.openVersionDiff(outcome);
      if (outcome === 'close') {
        if (kind === 'compare') r.mod.closeCompare();
        else await r.mod.openVersionDiff(outcome);
      } else if (outcome === 'replace') r.store.replaceProject(r.store.project);
      if (outcome === 'error') r.rejectRead(outcome);
      else r.resolveRead(outcome, versionJson(r, outcome));
      await reading;
      expect(disposers.at(-1)).toHaveBeenCalledOnce();
      expect(r.mod.useVersions.getState().busy).toBe(false);
    }
    expect(disposers).toHaveLength(4);
    r.store.replaceProject(r.store.project);
    for (const off of disposers) expect(off).toHaveBeenCalledOnce();
  });

  it('podar una versión elegida cancela su lectura y libera busy', async () => {
    const r = await rig();
    comparePair(r);
    const reading = r.mod.runCompare();
    vi.spyOn(window.orbit!.versions, 'list').mockResolvedValue([{ file: 'c', at: 3, bytes: 1 }]);
    await r.mod.refreshVersions();
    expect(r.mod.useVersions.getState()).toMatchObject({ compareFrom: 'c', compareTo: '', compare: null, busy: false });
    const before = stateOf(r);
    r.resolveRead('a', versionJson(r, 'A'));
    r.resolveRead('b', versionJson(r, 'B'));
    await reading;
    expect(stateOf(r)).toEqual(before);
  });
});
