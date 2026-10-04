import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoundEntry } from '@orbit/sound-library';
import type { ToKernel } from '@orbit/engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

type Writer = 'preview' | 'import' | 'loadIntoEngine' | 'bounce' | 'audio-edit' | 'capture' | 'recorder';

async function rig(guard: boolean) {
  vi.resetModules(); vi.useFakeTimers();
  const core = await import('@orbit/core');
  const { KernelCore, encodeWav, compileProject } = await import('@orbit/engine');
  const rate = 8000;
  const pcm = Float32Array.from({ length: 1600 }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / rate));
  const wav = encodeWav(pcm, pcm, rate, 24);
  const files: string[] = [];
  vi.stubGlobal('window', { orbit: {
    settings: { get: async () => ({}), set: async () => ({}) },
    library: { read: async () => wav.slice().buffer },
    recording: { save: async (name: string) => { files.push(name); return name; } },
  } });
  vi.stubGlobal('navigator', {});
  const app = await import('../src/state/app');
  const ui = await import('../src/state/ui');
  const sounds = await import('../src/browser/sound-actions');
  const gc = await import('../src/state/sample-gc');
  const bounce = await import('../src/state/bounce');
  const edits = await import('../src/editors/audio/audio-edit-actions');
  const capture = await import('../src/state/track-capture');
  const recorder = await import('../src/state/recorder');
  const monitor = await import('../src/state/input-monitor');
  app.store.replaceProject(core.createEmptyProject('A'));
  ui.useUiStore.setState({ playing: true });
  recorder.useRecorderStore.setState({ countInBars: 0 });
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  vi.spyOn(app.engine, 'sampleRate', 'get').mockReturnValue(rate);
  vi.spyOn(app, 'currentBeat').mockReturnValue(4);
  vi.spyOn(app.engine, 'connectInput').mockReturnValue({ disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode);
  const track = { stop: vi.fn(), onended: null, getSettings: () => ({ channelCount: 2 }) };
  monitor.setInputStreamFactory(async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) as unknown as MediaStream);
  // Aislar la guarda de CADA caller: la protección global de beforeReplace
  // tiene pruebas propias; aquí no puede ocultar que falte el tercer argumento.
  vi.spyOn(app.engine, 'invalidateSampleLoads').mockImplementation(() => undefined);
  const load = app.engine.loadSample.bind(app.engine);
  if (!guard) vi.spyOn(app.engine, 'loadSample').mockImplementation((id, bytes) => load(id, bytes));
  const gate = deferred<void>(), entered = deferred<void>();
  (app.engine as unknown as { ctx: AudioContext }).ctx = {
    state: 'running',
    decodeAudioData: async (bytes: ArrayBuffer) => {
      entered.resolve(); await gate.promise;
      const view = new DataView(bytes);
      const left = new Float32Array((bytes.byteLength - 44) / 6);
      for (let i = 0; i < left.length; i++) {
        const at = 44 + i * 6;
        const n = view.getUint8(at) | view.getUint8(at + 1) << 8 | view.getInt8(at + 2) << 16;
        left[i] = n / 8388608;
      }
      return { getChannelData: () => left, numberOfChannels: 1, sampleRate: rate, duration: left.length / rate };
    },
  } as unknown as AudioContext;
  const kernel = new KernelCore(rate);
  kernel.handleMessage({ type: 'snapshot', project: compileProject(app.store.project, { mode: 'song' }) });
  const uploads: ToKernel[] = [], peaks: number[] = [];
  vi.spyOn(app.engine, 'send').mockImplementation((message) => {
    kernel.handleMessage(message);
    if (message.type !== 'loadSample') return;
    uploads.push(message);
    // Medir inmediatamente lo que se hizo audible: un GC posterior podría
    // esconder el upload obsoleto, pero no deshacer ese efecto ya enviado.
    kernel.handleMessage({ type: 'previewSample', sampleId: message.sampleId, gain: 0.9 });
    const left = new Float32Array(128), right = new Float32Array(128);
    kernel.process(left, right, 128);
    peaks.push(Math.max(...left.map(Math.abs)));
  });
  const prepare = async (kind: Writer) => {
    let cancel = () => app.store.replaceProject(core.createEmptyProject('B'));
    let pending: Promise<unknown>;
    let recovery = () => '';
    const entry: SoundEntry = { id: 'sample', name: 'Sample', file: 'sample.wav', category: 'instrumentos', tags: [], durationSec: 0.2 };
    if (kind === 'preview') {
      let current = true;
      pending = sounds.previewSound(entry, 0.9, () => current);
      cancel = () => { current = false; };
    } else if (kind === 'import') pending = sounds.addSamplerChannel(entry);
    else if (kind === 'loadIntoEngine') pending = sounds.loadIntoEngine(entry);
    else if (kind === 'capture') {
      await capture.toggleTrackCapture(1);
      capture.pushCaptureChunk(pcm, pcm);
      pending = capture.stopTrackCapture();
      recovery = () => capture.useTrackCapture.getState().recoveryNotice ?? '';
    } else if (kind === 'recorder') {
      app.store.dispatch({ type: 'addInputRoute', route: core.createInputRoute(0) });
      await recorder.toggleRecording();
      recorder.pushInputChunk(pcm, pcm);
      pending = recorder.toggleRecording();
      await vi.advanceTimersByTimeAsync(120);
      recovery = () => recorder.useRecorderStore.getState().recoveryNotice ?? '';
    } else {
      app.store.dispatch({ type: 'registerSample', sample: { id: 'source', name: 'Voz', path: 'recording:source.wav', hash: 'source', duration: 0.2 } });
      app.store.dispatch({ type: 'addClips', clips: [{ id: 'clip', kind: 'audio', sampleId: 'source', playlistTrackId: Object.keys(app.store.project.playlistTracks)[0]!, start: 0, length: 1, muted: false }] });
      if (kind === 'audio-edit') {
        const actions = edits.createAudioEditActions(() => undefined);
        const channels = { left: pcm, right: pcm, rate, duration: 0.2 };
        pending = actions.run({ clip: app.store.project.clips.clip!, sample: app.store.project.samples.source!, channels,
          fileKind: 'Normalizar', sampleName: 'Voz editada', label: 'Editar', process: () => channels });
        cancel = actions.cancel;
        recovery = () => edits.useAudioEditStore.getState().recoveryNotice ?? '';
      } else {
        const paint = await import('../src/state/next-paint');
        vi.spyOn(paint, 'nextPaint').mockResolvedValue(undefined);
        const inputs = await import('../src/export/render-inputs');
        vi.spyOn(inputs, 'collectSamples').mockResolvedValue({ samples: new Map(), missing: [] });
        const worker = await import('../src/export/render-in-worker');
        vi.spyOn(worker, 'canUseRenderWorker').mockReturnValue(true);
        vi.spyOn(worker, 'renderProjectInWorker').mockResolvedValue({ left: pcm, right: pcm, sampleRate: rate });
        pending = bounce.bounceClip('clip');
        cancel = () => { app.store.dispatch({ type: 'setTempo', tempo: 171 }); };
        recovery = () => bounce.useBounceStore.getState().recoveryNotice ?? '';
      }
    }
    return { pending: pending.catch((error: unknown) => error), cancel, recovery };
  };
  return { core, ...app, sounds, gc, files, uploads, peaks, kernel, prepare, entered: entered.promise, release: () => gate.resolve() };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG031: cada consumidor cancela dentro del decode real', () => {
  for (const writer of ['preview', 'import', 'loadIntoEngine', 'bounce', 'audio-edit', 'capture', 'recorder'] as const) {
    it.each([true, false])(`${writer}: guarda=%s (false omite solo callback, control negativo)`, async (guard) => {
      const r = await rig(guard);
      const operation = await r.prepare(writer);
      await r.entered;
      operation.cancel();
      const before = r.core.serializeProject(r.store.project);
      r.release(); await operation.pending;
      expect(r.uploads).toHaveLength(guard ? 0 : 1);
      expect(r.peaks.length).toBe(guard ? 0 : 1);
      if (!guard) expect(r.peaks[0]).toBeGreaterThan(0.08);
      expect(r.core.serializeProject(r.store.project)).toBe(before);
      expect(r.gc.pinnedSamples()).toEqual([]);
      if (r.files.length) expect(operation.recovery()).toContain(r.files[0]);
      r.kernel.dispose();
    });
  }

  it('cancelar la consulta de duración no se convierte en duración estimada y registro exitoso', async () => {
    const r = await rig(true);
    const { SampleLoadCancelledError } = await import('@orbit/engine');
    vi.spyOn(r.engine, 'loadSample').mockResolvedValueOnce({ duration: 0.2 }).mockRejectedValueOnce(new SampleLoadCancelledError());
    const before = r.core.serializeProject(r.store.project);
    await expect(r.sounds.addSamplerChannel({
      id: 'sample', name: 'Sample', file: 'sample.wav', category: 'instrumentos', tags: [], durationSec: 0,
    })).rejects.toBeInstanceOf(SampleLoadCancelledError);
    expect(r.core.serializeProject(r.store.project)).toBe(before);
    expect(r.gc.pinnedSamples()).toEqual([]);
    r.kernel.dispose();
  });
});
