import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { Project } from '@orbit/core';
import type { ToKernel } from '@orbit/engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function rig() {
  vi.resetModules(); vi.useFakeTimers();
  const core = await import('@orbit/core');
  const { KernelCore, compileProject, encodeWav } = await import('@orbit/engine');
  const sr = 8000;
  const wav = (hz: number) => {
    const tone = Float32Array.from({ length: sr }, (_, i) => 0.1 * Math.sin(2 * Math.PI * hz * i / sr));
    return encodeWav(tone, tone, sr, 32).slice().buffer as ArrayBuffer;
  };
  const bytes = new Map([['a.wav', wav(220)], ['b.wav', wav(440)]]);
  vi.stubGlobal('window', { orbit: {
    settings: { get: async () => ({}), set: async () => ({}) },
    recording: { read: async (file: string) => bytes.get(file)!.slice(0) },
  } });
  vi.stubGlobal('navigator', {});
  const app = await import('../src/state/app');
  const sounds = await import('../src/browser/sound-actions');
  const decoding = deferred<void>(), release = deferred<void>();
  let holdA = false;
  const decoder = vi.fn(async (data: ArrayBuffer) => {
    const view = new DataView(data);
    const left = new Float32Array((data.byteLength - 44) / 8);
    for (let i = 0; i < left.length; i++) left[i] = view.getFloat32(44 + i * 8, true);
    if (holdA) { holdA = false; decoding.resolve(); await release.promise; }
    return { getChannelData: () => left, numberOfChannels: 1, sampleRate: sr, duration: 1 };
  });
  (app.engine as unknown as { ctx: AudioContext }).ctx = { decodeAudioData: decoder } as unknown as AudioContext;
  const messages: ToKernel[] = [];
  vi.spyOn(app.engine, 'send').mockImplementation((msg) => { messages.push(msg); });
  const project = (file: string): Project => {
    const p = core.createEmptyProject(file);
    // Incluso project.id coincide: la frontera correcta es historyEpoch.
    p.id = 'same-project-id';
    core.applyCommand(p, { type: 'registerSample', sample: {
      id: 'same-sample-id', name: file, path: `recording:${file}`,
      hash: createHash('sha1').update(new Uint8Array(bytes.get(file)!)).digest('hex'), duration: 1,
    } });
    core.applyCommand(p, { type: 'addClips', clips: [{
      id: 'clip', kind: 'audio', sampleId: 'same-sample-id',
      playlistTrackId: Object.keys(p.playlistTracks)[0]!, start: 0, length: 2, muted: false,
    }] });
    return p;
  };
  const render = () => {
    const kernel = new KernelCore(sr);
    for (const message of messages) kernel.handleMessage(message);
    kernel.handleMessage({ type: 'snapshot', project: compileProject(app.store.project, { mode: 'song' }) });
    kernel.handleMessage({ type: 'play', fromBeat: 0 });
    const left = new Float32Array(128), right = new Float32Array(128), audio = new Float32Array(1024);
    for (let i = 0; i < audio.length; i += 128) { kernel.process(left, right, 128); audio.set(left, i); }
    kernel.dispose(); return audio;
  };
  return { core, ...app, sounds, decoder, messages, project, render, hold: () => { holdA = true; }, decoding: decoding.promise, release: () => release.resolve() };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG056/031: rehidratación con store, AudioEngine y DSP reales', () => {
  it('abrir A y luego B con mismos IDs y distinto hash/ruta produce audio B', async () => {
    const r = await rig();
    r.store.replaceProject(r.project('a.wav'));
    expect(await r.sounds.rehydrateSamples()).toEqual([]);
    const a = r.render();
    r.store.replaceProject(r.project('b.wav'));
    expect(await r.sounds.rehydrateSamples()).toEqual([]);
    const b = r.render();
    expect(r.decoder).toHaveBeenCalledTimes(2);
    expect(Math.max(...a.map((value, i) => Math.abs(value - b[i]!)))).toBeGreaterThan(0.1);
    r.engine.keepOnlySamples([]);
    await r.sounds.rehydrateSamples();
    expect(r.render()).toEqual(b);
    expect(r.decoder).toHaveBeenCalledTimes(3);
  });

  it('B decodifica primero y A termina después del replace: audio e historial siguen siendo B', async () => {
    const r = await rig();
    r.store.replaceProject(r.project('a.wav')); r.hold();
    const a = r.sounds.rehydrateSamples(); await r.decoding;
    r.store.replaceProject(r.project('b.wav'));
    expect(await r.sounds.rehydrateSamples()).toEqual([]);
    const b = r.render(), before = r.core.serializeProject(r.store.project), version = r.store.version;
    r.release(); await a;
    expect(r.render()).toEqual(b);
    expect(r.core.serializeProject(r.store.project)).toBe(before);
    expect(r.store.version).toBe(version);
    expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(1);
    expect(Math.max(...b.map(Math.abs))).toBeGreaterThan(0.08);
  });
});
