import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeStream(name: string) {
  const track = { stop: vi.fn(), onended: null, getSettings: () => ({ deviceId: name, channelCount: 8 }) };
  return { track, stream: { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream };
}

async function rig(stage: 'hash' | 'save' | 'load' = 'save', gateAt = 1) {
  vi.resetModules();
  vi.useFakeTimers();
  const hash = deferred<string>();
  const save = deferred<string>();
  const load = deferred<{ duration: number }>();
  const entered = deferred<void>();
  const savedFiles: string[] = [];
  let saves = 0;
  const saved = vi.fn(async (name: string, _wav: Uint8Array) => {
    const n = ++saves;
    if (stage === 'save' && n === gateAt) { entered.resolve(); await save.promise; }
    savedFiles.push(name);
    return name;
  });
  vi.stubGlobal('window', { orbit: {
    recording: { save: saved },
    settings: { get: async () => ({}), set: async () => ({}) },
  } });
  vi.stubGlobal('navigator', {});
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  vi.spyOn(app.engine, 'sampleRate', 'get').mockReturnValue(48_000);
  vi.spyOn(app.engine, 'connectInput').mockReturnValue({ disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode);
  vi.spyOn(app, 'currentBeat').mockReturnValue(4);
  const setCapture = vi.spyOn(app.engine, 'setInputCapture');
  let uploads = 0;
  const upload = vi.spyOn(app.engine, 'loadSample').mockImplementation(async () => {
    if (stage === 'load' && ++uploads === gateAt) { entered.resolve(); return load.promise; }
    return { duration: 0.2 };
  });
  const sounds = await import('../src/browser/sound-actions');
  let hashes = 0;
  vi.spyOn(sounds, 'sha1Hex').mockImplementation(async () => {
    const n = ++hashes;
    if (stage === 'hash' && n === gateAt) { entered.resolve(); return hash.promise; }
    return `hash-${n}`;
  });
  const gc = await import('../src/state/sample-gc');
  const ui = await import('../src/state/ui');
  ui.useUiStore.setState({ playing: true, positionBeats: 4 });
  const monitor = await import('../src/state/input-monitor');
  const media = [fakeStream('A'), fakeStream('B')];
  let opened = 0;
  monitor.setInputStreamFactory(async () => media[Math.min(opened++, 1)]!.stream);
  const recorder = await import('../src/state/recorder');
  recorder.useRecorderStore.setState({ countInBars: 0 });
  app.store.replaceProject(core.createEmptyProject('Session A'));
  return {
    core, ...app, recorder, monitor, ui, gc, media, saved, savedFiles, upload, setCapture,
    hash, save, load, entered: entered.promise,
    release: () => { hash.resolve('hash-gated'); save.resolve('saved.wav'); load.resolve({ duration: 0.2 }); },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function start(r: Rig, channels = [0, 4]) {
  for (const channel of channels) r.store.dispatch({ type: 'addInputRoute', route: r.core.createInputRoute(channel) });
  await r.recorder.toggleRecording();
  expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
  r.recorder.pushInputChunk(new Float32Array(9600).fill(0.2), new Float32Array(9600).fill(0.2));
  r.engine.onInputCaptures?.([{ routeIndex: 1, left: new Float32Array(9600).fill(0.3), right: new Float32Array(9600).fill(0.3) }]);
}

function snapshot(r: Rig) {
  return { json: r.core.serializeProject(r.store.project), version: r.store.version, history: [...r.store.history] };
}

describe('BUG031: las tomas del grabador conservan su sesión de origen', () => {
  afterEach(() => {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it.each([[6, 8, 1.5], [6, 4, 3], [3, 8, 0.75]])('BUG047: una cuenta de %i/%i inicia la captura a los %fs', async (num, den, seconds) => {
    const r = await rig();
    r.store.dispatch({ type: 'setTempo', tempo: 120 });
    r.store.dispatch({ type: 'setTimeSig', timeSig: { num, den } });
    let audioTime = 0;
    vi.spyOn(r.engine, 'audioContext', 'get').mockReturnValue({ get currentTime() { return audioTime; } } as AudioContext);
    const count = vi.spyOn(r.engine, 'countIn');
    r.ui.useUiStore.setState({ playing: false, positionBeats: 0 });
    r.recorder.useRecorderStore.setState({ countInBars: 1 });
    const starting = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(count).toHaveBeenCalledWith(num * 4 / den, num * 4 / den, 0, 4 / den);
    expect(r.recorder.useRecorderStore.getState().phase).toBe('countin');
    audioTime = seconds - 0.01;
    await vi.advanceTimersByTimeAsync(25);
    expect(r.recorder.useRecorderStore.getState().phase).toBe('countin');
    audioTime = seconds;
    await vi.advanceTimersByTimeAsync(25);
    await starting;
    expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
  });

  it.each([[6, 8, 5], [6, 4, 2], [3, 8, 6.5]])('BUG047: preroll %i/%i comienza en beat %f para llegar a 8', async (num, den, from) => {
    const r = await rig();
    r.store.dispatch({ type: 'setTimeSig', timeSig: { num, den } });
    r.ui.useUiStore.setState({ playing: false, positionBeats: 8 });
    r.recorder.useRecorderStore.setState({ countInBars: 1 });
    const seek = vi.spyOn(r.engine, 'seek');
    // Esta prueba mide el denominador; simula el primer frame del transporte.
    vi.spyOn(r.engine, 'play').mockImplementation(() => { r.ui.useUiStore.setState({ playing: true }); });
    const starting = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(0);
    expect(seek).toHaveBeenCalledWith(from);
    const app = await import('../src/state/app');
    vi.mocked(app.currentBeat).mockReturnValue(8);
    await vi.advanceTimersByTimeAsync(25);
    await starting;
    expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
  });

  for (const stage of ['hash', 'save', 'load'] as const) {
    it.each(['otro', 'mismo id'] as const)(`${stage} pendiente y reemplazo %s: guarda ambas tomas sin insertar en B`, async (replacement) => {
      const r = await rig(stage);
      await start(r);
      const stopping = r.recorder.toggleRecording();
      await vi.advanceTimersByTimeAsync(120);
      await r.entered;
      r.store.replaceProject(replacement === 'otro' ? r.core.createEmptyProject('B') : r.store.project);
      const before = snapshot(r);
      r.release();
      await stopping;
      expect(snapshot(r)).toEqual(before);
      expect(r.savedFiles).toHaveLength(2);
      expect(r.gc.recordingLedgerEntries()).toEqual([]);
      expect(r.gc.pinnedSamples()).toEqual([]);
      expect(r.recorder.useRecorderStore.getState().phase).toBe('idle');
      const notice = r.recorder.useRecorderStore.getState().recoveryNotice;
      expect(notice).toContain('Session A');
      for (const file of r.savedFiles) expect(notice).toContain(file);
    });
  }

  it('reemplazar durante los120ms separa el audio inmediatamente y deja grabar a B', async () => {
    const r = await rig();
    await start(r);
    const stopping = r.recorder.toggleRecording();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.recorder.useRecorderStore.getState().phase).toBe('idle');
    expect(r.setCapture).toHaveBeenLastCalledWith(false);
    await r.recorder.toggleRecording();
    expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
    r.recorder.useRecorderStore.setState({ error: 'Aviso B' });
    r.recorder.pushInputChunk(new Float32Array(100), new Float32Array(100));
    const before = snapshot(r);
    r.release();
    await stopping;
    expect(snapshot(r)).toEqual(before);
    expect(r.saved.mock.calls[0]![1].byteLength).toBe(44 + 9600 * 6);
    expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'recording', error: 'Aviso B' });
    expect(r.monitor.currentInputStream()).toBe(r.media[1]!.stream);
    expect(r.media[1]!.track.stop).not.toHaveBeenCalled();
  });

  it('reemplazar durante grabación activa guarda lo capturado sin tomar el audio siguiente', async () => {
    const r = await rig();
    await start(r);
    const done = deferred<void>();
    const off = r.recorder.useRecorderStore.subscribe((state) => { if (state.recoveryNotice) done.resolve(); });
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.recorder.useRecorderStore.getState().phase).toBe('idle');
    r.recorder.pushInputChunk(new Float32Array(9600), new Float32Array(9600));
    const before = snapshot(r);
    r.release();
    await done.promise;
    off();
    expect(snapshot(r)).toEqual(before);
    expect(r.savedFiles).toHaveLength(2);
    for (const call of r.saved.mock.calls) expect(call[1].byteLength).toBe(44 + 9600 * 6);
  });

  it.each([1, 2])('fallo de toma%s conserva la otra sin pisar la captura de B', async (gateAt) => {
    const r = await rig('save', gateAt);
    await start(r);
    const stopping = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(120);
    await r.entered;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    await r.recorder.toggleRecording();
    r.recorder.useRecorderStore.setState({ error: 'Aviso B' });
    const before = snapshot(r);
    r.save.reject(new Error('sin espacio'));
    await stopping;
    expect(snapshot(r)).toEqual(before);
    expect(r.saved).toHaveBeenCalledTimes(2);
    expect(r.savedFiles).toHaveLength(1);
    expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'recording', error: 'Aviso B' });
    const notice = r.recorder.useRecorderStore.getState().recoveryNotice;
    expect(notice).toContain('sin espacio');
    expect(notice).toContain(r.savedFiles[0]);
    expect(notice).toContain('No se confirmó');
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
  });

  it('un permiso A tardío no conecta ni cierra el stream B', async () => {
    const r = await rig();
    const permission = deferred<MediaStream>();
    const permissionStarted = deferred<void>();
    let openings = 0;
    r.monitor.setInputStreamFactory(() => {
      if (++openings === 1) { permissionStarted.resolve(); return permission.promise; }
      return Promise.resolve(r.media[1]!.stream);
    });
    const first = r.recorder.toggleRecording();
    await permissionStarted.promise;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    await r.recorder.toggleRecording();
    expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
    permission.resolve(r.media[0]!.stream);
    await first;
    expect(r.monitor.currentInputStream()).toBe(r.media[1]!.stream);
    expect(r.media[0]!.track.stop).toHaveBeenCalledOnce();
    expect(r.media[1]!.track.stop).not.toHaveBeenCalled();
    expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
  });

  it('la respuesta anterior de init no inicia captura ni cambia el estado de B', async () => {
    const r = await rig();
    const init = deferred<void>();
    vi.mocked(r.engine.init).mockReturnValue(init.promise);
    const first = r.recorder.toggleRecording();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    r.recorder.useRecorderStore.setState({ error: 'Aviso B' });
    init.resolve();
    await first;
    expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'idle', error: 'Aviso B' });
    expect(r.setCapture.mock.calls.some(([on]) => on === true)).toBe(false);
  });

  it('el arreglo origen borrado conserva ambas tomas y evita clips huérfanos', async () => {
    const r = await rig('load');
    await start(r);
    const origin = r.store.project.activeArrangementId;
    const stopping = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(120);
    await r.entered;
    r.store.dispatch({ type: 'addArrangement', arrangement: { id: 'other', name: 'Otro' } });
    r.store.dispatch({ type: 'removeArrangement', arrangementId: origin });
    const before = snapshot(r);
    r.release();
    await stopping;
    expect(snapshot(r)).toEqual(before);
    expect(r.savedFiles).toHaveLength(2);
    expect(r.recorder.useRecorderStore.getState().recoveryNotice).toContain('arreglo');
  });

  it.each(['hash', 'save', 'load'] as const)('cambiar durante %s de la segunda toma no registra la primera en B', async (stage) => {
    const r = await rig(stage, 2);
    await start(r);
    const stopping = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(120);
    await r.entered;
    expect(r.gc.pinnedSamples()).toHaveLength(2);
    r.store.replaceProject(r.core.createEmptyProject('B'));
    const before = snapshot(r);
    r.release();
    await stopping;
    expect(snapshot(r)).toEqual(before);
    expect(r.savedFiles).toHaveLength(2);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.gc.recordingLedgerEntries()).toEqual([]);
  });

  it.each([0, 8])('cuenta atrás desde beat%s no inicia ni detiene B tras reemplazo', async (target) => {
    const r = await rig();
    r.ui.useUiStore.setState({ playing: false, positionBeats: target, metronome: false });
    r.recorder.useRecorderStore.setState({ countInBars: 1 });
    const inCount = deferred<void>();
    const off = r.recorder.useRecorderStore.subscribe((state) => { if (state.phase === 'countin') inCount.resolve(); });
    const first = r.recorder.toggleRecording();
    await inCount.promise;
    off();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'idle', countdown: 0 });
    expect(r.ui.useUiStore.getState().metronome).toBe(false);
    r.ui.useUiStore.setState({ playing: true });
    r.recorder.useRecorderStore.setState({ countInBars: 0 });
    await r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
    expect(r.monitor.currentInputStream()).toBe(r.media[1]!.stream);
    expect(r.media[1]!.track.stop).not.toHaveBeenCalled();
  });

  it('play del preroll pendiente respeta la sesión después de engine.init', async () => {
    const r = await rig();
    r.ui.useUiStore.setState({ playing: false, positionBeats: 8 });
    r.recorder.useRecorderStore.setState({ countInBars: 1 });
    const init = deferred<void>();
    const inCount = deferred<void>();
    const off = r.recorder.useRecorderStore.subscribe((state) => {
      if (state.phase === 'countin') {
        vi.mocked(r.engine.init).mockReturnValueOnce(init.promise);
        inCount.resolve();
      }
    });
    const enginePlay = vi.spyOn(r.engine, 'play');
    const starting = r.recorder.toggleRecording();
    await inCount.promise;
    off();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    const before = snapshot(r);
    init.resolve();
    await starting;
    expect(enginePlay).not.toHaveBeenCalled();
    expect(snapshot(r)).toEqual(before);
    expect(r.recorder.useRecorderStore.getState().phase).toBe('idle');
  });

  it('error/finally de permiso A no borra la apertura B pendiente compartida', async () => {
    const r = await rig();
    const permits = [deferred<MediaStream>(), deferred<MediaStream>()];
    const started = [deferred<void>(), deferred<void>()];
    let openings = 0;
    r.monitor.setInputStreamFactory(() => {
      const n = openings++;
      if (n > 1) throw new Error('Se abrió un tercer micrófono');
      started[n]!.resolve();
      return permits[n]!.promise;
    });
    const first = r.recorder.toggleRecording();
    await started[0]!.promise;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    const second = r.recorder.toggleRecording();
    await started[1]!.promise;
    permits[0]!.reject(new Error('Permiso antiguo denegado'));
    await first;
    const shared = r.monitor.startInputMonitor();
    expect(openings).toBe(2);
    permits[1]!.resolve(r.media[1]!.stream);
    await second;
    expect(await shared).toBe(true);
    expect(r.monitor.currentInputStream()).toBe(r.media[1]!.stream);
    expect(r.monitor.useInputMonitorStore.getState().error).toBeNull();
    expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'recording', error: null });
  });

  it('el micrófono que ya escuchaba antes de grabar sigue abierto al cambiar de proyecto', async () => {
    const r = await rig();
    await r.monitor.startInputMonitor();
    await start(r, [0]);
    r.store.replaceProject(r.core.createEmptyProject('B'));
    expect(r.monitor.currentInputStream()).toBe(r.media[0]!.stream);
    expect(r.media[0]!.track.stop).not.toHaveBeenCalled();
    r.release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('una apertura que inició el monitor no se cancela con la grabación que la tomó prestada', async () => {
    const r = await rig();
    const permission = deferred<MediaStream>();
    const started = deferred<void>();
    r.monitor.setInputStreamFactory(() => { started.resolve(); return permission.promise; });
    const monitor = r.monitor.startInputMonitor();
    await started.promise;
    const recording = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(0);
    r.store.replaceProject(r.core.createEmptyProject('B'));
    permission.resolve(r.media[0]!.stream);
    expect(await monitor).toBe(true);
    await recording;
    expect(r.monitor.currentInputStream()).toBe(r.media[0]!.stream);
    expect(r.media[0]!.track.stop).not.toHaveBeenCalled();
    expect(r.recorder.useRecorderStore.getState().phase).toBe('idle');
  });

  it('el aviso del grabador puede cerrarse sin borrar el aviso independiente de captura', async () => {
    const r = await rig();
    const capture = await import('../src/state/track-capture');
    capture.useTrackCapture.setState({ recoveryNotice: 'Toma de pista' });
    r.recorder.useRecorderStore.setState({ recoveryNotice: 'Toma de micro' });
    r.recorder.dismissRecorderRecovery();
    expect(r.recorder.useRecorderStore.getState().recoveryNotice).toBeNull();
    expect(capture.useTrackCapture.getState().recoveryNotice).toBe('Toma de pista');
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('onClick={dismissRecorderRecovery}');
    expect(source).toContain('!fileNotice && !captureRecovery && recorderRecovery');
  });

  it.each(['success', 'failure', 'replace'] as const)('libera su listener una sola vez al terminar por %s', async (outcome) => {
    const r = await rig();
    const subscribe = r.store.subscribeBeforeReplace.bind(r.store);
    const disposed = vi.fn();
    vi.spyOn(r.store, 'subscribeBeforeReplace').mockImplementation((listener) => {
      const off = subscribe(listener);
      return () => { disposed(); off(); };
    });
    await start(r, [0]);
    const stopping = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(120);
    await r.entered;
    if (outcome === 'replace') r.store.replaceProject(r.core.createEmptyProject('B'));
    if (outcome === 'failure') r.save.reject(new Error('falló guardar'));
    else r.release();
    await stopping;
    expect(disposed).toHaveBeenCalledOnce();
    r.store.replaceProject(r.core.createEmptyProject('C'));
    expect(disposed).toHaveBeenCalledOnce();
  });

  it('editar durante save conserva las dos tomas en el contexto original sin perder la edición', async () => {
    const r = await rig();
    await start(r);
    const tempo = r.store.project.tempo;
    const origin = r.store.project.activeArrangementId;
    const stopping = r.recorder.toggleRecording();
    await vi.advanceTimersByTimeAsync(120);
    await r.entered;
    r.store.dispatch({ type: 'setTempo', tempo: 177 });
    r.store.dispatch({ type: 'addArrangement', arrangement: { id: 'other', name: 'Otro' } });
    r.store.dispatch({ type: 'setActiveArrangement', arrangementId: 'other' });
    r.release();
    await stopping;
    expect(r.store.project.tempo).toBe(177);
    const clips = Object.values(r.store.project.clips);
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(r.store.project.playlistTracks[clip.playlistTrackId]!.arrangementId).toBe(origin);
      expect(clip.length).toBeCloseTo(0.2 * tempo / 60);
    }
    r.store.undo();
    expect(Object.values(r.store.project.clips)).toHaveLength(0);
    expect(r.store.project.tempo).toBe(177);
  });

  for (const preroll of [false, true]) {
    it.each([false, true])(`fallo del init de play tras permiso (preroll=${preroll}, cambia proyecto=%s) respeta captura y metrónomo`, async (replace) => {
      const r = await rig();
      r.ui.useUiStore.setState({ playing: false, positionBeats: 8, metronome: false });
      r.recorder.useRecorderStore.setState({ countInBars: preroll ? 1 : 0 });
      const init = deferred<void>();
      const entered = deferred<void>();
      const off = r.recorder.useRecorderStore.subscribe((state) => {
        if (state.phase === (preroll ? 'countin' : 'recording')) {
          vi.mocked(r.engine.init).mockImplementationOnce(() => { entered.resolve(); return init.promise; });
        }
      });
      const first = r.recorder.toggleRecording();
      await entered.promise;
      off();
      // Ya terminaron ensureAudioReady del grabador, el del monitor y el permiso.
      // Lo que falla es el tercer init, dentro de play.
      expect(r.engine.init).toHaveBeenCalledTimes(3);
      expect(r.monitor.currentInputStream()).toBe(r.media[0]!.stream);
      expect(r.ui.useUiStore.getState().metronome).toBe(preroll);
      if (replace) {
        r.store.replaceProject(r.core.createEmptyProject('B'));
        r.ui.useUiStore.setState({ playing: true, metronome: true });
        r.recorder.useRecorderStore.setState({ countInBars: 0 });
        await r.recorder.toggleRecording();
        r.recorder.useRecorderStore.setState({ error: 'Aviso B' });
      }
      const before = snapshot(r);
      init.reject(new Error('No arrancó el transporte A'));
      await first;
      expect(snapshot(r)).toEqual(before);
      if (replace) {
        expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'recording', error: 'Aviso B' });
        expect(r.monitor.currentInputStream()).toBe(r.media[1]!.stream);
        expect(r.media[1]!.track.stop).not.toHaveBeenCalled();
        expect(r.setCapture).toHaveBeenLastCalledWith(true, [0]);
        expect(r.ui.useUiStore.getState().metronome).toBe(true);
      } else {
        expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'idle', error: 'No arrancó el transporte A' });
        expect(r.monitor.currentInputStream()).toBeNull();
        expect(r.media[0]!.track.stop).toHaveBeenCalledOnce();
        expect(r.setCapture).toHaveBeenLastCalledWith(false);
        expect(r.ui.useUiStore.getState().metronome).toBe(false);
      }
    });
  }

  it('el rechazo tardío al preparar audio A se captura y no pisa la grabación B', async () => {
    const r = await rig();
    const init = deferred<void>();
    vi.mocked(r.engine.init).mockReturnValue(init.promise);
    const first = r.recorder.toggleRecording();
    r.store.replaceProject(r.core.createEmptyProject('B'));
    vi.mocked(r.engine.init).mockResolvedValue(undefined);
    await r.recorder.toggleRecording();
    r.recorder.useRecorderStore.setState({ error: 'Aviso B' });
    const before = snapshot(r);
    init.reject(new Error('Audio A no disponible'));
    await first;
    expect(snapshot(r)).toEqual(before);
    expect(r.recorder.useRecorderStore.getState()).toMatchObject({ phase: 'recording', error: 'Aviso B' });
    expect(r.media[0]!.track.stop).not.toHaveBeenCalled();
  });

  it('el rechazo de init antiguo del monitor no limpia el stream nuevo ni deja rechazo suelto', async () => {
    const r = await rig();
    const init = deferred<void>();
    vi.mocked(r.engine.init).mockReturnValue(init.promise);
    const first = r.monitor.startInputMonitor();
    r.monitor.stopInputMonitor();
    vi.mocked(r.engine.init).mockResolvedValue(undefined);
    expect(await r.monitor.startInputMonitor()).toBe(true);
    r.monitor.useInputMonitorStore.setState({ error: 'Aviso B' });
    init.reject(new Error('Audio A no disponible'));
    expect(await first).toBe(false);
    expect(r.monitor.useInputMonitorStore.getState()).toMatchObject({ listening: true, error: 'Aviso B' });
    expect(r.monitor.currentInputStream()).toBe(r.media[0]!.stream);
    expect(r.media[0]!.track.stop).not.toHaveBeenCalled();
  });
});
