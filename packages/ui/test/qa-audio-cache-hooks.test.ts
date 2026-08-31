/**
 * `uiAudioCacheStats()` (`state/sample-gc.ts`) y su hermana `renderSampleCacheStats()`
 * (`export/render-inputs.ts`) medían de verdad, pero no las llamaba nadie en `src`
 * y ninguna de las dos estaba colgada de `window`: la instrucción de una tarjeta
 * anterior — «`renderSampleCacheStats()` en la consola del renderer sigue
 * devolviendo las entradas de A» — describía un comando que no se podía teclear.
 * Solo se alcanzaban importando el módulo, o sea desde un test.
 *
 * Este test prueba justo eso: que ahora SÍ se alcanzan desde `window`, en el
 * mismo bloque de ganchos de QA solo-dev de `state/app.ts` que ya publicaba
 * `__orbitStore` / `__orbitUi` / `__orbitEngine`. No repite lo que ya prueban
 * `audio-cache-policy.test.ts` (que la memoria vuelve) ni los tests de
 * `sample-peaks.ts`/`render-inputs.ts` (que cada caché mide bien) — solo que el
 * camino de consola-a-función es el MISMO binding que exporta cada módulo, no
 * una copia ni una re-implementación.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * El stub mínimo con el que `run-export.test.ts` ya importa `state/app.ts` de
 * verdad (incluido `export/render-inputs.ts`, que tira de `state/plugins.ts` y
 * `browser/sound-actions.ts`): ninguno de esos módulos toca `window.orbit` al
 * cargarse, solo dentro de funciones que este test no llega a invocar.
 */
function stubWindow(): void {
  vi.stubGlobal('window', {
    orbit: {
      file: { write: async () => {}, saveDialog: async () => null },
      settings: { get: async () => ({}), set: async (p: unknown) => p },
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('window.__orbitAudioCacheStats (ganchos de QA solo-dev)', () => {
  it('cuelga de window al cargar state/app.ts, con los mismos bindings que exportan los módulos', async () => {
    stubWindow();

    await import('../src/state/app');
    const gc = await import('../src/state/sample-gc');
    const peaks = await import('../src/state/sample-peaks');
    const renderInputs = await import('../src/export/render-inputs');

    const w = window as unknown as Record<string, unknown>;
    const hooks = w['__orbitAudioCacheStats'] as
      | {
          all: typeof gc.uiAudioCacheStats;
          render: typeof renderInputs.renderSampleCacheStats;
          peaks: typeof peaks.peaksCacheStats;
          pinnedSamples: typeof gc.pinnedSamples;
          peaksListeners: typeof peaks.peaksListenerCount;
        }
      | undefined;

    expect(hooks).toBeDefined();
    // Misma función, no una envoltura: es lo que hace que llamarla desde CDP
    // sea EXACTAMENTE lo que promete cada docblock, no una aproximación.
    expect(hooks!.all).toBe(gc.uiAudioCacheStats);
    expect(hooks!.render).toBe(renderInputs.renderSampleCacheStats);
    expect(hooks!.peaks).toBe(peaks.peaksCacheStats);
    expect(hooks!.pinnedSamples).toBe(gc.pinnedSamples);
    expect(hooks!.peaksListeners).toBe(peaks.peaksListenerCount);
  });

  it('all() trae el desglose por caché (render/peaks/editor) que antes solo veía un test', async () => {
    stubWindow();
    await import('../src/state/app');

    const w = window as unknown as Record<string, unknown>;
    const hooks = w['__orbitAudioCacheStats'] as { all: () => { entries: number; bytes: number; caches: unknown[] } };

    const result = hooks.all();
    expect(result).toEqual({ entries: expect.any(Number), bytes: expect.any(Number), caches: expect.any(Array) });
    // render-inputs.ts y sample-peaks.ts ya se cargaron (los importa state/app.ts
    // para exponer este mismo gancho), así que sus cachés ya se autoinscribieron.
    const names = (result.caches as { name: string }[]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['render', 'peaks']));
  });

  it('en régimen no hay nada sujeto ni suscriptores de picos (recién cargado, sin editor abierto)', async () => {
    stubWindow();
    await import('../src/state/app');

    const w = window as unknown as Record<string, unknown>;
    const hooks = w['__orbitAudioCacheStats'] as {
      pinnedSamples: () => string[];
      peaksListeners: () => number;
    };

    expect(hooks.pinnedSamples()).toEqual([]);
    expect(hooks.peaksListeners()).toBe(0);
  });
});
