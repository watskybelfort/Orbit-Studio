import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function rig(stage: 'hash' | 'save' | 'load' = 'save') {
  vi.resetModules();
  vi.useFakeTimers();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const counts = new Map<string, number>();
  const wait = async (at: string) => {
    counts.set(at, (counts.get(at) ?? 0) + 1);
    if (stage === at && counts.get(at) === 1) { entered.resolve(); await gate.promise; }
  };
  const files: string[] = [];
  const save = vi.fn(async (name: string) => {
    await wait('save');
    const file = `actual-${name}`;
    files.push(file);
    return file;
  });
  vi.stubGlobal('window', { orbit: {
    recording: { save }, settings: { get: async () => ({}), set: async () => ({}) },
  } });
  vi.stubGlobal('navigator', {});
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const gc = await import('../src/state/sample-gc');
  const bounce = await import('../src/state/bounce');
  const sounds = await import('../src/browser/sound-actions');
  vi.spyOn(sounds, 'sha1Hex').mockImplementation(async () => { await wait('hash'); return 'content-hash'; });
  const loaded = (app.engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
  const upload = vi.spyOn(app.engine, 'loadSample').mockImplementation(async (id) => {
    loaded.add(id);
    await wait('load');
    return { duration: 0.02 };
  });
  const edits = await import('../src/editors/audio/audio-edit-actions');
  app.store.replaceProject(core.createEmptyProject('A'));
  const sample = { id: 'source', name: 'Voz', path: 'recording:voice.wav', hash: 'source-hash', duration: 0.02 };
  app.store.dispatch({ type: 'registerSample', sample });
  app.store.dispatch({ type: 'addClips', clips: [{
    id: 'clip', kind: 'audio', playlistTrackId: Object.keys(app.store.project.playlistTracks)[0]!,
    start: 0, length: 4, muted: false, sampleId: sample.id,
  }] });
  const channels = { left: new Float32Array(960).fill(0.2), right: new Float32Array(960).fill(0.3), rate: 48_000, duration: 0.02 };
  const busy = vi.fn();
  const applied = vi.fn();
  const actions = edits.createAudioEditActions(busy);
  const request = (kind = 'Normalizar') => ({
    clip: app.store.project.clips.clip!, sample: app.store.project.samples.source!, channels,
    fileKind: kind, sampleName: `Voz · ${kind}`, label: `${kind} "Voz"`,
    process: () => channels, onApplied: applied,
  });
  return { core, ...app, gc, bounce, edits, gate, entered: entered.promise, save, files, loaded, upload, busy, applied, actions, request };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const snapshot = (r: Rig) => ({ json: r.core.serializeProject(r.store.project), version: r.store.version, history: [...r.store.history] });

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG031: edición destructiva y afinación guardan solo en su sesión', () => {
  for (const kind of ['Normalizar', 'Afinado']) {
    for (const stage of ['hash', 'save', 'load'] as const) {
      it.each(['nuevo', 'mismo id'] as const)(`${kind}: ${stage} no toca reemplazo %s`, async (replacement) => {
        const r = await rig(stage);
        const pending = r.actions.run(r.request(kind));
        await r.entered;
        r.store.replaceProject(replacement === 'nuevo' ? r.core.createEmptyProject('B') : r.store.project);
        const before = snapshot(r);
        r.gate.resolve();
        await pending;
        expect(snapshot(r)).toEqual(before);
        expect(r.applied).not.toHaveBeenCalled();
        expect(r.gc.pinnedSamples()).toEqual([]);
        expect(r.gc.recordingLedgerEntries()).toEqual([]);
        expect(r.loaded.size).toBe(0);
        if (stage === 'hash') expect(r.save).not.toHaveBeenCalled();
        else {
          expect(r.files).toHaveLength(1);
          expect(r.edits.useAudioEditStore.getState().recoveryNotice).toContain(r.files[0]);
        }
      });
    }
  }

  it('el bloqueo es síncrono y no necesita esperar al siguiente render de React', async () => {
    const r = await rig('hash');
    const first = r.actions.run(r.request());
    await r.actions.run(r.request('Afinado'));
    expect(r.busy.mock.calls).toEqual([[true]]);
    r.gate.resolve();
    await first;
    expect(r.save).toHaveBeenCalledOnce();
    expect(r.busy.mock.calls).toEqual([[true], [false]]);
  });

  it.each(['clip', 'close'] as const)('el cambio de UI %s cancela sin esperar al cleanup de React', async (change) => {
    const r = await rig('hash');
    const ui = await import('../src/state/ui');
    ui.useUiStore.setState({ audioClipId: 'clip' });
    ui.useUiStore.getState().openWindow('audioEditor');
    const pending = r.actions.run(r.request());
    await r.entered;
    if (change === 'clip') ui.useUiStore.setState({ audioClipId: 'otro' });
    else ui.useUiStore.getState().closeWindow('audioEditor');
    expect(r.busy).toHaveBeenLastCalledWith(false);
    const before = snapshot(r);
    r.gate.resolve();
    await pending;
    expect(snapshot(r)).toEqual(before);
    expect(r.save).not.toHaveBeenCalled();
  });

  it.each(['hash', 'save', 'load'] as const)('cerrar/cambiar clip durante %s permite nueva edición sin que A limpie su busy', async (stage) => {
    const r = await rig(stage);
    const first = r.actions.run(r.request());
    await r.entered;
    r.actions.cancel();
    const load = deferred<void>();
    const secondEntered = deferred<void>();
    let secondId = '';
    r.upload.mockImplementationOnce(async (id) => {
      secondId = id; r.loaded.add(id); secondEntered.resolve(); await load.promise;
      return { duration: 0.02 };
    });
    const second = r.actions.run(r.request('Afinado'));
    await secondEntered.promise;
    const before = snapshot(r);
    const calls = [...r.busy.mock.calls];
    r.gate.resolve();
    await first;
    expect(snapshot(r)).toEqual(before);
    expect(r.busy.mock.calls).toEqual(calls);
    expect(r.gc.pinnedSamples()).toEqual([secondId]);
    expect(r.loaded.has(secondId)).toBe(true);
    load.resolve();
    await second;
    expect(r.store.project.clips.clip!.sampleId).toBe(secondId);
    expect(r.applied).toHaveBeenCalledOnce();
  });

  it.each(['save', 'load'] as const)('fallo tardío de %s no pisa aviso/callbacks de B ni inventa recuperación', async (stage) => {
    const r = await rig(stage);
    const pending = r.actions.run(r.request('Afinado'));
    await r.entered;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    r.bounce.notifyBanner('Aviso B');
    const before = snapshot(r);
    const busy = [...r.busy.mock.calls];
    r.gate.reject(new Error('Operación A falló'));
    await pending;
    expect(snapshot(r)).toEqual(before);
    expect(r.busy.mock.calls).toEqual(busy);
    expect(r.applied).not.toHaveBeenCalled();
    expect(r.bounce.useBounceStore.getState().notice).toBe('Aviso B');
    const recovery = r.edits.useAudioEditStore.getState().recoveryNotice;
    if (stage === 'save') expect(recovery).toBeNull();
    else { expect(recovery).toContain(r.files[0]); expect(recovery).toContain('Operación A falló'); }
  });

  it.each(['hash', 'load'] as const)('editar el clip durante %s conserva los cambios y no aplica la versión vieja', async (stage) => {
    const r = await rig(stage);
    const pending = r.actions.run(r.request());
    await r.entered;
    r.store.dispatch({ type: 'patchClips', patches: [{ id: 'clip', audioOffset: 0.001 }] });
    const before = snapshot(r);
    r.gate.resolve();
    await pending;
    expect(snapshot(r)).toEqual(before);
    if (stage === 'hash') expect(r.save).not.toHaveBeenCalled();
    expect(r.bounce.useBounceStore.getState().notice).toMatch(/proyecto cambió/);
  });

  it.each(['Normalizar', 'Afinado'])('%s mantiene su pin, batch y undo y registra el archivo al aplicar', async (kind) => {
    const r = await rig('load');
    const before = r.core.serializeProject(r.store.project);
    const pending = r.actions.run(r.request(kind));
    await r.entered;
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
    expect(r.gc.pinnedSamples()).toHaveLength(1);
    r.gc.collectWorkletSamples(r.engine, r.store.project);
    r.gate.resolve();
    await pending;
    const id = r.store.project.clips.clip!.sampleId!;
    expect(id).not.toBe('source');
    expect(r.loaded.has(id)).toBe(true);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.gc.recordingLedgerEntries()[0]!.file).toBe(r.files[0]);
    expect(r.applied).toHaveBeenCalledOnce();
    r.store.undo();
    expect(r.core.serializeProject(r.store.project)).toBe(before);
  });

  it.each(['success', 'error', 'cancel', 'replace'] as const)('libera listener tras %s', async (outcome) => {
    const r = await rig();
    const real = r.store.subscribeBeforeReplace.bind(r.store);
    const disposed = vi.fn();
    vi.spyOn(r.store, 'subscribeBeforeReplace').mockImplementation((fn) => {
      const off = real(fn); return () => { disposed(); off(); };
    });
    const pending = r.actions.run(r.request());
    await r.entered;
    if (outcome === 'cancel') r.actions.cancel();
    if (outcome === 'replace') r.store.replaceProject(r.core.createEmptyProject('B'));
    if (outcome === 'error') r.gate.reject(new Error('Sin espacio')); else r.gate.resolve();
    await pending;
    expect(disposed).toHaveBeenCalledOnce();
    r.store.replaceProject(r.core.createEmptyProject('C'));
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('reconocer recuperación no modifica proyecto ni borra otro aviso', async () => {
    const r = await rig();
    const pending = r.actions.run(r.request());
    await r.entered;
    r.actions.cancel(); r.gate.resolve(); await pending;
    r.bounce.notifyBanner('Aviso independiente');
    const before = snapshot(r);
    r.edits.dismissAudioEditRecovery();
    expect(snapshot(r)).toEqual(before);
    expect(r.edits.useAudioEditStore.getState().recoveryNotice).toBeNull();
    expect(r.bounce.useBounceStore.getState().notice).toBe('Aviso independiente');
  });

  it('los dos botones y el ciclo de vida usan la transacción probada', () => {
    const source = readFileSync(new URL('../src/editors/audio/AudioEditor.tsx', import.meta.url), 'utf8');
    const op = source.slice(source.indexOf('const runOp'), source.indexOf('/** Busca los golpes'));
    const tune = source.slice(source.indexOf('const runTune'), source.indexOf('const listen'));
    for (const body of [op, tune]) {
      expect(body).toContain('await editActions.run(');
      expect(body).toContain('loadedSample !== sample');
    }
    expect(op).toContain('process: () => applyOp(op, channels)');
    expect(tune).toContain('return correctPitch(');
    expect(source).toContain('useEffect(() => () => editActions.cancel(), [editActions, audioClipId, sample])');
    expect(source).not.toContain('engine.loadSample(');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('useAudioEditStore((s) => s.recoveryNotice)');
    expect(app).toContain('onClick={dismissAudioEditRecovery}');
  });
});
