/**
 * La recolección de samples del worklet, por el lado de la UI.
 *
 * Lo que se prueba aquí es sobre todo lo que NO tiene que pasar: que no se
 * mande la orden si el motor no puede vaciar su caché de decodificado (eso
 * dejaría samplers mudos), y que un sample en vuelo —un bounce a medio hacer—
 * no se caiga de la lista aunque el proyecto todavía no lo conozca.
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  type Project,
  type SampleRef,
} from '@orbit/core';
import type { ToKernel } from '@orbit/engine';
import {
  collectWorkletSamples,
  pinSample,
  pinnedSamples,
  unpinSample,
  withPinnedSample,
} from '../src/state/sample-gc';

function ref(id: string): SampleRef {
  return { id, name: id, path: `qa:${id}`, hash: id, duration: 1 };
}

/** Proyecto con un sampler que usa 'usado' y un registrado que no usa nadie. */
function project(): Project {
  const p = createEmptyProject('GC');
  const channel = createChannel('sampler', 0, 'Uno');
  applyCommand(p, { type: 'addChannel', channel });
  applyCommand(p, { type: 'registerSample', sample: ref('usado') });
  applyCommand(p, { type: 'registerSample', sample: ref('suelto') });
  applyCommand(p, {
    type: 'patchChannel',
    channelId: channel.id,
    patch: { sampleId: 'usado' },
  });
  return p;
}

function fakeEngine(withForget: boolean) {
  const sent: ToKernel[] = [];
  const forgotten: string[][] = [];
  return {
    sent,
    forgotten,
    send: (msg: ToKernel) => void sent.push(msg),
    ...(withForget
      ? { keepOnlySamples: (keep: readonly string[]) => void forgotten.push([...keep]) }
      : null),
  };
}

describe('collectWorkletSamples', () => {
  it('no manda nada si el motor no sabe olvidar su caché', () => {
    const engine = fakeEngine(false);
    const result = collectWorkletSamples(engine, project());
    expect(result.sent).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(engine.sent).toHaveLength(0);
  });

  it('manda la lista de los que se quedan, y el motor olvida la misma', () => {
    const engine = fakeEngine(true);
    const result = collectWorkletSamples(engine, project());

    expect(result.sent).toBe(true);
    expect(result.keep).toEqual(expect.arrayContaining(['usado', 'suelto']));
    expect(engine.sent).toHaveLength(1);
    const msg = engine.sent[0]!;
    expect(msg.type).toBe('collectSamples');
    expect(msg.type === 'collectSamples' && msg.keep).toEqual(result.keep);
    // La caché del motor y el mapa del kernel se quedan diciendo lo mismo.
    expect(engine.forgotten[0]).toEqual(result.keep);
  });

  it('sin `keepRegistered` suelta lo registrado que no usa nadie', () => {
    const engine = fakeEngine(true);
    const result = collectWorkletSamples(engine, project(), { keepRegistered: false });
    expect(result.keep).toContain('usado');
    expect(result.keep).not.toContain('suelto');
  });

  it('un sample en vuelo (pin) no se cae de la lista', () => {
    const engine = fakeEngine(true);
    pinSample('bounce-en-vuelo');
    try {
      expect(collectWorkletSamples(engine, project()).keep).toContain('bounce-en-vuelo');
    } finally {
      unpinSample('bounce-en-vuelo');
    }
    expect(collectWorkletSamples(engine, project()).keep).not.toContain('bounce-en-vuelo');
  });

  it('withPinnedSample suelta el pin aunque la operación reviente', async () => {
    await expect(
      withPinnedSample('roto', async () => {
        expect(pinnedSamples()).toContain('roto');
        throw new Error('el render falló');
      }),
    ).rejects.toThrow('el render falló');
    expect(pinnedSamples()).not.toContain('roto');
  });
});
