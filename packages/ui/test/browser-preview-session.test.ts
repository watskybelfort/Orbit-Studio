import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoundEntry } from '@orbit/sound-library';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type Stage = 'init' | 'read' | 'load';

async function rig(stage: Stage = 'load', pin = true) {
  vi.resetModules(); vi.useFakeTimers();
  if (!pin) {
    vi.doMock('../src/state/sample-gc', async (original) => ({
      ...await original<typeof import('../src/state/sample-gc')>(),
      // Control negativo: módulo real sin la sujeción, igual que antes del fix.
      withPinnedSamples: <T,>(_ids: Iterable<string>, run: () => Promise<T>) => run(),
    }));
  }
  const gate = deferred<void>();
  const entered = deferred<void>();
  let gated = false;
  const wait = async (at: Stage) => {
    if (!gated && stage === at) { gated = true; entered.resolve(); await gate.promise; }
  };
  const read = vi.fn(async () => { await wait('read'); return new ArrayBuffer(8); });
  vi.stubGlobal('window', { orbit: {
    library: { read }, settings: { get: async () => ({}), set: async () => ({}) },
  } });
  vi.stubGlobal('navigator', {});
  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const gc = await import('../src/state/sample-gc');
  const sounds = await import('../src/browser/sound-actions');
  const { createPreviewSequence } = await import('../src/browser/preview-sequence');
  const sequence = createPreviewSequence();
  app.store.replaceProject(core.createEmptyProject('A'));
  const init = vi.spyOn(app.engine, 'init').mockImplementation(() => wait('init'));
  const loaded = (app.engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
  const upload = vi.spyOn(app.engine, 'loadSample').mockImplementation(async (id) => {
    loaded.add(id); await wait('load'); return { duration: 2 };
  });
  const heard: string[] = [];
  const play = vi.spyOn(app.engine, 'previewSample').mockImplementation((id) => {
    if (loaded.has(id)) heard.push(id);
  });
  const entry = (id = 'a'): SoundEntry => ({
    id, name: id, file: `${id}.wav`, category: 'instrumentos', tags: [], durationSec: 2,
  });
  const run = (id = 'a') => {
    const token = sequence.begin();
    return sounds.previewSound(entry(id), 0.37, () => sequence.isCurrent(token));
  };
  return { core, ...app, gc, sounds, sequence, gate, entered: entered.promise, init, read, upload, play, heard, loaded, entry, run };
}

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  vi.doUnmock('../src/state/sample-gc');
});

describe('BUG051: preview conserva audio hasta reproducir', () => {
  it.each([true, false])('carga y kernel reales con GC antes de preview (pin=%s)', async (pin) => {
    const r = await rig('load', pin);
    r.upload.mockRestore();
    r.play.mockRestore();
    r.init.mockResolvedValue(undefined);
    const { KernelCore, compileProject } = await import('@orbit/engine');
    const kernel = new KernelCore(8000);
    kernel.handleMessage({type: 'snapshot', project: compileProject(r.store.project, {mode: 'song'})});
    const decoded = deferred<AudioBuffer>();
    const decoding = deferred<void>();
    const engineInternals = r.engine as unknown as {
      ctx: AudioContext;
      send: (message: Parameters<typeof kernel.handleMessage>[0]) => void;
    };
    const messages: string[] = [];
    engineInternals.ctx = {decodeAudioData: () => { decoding.resolve(); return decoded.promise; }} as unknown as AudioContext;
    engineInternals.send = (message) => { messages.push(message.type); kernel.handleMessage(message); };
    const tone = Float32Array.from({length: 8000}, (_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / 8000));
    const pending = r.sounds.previewSound(r.entry(), 0.9, () => true);
    await decoding.promise;
    decoded.resolve({getChannelData: () => tone, numberOfChannels: 1, sampleRate: 8000, duration: 1} as unknown as AudioBuffer);
    // loadSample sube primero; esta microtarea precede a la continuación de previewSound.
    await Promise.resolve();
    r.gc.collectWorkletSamples(r.engine, r.store.project);
    expect(await pending).toBe(true);
    const left = new Float32Array(128), right = new Float32Array(128);
    kernel.process(left, right, 128);
    const peak = left.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    expect(messages.indexOf('loadSample')).toBeLessThan(messages.indexOf('collectSamples'));
    expect(messages.indexOf('collectSamples')).toBeLessThan(messages.indexOf('previewSample'));
    expect(peak).toBeCloseTo(pin ? 0.0899864137 : 0, 8);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it.each([true, false])('GC entre load y preview: pin=%s (false es control negativo)', async (pin) => {
    const r = await rig('load', pin);
    const before = r.core.serializeProject(r.store.project);
    const preview = r.run(); await r.entered;
    r.gc.collectWorkletSamples(r.engine, r.store.project);
    r.gate.resolve();
    expect(await preview).toBe(true);
    expect(r.play).toHaveBeenCalledWith('a', 0.37);
    // La llamada existe en ambos, pero sin pin no queda audio para sonar.
    expect(r.heard).toEqual(pin ? ['a'] : []);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.core.serializeProject(r.store.project)).toBe(before);
  });

  it.each(['init', 'read', 'load'] as const)('otro clic durante %s descarta la primera carga', async (stage) => {
    const r = await rig(stage);
    const a = r.run(); await r.entered;
    expect(await r.run('b')).toBe(true);
    r.gate.resolve(); expect(await a).toBe(false);
    expect(r.heard).toEqual(['b']);
    expect(r.play.mock.calls.map(([id]) => id)).toEqual(['b']);
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.loaded.has('a')).toBe(false);
    if (stage !== 'load') expect(r.upload.mock.calls.map(([id]) => id)).toEqual(['b']);
  });

  for (const stage of ['init', 'read', 'load'] as const) {
    it.each(['close', 'new project', 'same id'] as const)(`${stage}: %s invalida la carga sin sonar ni mutar`, async (reason) => {
      const r = await rig(stage);
      const pending = r.run(); await r.entered;
      if (reason === 'close') r.sequence.invalidate();
      else r.store.replaceProject(reason === 'same id' ? r.store.project : r.core.createEmptyProject('B'));
      const before = r.core.serializeProject(r.store.project);
      const version = r.store.version;
      r.gate.resolve(); expect(await pending).toBe(false);
      expect(r.play).not.toHaveBeenCalled();
      expect(r.core.serializeProject(r.store.project)).toBe(before);
      expect(r.store.version).toBe(version);
      expect(r.gc.pinnedSamples()).toEqual([]);
      expect(r.loaded.size).toBe(0);
      if (stage === 'init') expect(r.read).not.toHaveBeenCalled();
      if (stage !== 'load') expect(r.upload).not.toHaveBeenCalled();
    });
  }

  it.each(['init', 'read', 'load'] as const)('error vigente de %s llega al caller y libera audio/pin', async (stage) => {
    const r = await rig(stage);
    const error = new Error(`Fallo ${stage}`);
    const result = r.run().catch((err: unknown) => err); await r.entered;
    r.gate.reject(error);
    expect(await result).toBe(error);
    expect(r.play).not.toHaveBeenCalled();
    expect(r.gc.pinnedSamples()).toEqual([]);
    expect(r.loaded.size).toBe(0);
  });

  it.each(['close', 'new click', 'same id'] as const)('error tardío no llega al caller después de %s', async (reason) => {
    const r = await rig('read');
    const result = r.run(); await r.entered;
    if (reason === 'close') r.sequence.invalidate();
    if (reason === 'new click') await r.run('b');
    if (reason === 'same id') r.store.replaceProject(r.store.project);
    r.gate.reject(new Error('Viejo'));
    expect(await result).toBe(false);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('soltar la preescucha vieja no suelta el pin del mismo sonido solicitado después', async () => {
    const r = await rig();
    const a = r.run(); await r.entered;
    const bGate = deferred<void>();
    const bEntered = deferred<void>();
    r.upload.mockImplementationOnce(async (id) => {
      r.loaded.add(id); bEntered.resolve(); await bGate.promise; return { duration: 2 };
    });
    const b = r.run(); await bEntered.promise;
    r.gate.resolve(); expect(await a).toBe(false);
    expect(r.gc.pinnedSamples()).toEqual(['a']);
    expect(r.loaded.has('a')).toBe(true);
    r.gc.collectWorkletSamples(r.engine, r.store.project);
    bGate.resolve(); expect(await b).toBe(true);
    expect(r.heard).toEqual(['a']);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('al cancelar respeta el proyecto vigente y un consumidor ajeno', async () => {
    const r = await rig();
    const pending = r.run(); await r.entered;
    r.store.replaceProject(r.core.createEmptyProject('B'));
    r.store.dispatch({ type: 'registerSample', sample: {
      id: 'registered', name: 'Guardado', path: 'factory:kept.wav', hash: 'kept', duration: 1,
    } });
    r.loaded.add('registered'); r.loaded.add('other');
    const other = deferred<void>();
    const holding = r.gc.withPinnedSamples(['other'], () => other.promise);
    r.gate.resolve(); expect(await pending).toBe(false);
    expect([...r.loaded].sort()).toEqual(['other', 'registered']);
    expect(r.gc.pinnedSamples()).toEqual(['other']);
    other.resolve(); await holding;
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('un error del GC no oculta el error original de lectura', async () => {
    const r = await rig('read');
    const error = new Error('Archivo no encontrado');
    const pending = r.run().catch((err: unknown) => err); await r.entered;
    vi.spyOn(r.gc, 'collectWorkletSamples').mockImplementation(() => { throw new Error('GC'); });
    r.gate.reject(error); expect(await pending).toBe(error);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });
});
