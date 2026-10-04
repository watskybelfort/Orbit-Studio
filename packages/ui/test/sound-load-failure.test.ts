import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoundEntry } from '@orbit/sound-library';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function rig() {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal('window', { orbit: { settings: { get: async () => ({}), set: async () => ({}) } } });
  vi.stubGlobal('navigator', {});
  const app = await import('../src/state/app');
  const gc = await import('../src/state/sample-gc');
  const sounds = await import('../src/browser/sound-actions');
  return { ...app, gc, sounds };
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('BUG052: un error de carga espera a todos los workers antes de soltar el lote', () => {
  it('no rechaza mientras otro worker sigue en vuelo, ni inicia trabajo nuevo tras el fallo', async () => {
    const r = await rig();
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    const seen: number[] = [];
    let finished = false;
    const error = new Error('Primero falló');
    const result = r.sounds.mapLimited([0, 1, 2, 3, 4], 3, (i) => {
      seen.push(i); return gates[i]?.promise ?? Promise.resolve(i);
    }).then(() => { finished = true; return null; }, (err: unknown) => { finished = true; return err; });
    expect(seen).toEqual([0, 1, 2]);
    gates[0]!.reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    gates[1]!.resolve(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(seen).toEqual([0, 1, 2]);
    gates[2]!.reject(new Error('Segundo fallo tardío'));
    expect(await result).toBe(error);
    expect(finished).toBe(true);
  });

  it('conserva un rechazo undefined y recoge también excepciones síncronas', async () => {
    const r = await rig();
    const gate = deferred<void>();
    const result = r.sounds.mapLimited([0, 1], 2, (i) => {
      if (i === 0) return Promise.reject(undefined);
      return gate.promise;
    });
    const checked = expect(result).rejects.toBeUndefined();
    gate.resolve();
    await checked;
    await expect(r.sounds.mapLimited([0], 1, () => { throw new Error('Fallo síncrono'); })).rejects.toThrow('Fallo síncrono');
  });

  it.each(['read', 'decode'] as const)('el lote real conserva pins durante %s tardío, incluso con otro lote solapado', async (stage) => {
    const r = await rig();
    const entries: SoundEntry[] = Array.from({ length: 6 }, (_, i) => ({
      id: `sound-${i}`, name: `Sonido ${i}`, category: 'instrumentos', file: `${i}.wav`, tags: [], durationSec: 1,
    }));
    const reads = Array.from({ length: 4 }, () => deferred<ArrayBuffer>());
    const decoding = deferred<void>();
    const decodeEntered = deferred<void>();
    const read = vi.fn((file: string) => reads[Number.parseInt(file)]?.promise ?? Promise.resolve(new ArrayBuffer(8)));
    Object.assign(window.orbit!, { library: { read } });
    const loaded = (r.engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
    r.store.dispatch({ type: 'registerSample', sample: {
      id: 'project-known', name: 'Conservar', path: 'factory:known.wav', hash: 'known-hash', duration: 1,
    } });
    loaded.add('project-known');
    const upload = vi.spyOn(r.engine, 'loadSample').mockImplementation(async (id) => {
      loaded.add(id);
      if (stage === 'decode' && id === entries[1]!.id) { decodeEntered.resolve(); await decoding.promise; }
      return { duration: 1 };
    });
    let settled = false;
    const firstError = new Error('No se pudo leer 0');
    const first = r.sounds.addSamplerChannels(entries).then(
      () => { settled = true; return null; }, (err: unknown) => { settled = true; return err; },
    );
    expect(read).toHaveBeenCalledTimes(4);
    if (stage === 'decode') {
      reads[1]!.resolve(new ArrayBuffer(8));
      await decodeEntered.promise;
    }
    // Otro consumidor mantiene el mismo sample sujeto mientras falla este lote.
    const overlap = deferred<void>();
    const second = r.gc.withPinnedSamples([entries[1]!.id], () => overlap.promise);
    reads[0]!.reject(firstError);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(r.gc.pinnedSamples().sort()).toEqual(entries.map((entry) => entry.id).sort());
    r.gc.collectWorkletSamples(r.engine, r.store.project);
    if (stage === 'decode') expect(loaded.has(entries[1]!.id)).toBe(true);
    reads[1]!.resolve(new ArrayBuffer(8));
    reads[2]!.reject(new Error('Otro archivo falló'));
    reads[3]!.resolve(new ArrayBuffer(8));
    decoding.resolve();
    expect(await first).toBe(firstError);
    expect(read).toHaveBeenCalledTimes(4);
    expect(upload.mock.calls.map(([id]) => id)).not.toContain(entries[4]!.id);
    expect(Object.keys(r.store.project.samples)).toEqual(['project-known']);
    // El final del lote limpia lo subido sin registrar, pero respeta el modelo
    // vigente y al consumidor que aún mantiene su propio pin sobre sound-1.
    expect([...loaded].sort()).toEqual(['project-known', entries[1]!.id].sort());
    expect(r.gc.pinnedSamples()).toEqual([entries[1]!.id]);
    overlap.resolve(); await second;
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('un fallo del recolector conserva el rechazo original y no deja pins', async () => {
    const r = await rig();
    const error = new Error('Archivo ausente');
    Object.assign(window.orbit!, { library: { read: () => Promise.reject(error) } });
    vi.spyOn(r.gc, 'collectWorkletSamples').mockImplementation(() => { throw new Error('Motor desconectado'); });
    await expect(r.sounds.addSamplerChannels([{
      id: 'missing', name: 'Ausente', category: 'instrumentos', file: 'missing.wav', tags: [], durationSec: 1,
    }])).rejects.toBe(error);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });
});
