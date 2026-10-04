import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '@orbit/core';
import { AudioEngine, SampleLoadCancelledError } from '../src/engine';
import { KernelCore } from '../src/kernel-core';
import { compileProject } from '../src/compile';
import { encodeWav } from '../src/render/wav';
import type { ToKernel } from '../src/protocol';

const SR = 8000;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function wav(hz: number, seconds = 1): ArrayBuffer {
  const tone = Float32Array.from({ length: SR * seconds }, (_, i) => 0.1 * Math.sin(2 * Math.PI * hz * i / SR));
  const bytes = encodeWav(tone, tone, SR, 32);
  return bytes.slice().buffer as ArrayBuffer;
}

function decode(bytes: ArrayBuffer): AudioBuffer {
  const view = new DataView(bytes);
  const left = new Float32Array((bytes.byteLength - 44) / 8);
  for (let i = 0; i < left.length; i++) left[i] = view.getFloat32(44 + i * 8, true);
  return { getChannelData: () => left, numberOfChannels: 1, sampleRate: SR, duration: left.length / SR } as unknown as AudioBuffer;
}

function rig() {
  const engine = new AudioEngine();
  const decoder = vi.fn(async (bytes: ArrayBuffer) => decode(bytes));
  (engine as unknown as { ctx: AudioContext }).ctx = { decodeAudioData: decoder } as unknown as AudioContext;
  const messages: ToKernel[] = [];
  vi.spyOn(engine, 'send').mockImplementation((message) => { messages.push(message); });
  const render = () => {
    const kernel = new KernelCore(SR);
    kernel.handleMessage({ type: 'snapshot', project: compileProject(createEmptyProject(), { mode: 'song' }) });
    for (const message of messages) kernel.handleMessage(message);
    kernel.handleMessage({ type: 'previewSample', sampleId: 'same-id', gain: 0.9 });
    const left = new Float32Array(128), right = new Float32Array(128);
    const audio = new Float32Array(1024);
    for (let at = 0; at < audio.length; at += 128) { kernel.process(left, right, 128); audio.set(left, at); }
    kernel.dispose();
    return audio;
  };
  return { engine, decoder, messages, render };
}

function holdDecode(r: ReturnType<typeof rig>) {
  const gate = deferred<void>(), entered = deferred<void>();
  r.decoder.mockImplementationOnce(async (bytes) => { entered.resolve(); await gate.promise; return decode(bytes); });
  return { release: () => gate.resolve(), entered: entered.promise };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG056: identidad de contenido en AudioEngine', () => {
  it('mismo ID y WAV distinto reemplaza el audio y la duración', async () => {
    const r = rig();
    expect(await r.engine.loadSample('same-id', wav(220))).toEqual({ duration: 1 });
    const a = r.render();
    expect(await r.engine.loadSample('same-id', wav(440, 2))).toEqual({ duration: 2 });
    const b = r.render();
    expect(r.decoder).toHaveBeenCalledTimes(2);
    expect(Math.max(...a.map((value, i) => Math.abs(value - b[i]!)))).toBeGreaterThan(0.1);
    expect(Math.max(...b.map(Math.abs))).toBeGreaterThan(0.08);
  });

  it('bytes idénticos en otro ArrayBuffer reutilizan el audio confirmado', async () => {
    const r = rig();
    const bytes = wav(220);
    await r.engine.loadSample('same-id', bytes);
    const a = r.render();
    expect(await r.engine.loadSample('same-id', bytes.slice(0))).toEqual({ duration: 1 });
    expect(r.decoder).toHaveBeenCalledTimes(1);
    expect(r.render()).toEqual(a);
  });

  it('la copia identificada no cambia si el caller modifica su buffer', async () => {
    const r = rig();
    const original = wav(220);
    const expected = original.slice(0);
    const pending = r.engine.loadSample('same-id', original);
    new Uint8Array(original).set(new Uint8Array(wav(440)));
    await pending;
    expect(r.decoder.mock.calls[0]![0]).toEqual(expected);
    await r.engine.loadSample('same-id', expected);
    expect(r.decoder).toHaveBeenCalledTimes(1);
  });

  it('sin WebCrypto no reutiliza una caché de identidad desconocida', async () => {
    const r = rig();
    vi.stubGlobal('crypto', undefined);
    await r.engine.loadSample('same-id', wav(220));
    const a = r.render();
    await r.engine.loadSample('same-id', wav(440));
    expect(r.decoder).toHaveBeenCalledTimes(2);
    expect(r.render()).not.toEqual(a);
  });
});

describe('BUG031: decodificaciones retiradas no publican audio sobre otro contenido', () => {
  it.each([false, true])('decode A lento → B → A último, reemplazo de sesión=%s', async (replace) => {
    const r = rig(), aGate = holdDecode(r);
    const a = r.engine.loadSample('same-id', wav(220)).catch((error: unknown) => error);
    await aGate.entered;
    if (replace) r.engine.invalidateSampleLoads();
    await r.engine.loadSample('same-id', wav(440, 2));
    const b = r.render();
    aGate.release();
    expect(await a).toBeInstanceOf(SampleLoadCancelledError);
    expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(1);
    expect(r.render()).toEqual(b);
    expect(Math.max(...b.map(Math.abs))).toBeGreaterThan(0.08);
    expect(await r.engine.loadSample('same-id', wav(440, 2))).toEqual({ duration: 2 });
    expect(r.decoder).toHaveBeenCalledTimes(2);
  });

  it('dos consumidores de los mismos bytes comparten decode aunque uno cancele', async () => {
    const r = rig(), gate = holdDecode(r);
    let firstCurrent = true;
    const bytes = wav(220);
    const first = r.engine.loadSample('same-id', bytes, () => firstCurrent).catch((error: unknown) => error);
    await gate.entered;
    const second = r.engine.loadSample('same-id', bytes.slice(0), () => true);
    firstCurrent = false; gate.release();
    expect(await first).toBeInstanceOf(SampleLoadCancelledError);
    expect(await second).toEqual({ duration: 1 });
    expect(r.decoder).toHaveBeenCalledTimes(1);
    expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(1);
    expect(Math.max(...r.render().map(Math.abs))).toBeGreaterThan(0.08);
  });

  it('el único consumidor cancelado no publica ni deja una duración cacheada', async () => {
    const r = rig(), gate = holdDecode(r);
    let current = true;
    const pending = r.engine.loadSample('same-id', wav(220), () => current).catch((error: unknown) => error);
    await gate.entered; current = false; gate.release();
    expect(await pending).toBeInstanceOf(SampleLoadCancelledError);
    expect(r.messages).toEqual([]);
    expect(Math.max(...r.render().map(Math.abs))).toBe(0);
    await r.engine.loadSample('same-id', wav(440));
    expect(r.decoder).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])('GC durante decode conserva solo el ID vivo (keep=%s)', async (keep) => {
    const r = rig(), gate = holdDecode(r);
    const pending = r.engine.loadSample('same-id', wav(220)).catch((error: unknown) => error);
    await gate.entered;
    r.engine.keepOnlySamples(keep ? ['same-id'] : []);
    gate.release();
    if (keep) expect(await pending).toEqual({ duration: 1 });
    else expect(await pending).toBeInstanceOf(SampleLoadCancelledError);
    expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(keep ? 1 : 0);
  });

  it('digest A lento no desplaza la carga B que llegó después', async () => {
    const r = rig();
    const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    const gate = deferred<void>(), entered = deferred<void>();
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      entered.resolve(); await gate.promise; return digest(algorithm, data);
    });
    const a = r.engine.loadSample('same-id', wav(220)).catch((error: unknown) => error);
    await entered.promise;
    await r.engine.loadSample('same-id', wav(440));
    const b = r.render(); gate.resolve();
    expect(await a).toBeInstanceOf(SampleLoadCancelledError);
    expect(r.decoder).toHaveBeenCalledTimes(1);
    expect(r.render()).toEqual(b);
  });

  it('epoch se captura antes del init pendiente', async () => {
    const r = rig();
    (r.engine as unknown as { ctx: AudioContext | null }).ctx = null;
    const gate = deferred<void>();
    vi.spyOn(r.engine, 'init').mockImplementation(async () => {
      await gate.promise;
      (r.engine as unknown as { ctx: AudioContext }).ctx = { decodeAudioData: r.decoder } as unknown as AudioContext;
    });
    const a = r.engine.loadSample('same-id', wav(220)).catch((error: unknown) => error);
    r.engine.invalidateSampleLoads();
    const b = r.engine.loadSample('same-id', wav(440));
    gate.resolve();
    expect(await a).toBeInstanceOf(SampleLoadCancelledError);
    expect(await b).toEqual({ duration: 1 });
    expect(r.decoder).toHaveBeenCalledTimes(1);
    expect(r.decoder.mock.calls[0]![0]).toEqual(wav(440));
  });
});
