import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function rig(stage: 'hash' | 'save' | 'load' = 'save') {
  vi.resetModules();
  const hash = deferred<string>();
  const save = deferred<string>();
  const load = deferred<{ duration: number }>();
  const entered = deferred<void>();
  const saved = vi.fn((_name: string, _data: Uint8Array) => {
    if (stage === 'save') { entered.resolve(); return save.promise; }
    return Promise.resolve('take.wav');
  });
  const discard = vi.fn(async () => []);
  vi.stubGlobal('window', {
    orbit: {
      recording: { save: saved, discard },
      settings: { get: async () => ({}), set: async () => ({}) },
    },
  });
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const sounds = await import('../src/browser/sound-actions');
  const gc = await import('../src/state/sample-gc');
  const ui = await import('../src/state/ui');
  ui.useUiStore.setState({ playing: true });
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const rate = vi.spyOn(app.engine, 'sampleRate', 'get').mockReturnValue(48_000);
  const beat = vi.spyOn(app, 'currentBeat').mockReturnValue(4);
  const tap = vi.spyOn(app.engine, 'setTrackCapture').mockImplementation(() => undefined);
  const upload = vi.spyOn(app.engine, 'loadSample').mockImplementation(async () => {
    if (stage === 'load') { entered.resolve(); return load.promise; }
    return { duration: 0.2 };
  });
  vi.spyOn(sounds, 'sha1Hex').mockImplementation(async () => {
    if (stage === 'hash') { entered.resolve(); return hash.promise; }
    return 'content-hash';
  });
  const capture = await import('../src/state/track-capture');
  app.store.replaceProject(core.createEmptyProject('Capture A'));
  return {
    core, ...app, capture, gc, saved, discard, tap, upload, rate, beat,
    entered: entered.promise, hash, save, load,
    release: () => {
      if (stage === 'hash') hash.resolve('content-hash');
      else if (stage === 'save') save.resolve('take.wav');
      else load.resolve({ duration: 0.2 });
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function start(r: Rig, track = 1) {
  await r.capture.toggleTrackCapture(track);
  r.capture.pushCaptureChunk(new Float32Array(9_600).fill(0.2), new Float32Array(9_600).fill(0.2));
}

function projectState(r: Rig) {
  return { json: r.core.serializeProject(r.store.project), version: r.store.version, history: [...r.store.history] };
}

function waitForRecovery(r: Rig) {
  const ready = deferred<void>();
  const off = r.capture.useTrackCapture.subscribe((state) => {
    if (state.recoveryNotice) { off(); ready.resolve(); }
  });
  return ready.promise;
}

describe('BUG031: una captura solo se inserta en su sesión de origen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  for (const stage of ['hash', 'save', 'load'] as const) {
    it.each(['otro proyecto', 'mismo id'] as const)(`${stage} pendiente y %s: conserva WAV sin tocar proyecto, historial o ledger nuevos`, async (replacement) => {
      const r = await rig(stage);
      await start(r);
      const stopping = r.capture.stopTrackCapture();
      await r.entered;
      r.store.replaceProject(replacement === 'mismo id' ? r.store.project : r.core.createEmptyProject('B'));
      const before = projectState(r);
      r.release();
      await stopping;
      expect(projectState(r)).toEqual(before);
      expect(r.saved).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(r.saved.mock.calls[0]![1].subarray(0, 4))).toBe('RIFF');
      expect(r.upload).toHaveBeenCalledTimes(stage === 'load' ? 1 : 0);
      expect(r.gc.recordingLedgerEntries()).toEqual([]);
      expect(r.gc.pinnedSamples()).toEqual([]);
      expect(r.discard.mock.calls.flat()).toEqual([]);
      expect(r.capture.useTrackCapture.getState().recoveryNotice).toMatch(/Capture A.*take\.wav/);
    });
  }

  it('reemplazar durante captura activa la finaliza con A y deja de aceptar audio de B', async () => {
    const r = await rig();
    await start(r);
    const recovered = waitForRecovery(r);
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.capture.useTrackCapture.getState().trackIndex).toBeNull();
    expect(r.tap).toHaveBeenLastCalledWith(1, false);
    const before = projectState(r);
    r.capture.pushCaptureChunk(new Float32Array(9_600), new Float32Array(9_600));
    await r.entered;
    r.release();
    await recovered;
    expect(projectState(r)).toEqual(before);
    // WAV de 24 bits estéreo: solo los 9600 frames capturados en A.
    expect(r.saved.mock.calls[0]![1].byteLength).toBe(44 + 9_600 * 6);
  });

  it('una toma nueva no cambia beat/rate ni recibe el error final de la anterior', async () => {
    const r = await rig();
    await start(r);
    const stopping = r.capture.stopTrackCapture();
    await r.entered;
    r.beat.mockReturnValue(32);
    r.rate.mockReturnValue(96_000);
    await r.capture.toggleTrackCapture(2);
    r.capture.useTrackCapture.setState({ error: 'Aviso de la toma nueva' });
    r.release();
    await stopping;
    const clip = Object.values(r.store.project.clips).find((item) => item.kind === 'audio')!;
    expect(clip.start).toBe(4);
    expect(r.store.project.samples[clip.sampleId!]!.duration).toBe(0.2);
    expect(r.capture.useTrackCapture.getState()).toMatchObject({ trackIndex: 2, error: 'Aviso de la toma nueva' });
    await r.capture.stopTrackCapture();
  });

  it('el fallo tardío de A no pisa la UI de una captura nueva', async () => {
    const r = await rig();
    await start(r);
    const stopping = r.capture.stopTrackCapture();
    await r.entered;
    await r.capture.toggleTrackCapture(2);
    r.capture.useTrackCapture.setState({ error: 'Aviso vigente' });
    r.save.reject(new Error('Fallo anterior'));
    await stopping;
    expect(r.capture.useTrackCapture.getState()).toMatchObject({ trackIndex: 2, error: 'Aviso vigente' });
    await r.capture.stopTrackCapture();
  });

  it.each([false, true])('save de A rechazado tras abrir B avisa sin afirmar recuperación (capturando B: %s)', async (capturingB) => {
    const r = await rig();
    await start(r);
    const stopping = r.capture.stopTrackCapture();
    await r.entered;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    if (capturingB) await r.capture.toggleTrackCapture(2);
    r.capture.useTrackCapture.setState({ error: 'Aviso de B' });
    const before = projectState(r);
    const captureBefore = r.capture.useTrackCapture.getState();
    r.save.reject(new Error('disco lleno'));
    await stopping;
    expect(projectState(r)).toEqual(before);
    expect(r.capture.useTrackCapture.getState()).toMatchObject({
      trackIndex: captureBefore.trackIndex, seconds: captureBefore.seconds, error: 'Aviso de B',
    });
    const notice = r.capture.useTrackCapture.getState().recoveryNotice;
    expect(notice).toMatch(/No se pudo guardar.*Capture A.*disco lleno/);
    expect(notice).toMatch(/No se confirmó ningún WAV recuperable/);
    expect(notice).not.toMatch(/se conservó|recordings|arrastrar/);
    expect(r.upload).not.toHaveBeenCalled();
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
    if (capturingB) await r.capture.stopTrackCapture();
  });

  it('un inicio pendiente en engine.init no comienza captura en otro proyecto', async () => {
    const r = await rig();
    const init = deferred<void>();
    vi.mocked(r.engine.init).mockReturnValueOnce(init.promise);
    const starting = r.capture.toggleTrackCapture(1);
    r.store.replaceProject(r.core.createEmptyProject('B'));
    init.resolve();
    await starting;
    expect(r.capture.useTrackCapture.getState().trackIndex).toBeNull();
    expect(r.tap).not.toHaveBeenCalled();
  });

  it('el arreglo de origen debe seguir vivo al insertar', async () => {
    const r = await rig('load');
    await start(r);
    const origin = r.store.project.activeArrangementId;
    const stopping = r.capture.stopTrackCapture();
    await r.entered;
    r.store.dispatch({ type: 'addArrangement', arrangement: { id: 'other', name: 'Otro' } });
    r.store.dispatch({ type: 'removeArrangement', arrangementId: origin });
    const before = projectState(r);
    r.release();
    await stopping;
    expect(projectState(r)).toEqual(before);
    expect(r.capture.useTrackCapture.getState().recoveryNotice).toMatch(/take\.wav/);
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
  });

  it('la captura normal conserva inserción atómica, undo y sujeción', async () => {
    const r = await rig('load');
    await start(r);
    const stopping = r.capture.stopTrackCapture();
    await r.entered;
    expect(r.gc.pinnedSamples()).toHaveLength(1);
    r.release();
    await stopping;
    const clips = Object.values(r.store.project.clips);
    expect(clips).toHaveLength(1);
    expect(r.store.project.playlistTracks[clips[0]!.playlistTrackId]).toBeDefined();
    expect(r.gc.recordingLedgerEntries()).toHaveLength(1);
    expect(r.gc.pinnedSamples()).toEqual([]);
    r.store.undo();
    expect(Object.values(r.store.project.clips)).toHaveLength(0);
    expect(Object.values(r.store.project.samples)).toHaveLength(0);
  });

  it('solo arranca la última intención si dos inicializaciones resuelven al revés', async () => {
    const r = await rig();
    const firstInit = deferred<void>();
    const secondInit = deferred<void>();
    vi.mocked(r.engine.init).mockReturnValueOnce(firstInit.promise).mockReturnValueOnce(secondInit.promise);
    const first = r.capture.toggleTrackCapture(1);
    const second = r.capture.toggleTrackCapture(2);
    secondInit.resolve();
    await second;
    firstInit.resolve();
    await first;
    expect(r.capture.useTrackCapture.getState().trackIndex).toBe(2);
    expect(r.tap).toHaveBeenCalledOnce();
    expect(r.tap).toHaveBeenCalledWith(2, true);
    await r.capture.stopTrackCapture();
  });

  it('retira la suscripción al separar la toma; una respuesta vieja no retira la nueva', async () => {
    const r = await rig();
    const subscribe = r.store.subscribeBeforeReplace.bind(r.store);
    const disposers: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(r.store, 'subscribeBeforeReplace').mockImplementation((listener) => {
      const off = vi.fn(subscribe(listener));
      disposers.push(off);
      return off;
    });
    await start(r);
    const stopping = r.capture.stopTrackCapture();
    expect(disposers[0]).toHaveBeenCalledOnce();
    await r.entered;
    await r.capture.toggleTrackCapture(2);
    r.release();
    await stopping;
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).not.toHaveBeenCalled();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(disposers[1]).toHaveBeenCalledOnce();
    expect(r.capture.useTrackCapture.getState().trackIndex).toBeNull();
  });

  it('si decode falla, el WAV ya guardado queda recuperable fuera del ledger', async () => {
    const r = await rig('load');
    await start(r);
    const stopping = r.capture.stopTrackCapture();
    await r.entered;
    const before = projectState(r);
    r.load.reject(new Error('decode falló'));
    await stopping;
    expect(projectState(r)).toEqual(before);
    expect(r.capture.useTrackCapture.getState()).toMatchObject({ error: 'decode falló' });
    expect(r.capture.useTrackCapture.getState().recoveryNotice).toMatch(/Capture A.*take\.wav/);
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('el aviso es consultable fuera del mixer y reconocerlo no cambia el proyecto', async () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/useTrackCapture\(\(s\) => s\.recoveryNotice\)/);
    expect(source).toContain('{fileNotice ?? captureRecovery ?? recorderRecovery ?? bounceRecovery}');
    expect(source).toContain('onClick={dismissCaptureRecovery}');
    expect(source).toContain('aria-label="Cerrar aviso de captura"');
    const r = await rig();
    r.capture.useTrackCapture.setState({ recoveryNotice: 'Conservada' });
    const before = projectState(r);
    r.capture.dismissCaptureRecovery();
    expect(r.capture.useTrackCapture.getState().recoveryNotice).toBeNull();
    expect(projectState(r)).toEqual(before);
  });
});
