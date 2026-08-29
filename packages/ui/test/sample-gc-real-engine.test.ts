/**
 * `collectWorkletSamples` contra el `AudioEngine` DE VERDAD, no contra un
 * objeto de mentira hecho a mano.
 *
 * `sample-gc-v1.test.ts` ya prueba la función a fondo, pero siempre con
 * `{ send, keepOnlySamples }` construido en el propio test — nunca con la
 * clase real de `@orbit/engine`. Eso deja sin cubrir justo lo que puede
 * romperse en silencio: que la interfaz `SampleGcEngine` siga encajando con
 * `AudioEngine` de verdad (el mismo método, llamado con `this` correcto) y
 * que `rehydrateSamples()` —la función que la auditoría v3.5 (tarea db8986f2
 * / ac6c9c8f) señaló que NUNCA se probó llamando a esto— la invoque de
 * verdad y no solo en la intención de un comentario.
 *
 * `AudioEngine.loadSample()` real exige un `AudioContext` (gesto del
 * usuario, worklet cargado…) que no existe en este entorno de test sin
 * jsdom; así que aquí se seedea la MISMA caché privada que `loadSample()`
 * rellena en producción (`loadedSamples` / `sampleDurations`, ver
 * `packages/engine/src/engine.ts:311-312`) para poder ejercitar el método
 * público real que `collectWorkletSamples` de verdad llama —`keepOnlySamples`—
 * sin reimplementar su comportamiento.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  type Project,
  type SampleRef,
} from '@orbit/core';
import { AudioEngine } from '@orbit/engine';
import { collectWorkletSamples } from '../src/state/sample-gc';

function ref(id: string): SampleRef {
  return { id, name: id, path: `qa:${id}`, hash: id, duration: 1 };
}

/** Proyecto con un sampler que usa 'usado'; 'usado' es el único registrado. */
function project(): Project {
  const p = createEmptyProject('GC motor real');
  const channel = createChannel('sampler', 0, 'Uno');
  applyCommand(p, { type: 'addChannel', channel });
  applyCommand(p, { type: 'registerSample', sample: ref('usado') });
  applyCommand(p, { type: 'patchChannel', channelId: channel.id, patch: { sampleId: 'usado' } });
  return p;
}

/** Acceso a los mapas privados de `AudioEngine`, solo para sembrar/leer en el test. */
function cachesOf(engine: AudioEngine): { loaded: Set<string>; durations: Map<string, number> } {
  const anyEngine = engine as unknown as {
    loadedSamples: Set<string>;
    sampleDurations: Map<string, number>;
  };
  return { loaded: anyEngine.loadedSamples, durations: anyEngine.sampleDurations };
}

describe('collectWorkletSamples contra un AudioEngine real', () => {
  it('el motor real dice que SÍ sabe olvidar, y recibe el collectSamples', () => {
    const engine = new AudioEngine();
    const send = vi.spyOn(engine, 'send');

    const result = collectWorkletSamples(engine, project());

    expect(result.sent).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [msg] = send.mock.calls[0]!;
    expect(msg).toEqual({ type: 'collectSamples', keep: result.keep });
  });

  it('vacía de verdad la caché de decodificado del motor (no una copia de su comportamiento)', () => {
    const engine = new AudioEngine();
    const { loaded, durations } = cachesOf(engine);
    loaded.add('usado');
    loaded.add('huerfano');
    durations.set('usado', 1.5);
    durations.set('huerfano', 2);

    collectWorkletSamples(engine, project());

    expect(loaded.has('usado')).toBe(true);
    expect(loaded.has('huerfano')).toBe(false);
    expect(durations.has('usado')).toBe(true);
    expect(durations.has('huerfano')).toBe(false);
  });
});

describe('rehydrateSamples() llama de verdad a collectWorkletSamples (no en teoría)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('manda collectSamples al motor de la app tras rehidratar (proyecto sin samples)', async () => {
    vi.resetModules();
    // Sin `window.orbit`: `readSampleBytes` devuelve null y todo cuenta como
    // "no disponible en esta máquina" en vez de reventar — de sobra para
    // probar la LLAMADA, que es lo que aquí importa (leer bytes de disco ya
    // lo prueba `sound-actions` por su lado).
    vi.stubGlobal('window', {});

    const { engine, store } = await import('../src/state/app');
    const soundActions = await import('../src/browser/sound-actions');
    const send = vi.spyOn(engine, 'send');

    expect(Object.keys(store.project.samples)).toHaveLength(0);
    const missing = await soundActions.rehydrateSamples();

    expect(missing).toEqual([]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'collectSamples' }));
  });

  it('manda collectSamples con la lista real cuando el proyecto SÍ tiene samples registrados', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});

    const core = await import('@orbit/core');
    const { engine, store } = await import('../src/state/app');
    const soundActions = await import('../src/browser/sound-actions');
    const send = vi.spyOn(engine, 'send');

    const channel = core.createChannel('sampler', 0, 'Uno');
    store.dispatch({ type: 'addChannel', channel });
    store.dispatch({ type: 'registerSample', sample: ref('reg-1') });
    store.dispatch({ type: 'patchChannel', channelId: channel.id, patch: { sampleId: 'reg-1' } });

    const missing = await soundActions.rehydrateSamples();

    // Sin `window.orbit`, 'reg-1' no se pudo leer de disco en este test: cuenta
    // como "no disponible", pero eso no cambia que la recolección se dispare.
    expect(missing.map((m) => m.id)).toEqual(['reg-1']);
    const collectCalls = send.mock.calls.filter(([msg]) => msg.type === 'collectSamples');
    expect(collectCalls).toHaveLength(1);
    const [msg] = collectCalls[0]!;
    expect(msg.type === 'collectSamples' && msg.keep).toContain('reg-1');
  });
});
