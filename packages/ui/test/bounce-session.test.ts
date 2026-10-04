import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Stage = 'paint' | 'samples' | 'render' | 'hash' | 'save' | 'load';
const stages: Stage[] = ['paint', 'samples', 'render', 'hash', 'save', 'load'];

async function rig(stage: Stage = 'render') {
  vi.resetModules();
  vi.useFakeTimers();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const counts = new Map<Stage, number>();
  const wait = async (at: Stage) => {
    counts.set(at, (counts.get(at) ?? 0) + 1);
    if (stage === at && counts.get(at) === 1) { entered.resolve(); await gate.promise; }
  };
  const savedFiles: string[] = [];
  const save = vi.fn(async (name: string) => {
    await wait('save');
    const actual = `real-${name}`;
    savedFiles.push(actual);
    return actual;
  });
  vi.stubGlobal('window', { orbit: {
    recording: { save },
    settings: { get: async () => ({}), set: async () => ({}) },
  } });
  vi.stubGlobal('navigator', {});
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const gc = await import('../src/state/sample-gc');
  const paint = await import('../src/state/next-paint');
  vi.spyOn(paint, 'nextPaint').mockImplementation(() => wait('paint'));
  const inputs = await import('../src/export/render-inputs');
  const samples = vi.spyOn(inputs, 'collectSamples').mockImplementation(async () => {
    await wait('samples');
    return { samples: new Map(), missing: [] };
  });
  const worker = await import('../src/export/render-in-worker');
  vi.spyOn(worker, 'canUseRenderWorker').mockReturnValue(true);
  const audio = { left: new Float32Array(960).fill(0.2), right: new Float32Array(960).fill(0.3), sampleRate: 48_000 };
  const render = vi.spyOn(worker, 'renderProjectInWorker').mockImplementation(async () => { await wait('render'); return audio; });
  const sounds = await import('../src/browser/sound-actions');
  const hash = vi.spyOn(sounds, 'sha1Hex').mockImplementation(async () => { await wait('hash'); return 'content-hash'; });
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const loaded = (app.engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
  const upload = vi.spyOn(app.engine, 'loadSample').mockImplementation(async (id) => {
    loaded.add(id);
    await wait('load');
    return { duration: 0.02 };
  });
  const bounce = await import('../src/state/bounce');
  app.store.replaceProject(core.createEmptyProject('Origen A'));
  const addClip = () => {
    const trackId = Object.keys(app.store.project.playlistTracks)[0]!;
    const clipId = core.newId();
    app.store.dispatch({ type: 'addClips', clips: [{
      id: clipId, kind: 'pattern', playlistTrackId: trackId, start: 4, length: 4,
      muted: false, patternId: app.store.project.patternOrder[0]!,
    }] });
    return { trackId, clipId };
  };
  return { core, ...app, gc, bounce, gate, entered: entered.promise, savedFiles, save, samples, render, hash, upload, loaded, audio, addClip, ...addClip() };
}

type Rig = Awaited<ReturnType<typeof rig>>;
const snapshot = (r: Rig) => ({ json: r.core.serializeProject(r.store.project), version: r.store.version, history: [...r.store.history] });

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('BUG031: consolidar y congelar pertenecen a la sesión y revisión originales', () => {
  for (const stage of stages) {
    it.each(['nuevo', 'mismo id'] as const)(`${stage} pendiente no publica en proyecto %s`, async (replacement) => {
      const r = await rig(stage);
      const pending = r.bounce.bounceClip(r.clipId);
      await r.entered;
      r.store.replaceProject(replacement === 'nuevo' ? r.core.createEmptyProject('B') : r.store.project);
      const before = snapshot(r);
      r.gate.resolve();
      await pending;
      expect(snapshot(r)).toEqual(before);
      expect(r.gc.pinnedSamples()).toEqual([]);
      expect(r.gc.recordingLedgerEntries()).toEqual([]);
      expect(r.bounce.useBounceStore.getState().busy).toBeNull();
      expect(r.loaded.size).toBe(0);
      if (stage === 'save' || stage === 'load') {
        expect(r.savedFiles).toHaveLength(1);
        const recovery = r.bounce.useBounceStore.getState().recoveryNotice;
        expect(recovery).toContain(r.savedFiles[0]);
        expect(recovery).toContain('Origen A');
        expect(recovery).toContain('recordings');
      } else {
        expect(r.save).not.toHaveBeenCalled();
        expect(r.upload).not.toHaveBeenCalled();
        expect(r.bounce.useBounceStore.getState().recoveryNotice).toBeNull();
      }
    });
  }

  it.each(['bounceClip', 'bounceTrack', 'freezeTrack'] as const)('%s aborta por edición durante render sin crear archivos ni perder cambios', async (entry) => {
    const r = await rig();
    const pending = r.bounce[entry](entry === 'bounceClip' ? r.clipId : r.trackId);
    await r.entered;
    r.store.dispatch({ type: 'setTempo', tempo: 171 });
    const before = snapshot(r);
    r.gate.resolve();
    await pending;
    expect(snapshot(r)).toEqual(before);
    expect(r.save).not.toHaveBeenCalled();
    expect(r.bounce.useBounceStore.getState().notice).toMatch(/no se consolidó.*cambi/i);
  });

  it('cambiar el arreglo activo durante load conserva WAV y clips originales', async () => {
    const r = await rig('load');
    const pending = r.bounce.freezeTrack(r.trackId);
    await r.entered;
    r.store.dispatch({ type: 'addArrangement', arrangement: { id: 'other', name: 'Otro' } });
    r.store.dispatch({ type: 'setActiveArrangement', arrangementId: 'other' });
    const before = snapshot(r);
    r.gate.resolve();
    await pending;
    expect(snapshot(r)).toEqual(before);
    expect(r.store.project.clips[r.clipId]!.muted).toBe(false);
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
    expect(r.bounce.useBounceStore.getState().recoveryNotice).toContain(r.savedFiles[0]);
  });

  it.each(['render', 'save', 'load'] as const)('error tardío de %s A no borra busy/aviso B y permite terminar B', async (stage) => {
    const r = await rig(stage);
    const first = r.bounce.bounceClip(r.clipId);
    await r.entered;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.bounce.useBounceStore.getState().busy).toBeNull();
    const ids = r.addClip();
    const secondGate = deferred<void>();
    const secondEntered = deferred<void>();
    r.render.mockImplementationOnce(async () => { secondEntered.resolve(); await secondGate.promise; return r.audio; });
    const second = r.bounce.bounceClip(ids.clipId);
    await secondEntered.promise;
    r.bounce.notifyBanner('Aviso de B');
    const before = snapshot(r);
    const busy = r.bounce.useBounceStore.getState().busy;
    r.gate.reject(new Error('Falló operación A'));
    await first;
    expect(snapshot(r)).toEqual(before);
    expect(r.bounce.useBounceStore.getState()).toMatchObject({ busy, notice: 'Aviso de B' });
    if (stage === 'load') expect(r.bounce.useBounceStore.getState().recoveryNotice).toContain(r.savedFiles[0]);
    else expect(r.bounce.useBounceStore.getState().recoveryNotice).toBeNull();
    secondGate.resolve();
    await second;
    expect(Object.values(r.store.project.clips).filter((clip) => clip.kind === 'audio')).toHaveLength(1);
    expect(r.bounce.useBounceStore.getState()).toMatchObject({ busy: null, notice: 'Aviso de B' });
  });

  it.each(['bounceTrack', 'freezeTrack'] as const)('%s conserva un batch/undo y registra el archivo tras insertar', async (entry) => {
    const r = await rig('load');
    const original = r.core.serializeProject(r.store.project);
    const pending = r.bounce[entry](r.trackId);
    await r.entered;
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
    expect(r.gc.pinnedSamples()).toHaveLength(1);
    r.gate.resolve();
    await pending;
    const audio = Object.values(r.store.project.clips).find((clip) => clip.kind === 'audio')!;
    expect(r.store.project.playlistTracks[audio.playlistTrackId]!.arrangementId).toBe(r.store.project.activeArrangementId);
    if (entry === 'freezeTrack') {
      expect(audio.frozenFrom).toEqual([r.clipId]);
      expect(r.store.project.clips[r.clipId]!.muted).toBe(true);
    } else expect(r.store.project.clips[r.clipId]).toBeUndefined();
    expect(r.gc.recordingLedgerEntries()).toHaveLength(1);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.loaded.has(audio.sampleId!)).toBe(true);
    r.store.undo();
    expect(r.core.serializeProject(r.store.project)).toBe(original);
  });

  it.each(['save', 'load'] as const)('%s A termina mientras load B está sujeto: conserva B y avisa el WAV de A', async (stage) => {
    const r = await rig(stage);
    const first = r.bounce.freezeTrack(r.trackId);
    await r.entered;
    r.store.replaceProject(r.store.project); // mismos IDs, distinta sesión
    const secondGate = deferred<void>();
    const secondEntered = deferred<void>();
    let secondId = '';
    r.upload.mockImplementationOnce(async (id) => {
      secondId = id;
      r.loaded.add(id);
      secondEntered.resolve();
      await secondGate.promise;
      return { duration: 0.02 };
    });
    const second = r.bounce.freezeTrack(r.trackId);
    await secondEntered.promise;
    r.bounce.notifyBanner('Otro aviso vigente');
    const before = snapshot(r);
    const busy = r.bounce.useBounceStore.getState().busy;
    r.gate.resolve();
    await first;
    expect(snapshot(r)).toEqual(before);
    expect(r.bounce.useBounceStore.getState()).toMatchObject({ busy, notice: 'Otro aviso vigente' });
    expect(r.bounce.useBounceStore.getState().recoveryNotice).toContain(r.savedFiles[0]);
    expect(r.gc.pinnedSamples()).toEqual([secondId]);
    expect(r.loaded.has(secondId)).toBe(true);
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
    secondGate.resolve();
    await second;
    expect(r.bounce.frozenClipOfTrack(r.trackId)?.sampleId).toBe(secondId);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it.each(['success', 'error', 'replace'] as const)('libera el listener una sola vez tras %s', async (outcome) => {
    const r = await rig();
    const subscribe = r.store.subscribeBeforeReplace.bind(r.store);
    const disposed = vi.fn();
    vi.spyOn(r.store, 'subscribeBeforeReplace').mockImplementation((listener) => {
      const off = subscribe(listener);
      return () => { disposed(); off(); };
    });
    const pending = r.bounce.bounceClip(r.clipId);
    await r.entered;
    if (outcome === 'replace') r.store.replaceProject(r.core.createEmptyProject('B'));
    if (outcome === 'error') r.gate.reject(new Error('Render rechazado'));
    else r.gate.resolve();
    await pending;
    expect(disposed).toHaveBeenCalledOnce();
    if (outcome === 'error') {
      expect(r.bounce.useBounceStore.getState()).toMatchObject({ busy: null, notice: 'Render rechazado', recoveryNotice: null });
    }
    r.store.replaceProject(r.core.createEmptyProject('C'));
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('el aviso de WAV conservado se cierra sin borrar avisos de otra operación', async () => {
    const r = await rig('save');
    const pending = r.bounce.bounceClip(r.clipId);
    await r.entered;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    r.bounce.notifyBanner('Aviso de B');
    r.gate.resolve();
    await pending;
    await vi.advanceTimersByTimeAsync(6000);
    expect(r.bounce.useBounceStore.getState().recoveryNotice).toContain(r.savedFiles[0]);
    r.bounce.notifyBanner('Otro aviso de B');
    r.bounce.dismissBounceRecovery();
    expect(r.bounce.useBounceStore.getState()).toMatchObject({ recoveryNotice: null, notice: 'Otro aviso de B' });
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('useBounceStore((s) => s.recoveryNotice)');
    expect(source).toContain('onClick={dismissBounceRecovery}');
  });
});
