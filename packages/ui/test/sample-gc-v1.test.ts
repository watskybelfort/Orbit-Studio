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

/**
 * La sujeción es un CONTADOR de referencias, no un `Set`.
 *
 * Con un `Set`, la primera operación en terminar borraba la entrada y la
 * segunda se quedaba con su audio a la intemperie. El primer test de aquí es
 * exactamente esa carrera, con dos operaciones de verdad solapadas (cada una
 * termina cuando su compuerta se abre, no al azar): contra la implementación
 * con `Set` falla en la aserción de «sigue sujeto tras terminar la primera»,
 * que es el síntoma —el audio vivo para la segunda— y no el mecanismo.
 */
describe('la sujeción es un contador de referencias', () => {
  /** Compuerta que una operación espera antes de terminar. */
  function compuerta(): { abrir: () => void; lista: Promise<void> } {
    let abrir!: () => void;
    const lista = new Promise<void>((resolve) => {
      abrir = resolve;
    });
    return { abrir, lista };
  }

  it('dos operaciones sobre el mismo id: la primera en terminar no se lleva el audio de la segunda', async () => {
    const engine = fakeEngine(true);
    const a = compuerta();
    const b = compuerta();

    const primera = withPinnedSample('compartido', async () => {
      await a.lista;
    });
    const segunda = withPinnedSample('compartido', async () => {
      await b.lista;
    });

    // Las dos sujetan ya: una sola entrada, dos referencias.
    expect(pinnedSamples()).toEqual(['compartido']);

    a.abrir();
    await primera;
    // La primera terminó y soltó SU referencia. Con un `Set` aquí ya no queda
    // nada sujeto, y la segunda operación —que sigue en vuelo— perdería el
    // audio justo en su ventana vulnerable.
    expect(pinnedSamples()).toEqual(['compartido']);
    expect(collectWorkletSamples(engine, project()).keep).toContain('compartido');

    b.abrir();
    await segunda;
    expect(pinnedSamples()).toEqual([]);
  });

  it('el mismo id anidado pide dos soltados: el inner no deja a la outer en la intemperie', async () => {
    await withPinnedSample('anidado', async () => {
      await withPinnedSample('anidado', async () => {
        /* la operación interna termina primero */
      });
      expect(pinnedSamples()).toEqual(['anidado']);
    });
    expect(pinnedSamples()).toEqual([]);
  });

  it('unpinSample de un id que no está sujeto es un no-op: el contador nunca baja de cero', () => {
    unpinSample('nunca-sujeto');
    pinSample('una-vez');
    unpinSample('una-vez');
    unpinSample('una-vez'); // de más: el bug simétrico
    expect(pinnedSamples()).toEqual([]);
    // Con contador en negativo este pin lo dejaría en 0 y el id NO aparecería
    // sujeto: el suelo en cero es el que decide que sueltes de más no roben
    // referencias de pins futuros.
    pinSample('una-vez');
    expect(pinnedSamples()).toEqual(['una-vez']);
    unpinSample('una-vez');
    expect(pinnedSamples()).toEqual([]);
  });
});
