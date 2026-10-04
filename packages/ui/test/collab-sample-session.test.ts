import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollabSession } from '@orbit/collab';
import type { SampleRef } from '@orbit/core';
import type { ToKernel } from '@orbit/engine';
import { readSource } from './read-source';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const sessions: CollabSession[] = [];
async function rig(stage: 'read' | 'decode' = 'read') {
  vi.resetModules(); vi.useFakeTimers();
  const core = await import('@orbit/core');
  const { encodeWav, KernelCore, compileProject } = await import('@orbit/engine');
  const { CollabSession } = await import('@orbit/collab');
  const rate = 8000;
  const files = new Map<string, ArrayBuffer>(['a', 'b', 'c'].map((name, at) => {
    const pcm = Float32Array.from({ length: rate }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 220 * (at + 1) * i / rate));
    return [`${name}.wav`, encodeWav(pcm, pcm, rate, 32).slice().buffer as ArrayBuffer] as const;
  }));
  const gate = deferred<void>(), entered = deferred<void>();
  let gated = false;
  const wait = async (at: 'read' | 'decode') => {
    if (!gated && stage === at) { gated = true; entered.resolve(); await gate.promise; }
  };
  const read = vi.fn(async (file: string) => {
    await wait('read');
    const bytes = files.get(file);
    if (!bytes) throw new Error(`No existe ${file}`);
    return bytes.slice(0);
  });
  vi.stubGlobal('window', { orbit: {
    settings: { get: async () => ({}), set: async () => ({}) }, recording: { read }, library: { read },
  } });
  vi.stubGlobal('navigator', {});
  const app = await import('../src/state/app');
  const sync = await import('../src/collab/sample-sync');
  const gc = await import('../src/state/sample-gc');
  const decoder = vi.fn(async (bytes: ArrayBuffer) => {
    await wait('decode');
    const view = new DataView(bytes), pcm = new Float32Array((bytes.byteLength - 44) / 8);
    for (let i = 0; i < pcm.length; i++) pcm[i] = view.getFloat32(44 + i * 8, true);
    return { getChannelData: () => pcm, numberOfChannels: 1, sampleRate: rate, duration: pcm.length / rate };
  });
  (app.engine as unknown as { ctx: AudioContext }).ctx = { decodeAudioData: decoder } as unknown as AudioContext;
  const messages: ToKernel[] = [];
  vi.spyOn(app.engine, 'send').mockImplementation((message) => { messages.push(message); });
  const sample = (file: string, id = 'shared'): SampleRef => ({
    id, name: file, path: `recording:${file}`, duration: 1,
    hash: createHash('sha1').update(new Uint8Array(files.get(file) ?? new ArrayBuffer(0))).digest('hex'),
  });
  const replace = (file: string) => {
    const p = core.createEmptyProject(file); p.id = 'same-project';
    core.applyCommand(p, { type: 'registerSample', sample: sample(file) });
    app.store.replaceProject(p);
  };
  const room = (name: string, maxAssetBytes?: number) => {
    const session = new CollabSession(app.store, { user: { name, color: 'orange' }, ...(maxAssetBytes === undefined ? {} : { maxAssetBytes }) });
    sessions.push(session); return session;
  };
  const render = () => {
    const kernel = new KernelCore(rate);
    kernel.handleMessage({ type: 'snapshot', project: compileProject(app.store.project, { mode: 'song' }) });
    for (const message of messages) kernel.handleMessage(message);
    kernel.handleMessage({ type: 'previewSample', sampleId: 'shared', gain: 0.9 });
    const left = new Float32Array(128), right = new Float32Array(128), audio = new Float32Array(1024);
    for (let i = 0; i < audio.length; i += 128) { kernel.process(left, right, 128); audio.set(left, i); }
    kernel.dispose(); return audio;
  };
  replace('a.wav');
  return { core, ...app, sync, gc, read, decoder, messages, files, sample, replace, room, render,
    entered: entered.promise, release: () => gate.resolve(), reject: (error: unknown) => gate.reject(error) };
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.destroy();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('BUG032: una sincronización retirada no publica sobre la nueva', () => {
  for (const stage of ['read', 'decode'] as const) {
    it.each(['reset', 'epoch', 'room'] as const)(`${stage} A lento → B antes de A; frontera %s`, async (boundary) => {
      const r = await rig(stage), aRoom = r.room('A');
      const a = r.sync.syncSamplesAfterProjectReplaced(aRoom); await r.entered;
      if (boundary === 'reset') r.sync.resetSampleSync();
      r.replace('b.wav');
      const bRoom = boundary === 'epoch' ? aRoom : r.room('B');
      const b = await r.sync.syncSamplesAfterProjectReplaced(bRoom);
      expect(b).toEqual({ loaded: 1, published: 1, missing: [] });
      const audio = r.render();
      r.release(); const old = await a;
      expect(old).toEqual({ loaded: 0, published: 0, missing: [] });
      expect(r.sync.isSampleSyncReportCurrent(aRoom, old)).toBe(false);
      expect(r.sync.isSampleSyncReportCurrent(bRoom, b)).toBe(true);
      expect(aRoom.hasSample(r.sample('a.wav').hash)).toBe(false);
      expect(bRoom.getSample(r.sample('b.wav').hash)).toEqual(new Uint8Array(r.files.get('b.wav')!));
      expect(r.render()).toEqual(audio);
      expect(Math.max(...audio.map(Math.abs))).toBeGreaterThan(0.08);
      expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(1);
      expect(r.messages.filter((msg) => msg.type === 'collectSamples')).toHaveLength(1);
    });
  }

  it.each(['read', 'decode'] as const)('reset del mismo objeto de sala/epoch durante %s retira informes y consumidores viejos', async (stage) => {
    const r = await rig(stage), room = r.room('Misma');
    const publish = vi.spyOn(room, 'publishSample');
    const old = r.sync.syncSamplesWithRoom(room); await r.entered;
    const epoch = r.store.historyEpoch;
    r.sync.resetSampleSync();
    const current = await r.sync.syncSamplesWithRoom(room);
    r.release(); const previous = await old;
    expect(r.store.historyEpoch).toBe(epoch);
    expect(current).toEqual({ loaded: 1, published: 1, missing: [] });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(r.sync.isSampleSyncReportCurrent(room, previous)).toBe(false);
    expect(r.sync.isSampleSyncReportCurrent(room, current)).toBe(true);
    expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(1);
    r.sync.resetSampleSync();
    expect(r.sync.isSampleSyncReportCurrent(room, current)).toBe(false);
  });

  it.each(['read', 'decode'] as const)('fallo %s de A tardío no cambia el missing vigente de B', async (stage) => {
    const r = await rig(stage), aRoom = r.room('A'), bRoom = r.room('B');
    const old = r.sync.syncSamplesWithRoom(aRoom); await r.entered;
    r.sync.resetSampleSync(); r.replace('absent.wav');
    const current = await r.sync.syncSamplesWithRoom(bRoom);
    expect(current.missing).toEqual(['absent.wav']);
    r.reject(new Error('Fallo viejo')); const previous = await old;
    expect(previous).toEqual({ loaded: 0, published: 0, missing: [] });
    expect(r.sync.isSampleSyncReportCurrent(bRoom, current)).toBe(true);
    expect(r.sync.isSampleSyncReportCurrent(aRoom, previous)).toBe(false);
    expect(aRoom.sampleHashes).toEqual([]);
    expect(bRoom.sampleHashes).toEqual([]);
  });

  it('llamadas paralelas esperan la pasada y su rerun; un finally viejo no libera la nueva', async () => {
    const r = await rig(), roomA = r.room('A');
    const old = r.sync.syncSamplesWithRoom(roomA); await r.entered;
    r.sync.resetSampleSync(); r.replace('b.wav');
    const gateB = deferred<ArrayBuffer>(), enteredB = deferred<void>();
    r.read.mockImplementationOnce(() => { enteredB.resolve(); return gateB.promise; });
    const roomB = r.room('B');
    const first = r.sync.syncSamplesWithRoom(roomB); await enteredB.promise;
    r.release(); await old;
    let settled = false;
    const second = r.sync.syncSamplesWithRoom(roomB).then((report) => { settled = true; return report; });
    r.store.dispatch({ type: 'registerSample', sample: r.sample('c.wav', 'third') });
    await Promise.resolve(); expect(settled).toBe(false);
    gateB.resolve(r.files.get('b.wav')!);
    const a = await first, b = await second;
    expect(a).toBe(b);
    expect(b).toEqual({ loaded: 2, published: 2, missing: [] });
    expect(r.read.mock.calls.map(([file]) => file)).toEqual(['a.wav', 'b.wav', 'c.wav']);
    expect(roomB.sampleHashes.sort()).toEqual([r.sample('b.wav').hash, r.sample('c.wav').hash].sort());
  });

  it.each(['read', 'decode'] as const)('cambiar hash/ruta durante %s reencola el contenido actual sin reset de sesión', async (stage) => {
    const r = await rig(stage), room = r.room('A');
    const pending = r.sync.syncSamplesWithRoom(room); await r.entered;
    r.store.dispatch({ type: 'registerSample', sample: r.sample('b.wav') });
    r.release(); const report = await pending;
    expect(report).toEqual({ loaded: 1, published: 1, missing: [] });
    expect(room.sampleHashes).toEqual([r.sample('b.wav').hash]);
    expect(r.messages.filter((msg) => msg.type === 'loadSample')).toHaveLength(1);
  });

  it('el hash/ruta cambia la firma y retira una lectura local fallida del ID anterior', async () => {
    const r = await rig(), room = r.room('A'); r.release();
    r.replace('absent.wav');
    expect(r.sync.sampleSetChanged()).toBe(true);
    expect((await r.sync.syncSamplesWithRoom(room)).missing).toEqual(['absent.wav']);
    r.store.dispatch({ type: 'registerSample', sample: r.sample('b.wav') });
    expect(r.sync.sampleSetChanged()).toBe(true);
    expect(r.sync.sampleSetChanged()).toBe(false);
    expect(await r.sync.syncSamplesWithRoom(room)).toEqual({ loaded: 1, published: 1, missing: [] });
  });

  it('GC tras desregistrar y volver a registrar obliga a subir el sample otra vez', async () => {
    const r = await rig(), room = r.room('A'); r.release();
    r.sync.sampleSetChanged(); await r.sync.syncSamplesWithRoom(room);
    r.store.dispatch({ type: 'unregisterSample', sampleId: 'shared' });
    r.sync.sampleSetChanged(); r.gc.collectWorkletSamples(r.engine, r.store.project);
    r.store.dispatch({ type: 'registerSample', sample: r.sample('a.wav') });
    r.sync.sampleSetChanged();
    expect(await r.sync.syncSamplesWithRoom(room)).toEqual({ loaded: 1, published: 0, missing: [] });
    expect(r.decoder).toHaveBeenCalledTimes(2);
    expect(Math.max(...r.render().map(Math.abs))).toBeGreaterThan(0.08);
  });

  it('lee bytes reales de la sala cuando el disco falta y no los republica', async () => {
    const r = await rig(), room = r.room('Remota'); r.release();
    const ref = r.sample('a.wav');
    room.publishSample(new Uint8Array(r.files.get('a.wav')!), ref);
    r.read.mockRejectedValue(new Error('Sin disco local'));
    expect(await r.sync.syncSamplesWithRoom(room)).toEqual({ loaded: 1, published: 0, missing: [] });
    expect(Math.max(...r.render().map(Math.abs))).toBeGreaterThan(0.08);
  });

  it('rechazo por capacidad conserva audio local y no cuenta una publicación inexistente', async () => {
    const r = await rig(), room = r.room('Llena', 1); r.release();
    const publish = vi.spyOn(room, 'publishSample');
    expect(await r.sync.syncSamplesWithRoom(room)).toEqual({ loaded: 1, published: 0, missing: [] });
    await r.sync.syncSamplesWithRoom(room);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(room.sampleHashes).toEqual([]);
    expect(Math.max(...r.render().map(Math.abs))).toBeGreaterThan(0.08);
  });

  it('collab-state exige propiedad del informe antes de publicar missingSamples', () => {
    const source = readSource('collab/collab-state.ts');
    const at = source.indexOf('function runSampleSync(');
    const body = source.slice(at, source.indexOf('\n}', at));
    expect(body).toContain('!isSampleSyncReportCurrent(s, report)');
    expect(body.indexOf('!isSampleSyncReportCurrent(s, report)')).toBeLessThan(body.indexOf('useCollabStore.setState'));
  });
});
