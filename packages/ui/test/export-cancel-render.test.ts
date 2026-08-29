/**
 * Contrato de cancelación del render offline (`RenderOptions.isCancelled`,
 * `RenderCancelledError`) en `@orbit/engine` directo — la pieza "checkpoint
 * DENTRO del render", no solo entre lotes de stems. Complementa a
 * `export-cancel-run-export.test.ts` (que prueba `run-export.ts` orquestando
 * todo esto) probando el motor en sí, sin pasar por él.
 *
 * Por qué hace falta esto además del checkpoint "entre lotes" (fácil, ya
 * existía en la forma del `for` de `renderStems`/`run-export.ts`): un solo
 * stem de una canción larga ya tarda por sí solo, así que sin un punto de
 * comprobación DENTRO de `renderProject` cancelar solo podría cortar entre
 * pistas — el usuario seguiría esperando esa pista entera igual. El coste de
 * ese checkpoint (medido: ~170 comprobaciones en 30 s de render, delta
 * indistinguible del ruido de medición, <4 %) está en el informe del
 * subagente que lo añadió, no en un test — no hay forma barata de afirmar un
 * número de rendimiento con `expect()` sin que sea un test inestable.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '@orbit/core';
import { compileProject, renderProject, renderStems, RenderCancelledError } from '@orbit/engine';
import type { CompiledProject } from '@orbit/engine';

/**
 * Proyecto vacío compilado (sin canales): basta para ejercer el bucle del
 * render offline —que llama a `core.process()` igual, en silencio— sin
 * depender de la forma exacta de una nota o un clip real.
 */
function compiledEmptyProject(): CompiledProject {
  return compileProject(createEmptyProject('cancelación (test)'), { mode: 'song' });
}

describe('renderProject: isCancelled corta el render en marcha', () => {
  it('lanza RenderCancelledError y NO llega al onProgress(1) de cierre incondicional', () => {
    const compiled = compiledEmptyProject();
    const progressCalls: number[] = [];
    let checks = 0;

    expect(() =>
      renderProject(compiled, {
        tailSeconds: 5, // largo: cruza varios checkpoints (cada ~8192 muestras, ~186 ms)
        onProgress: (f) => progressCalls.push(f),
        isCancelled: () => {
          checks++;
          return checks >= 2; // deja pasar el primer checkpoint, corta en el segundo
        },
      }),
    ).toThrow(RenderCancelledError);

    // El `opts.onProgress?.(1)` de cierre vive DESPUÉS del bucle, en la rama
    // que solo se alcanza si el bucle termina SOLO. Si esto llegara a
    // llamarse en un render cancelado, `trackStemProgress`
    // (packages/ui/src/export/stem-progress.ts) confundiría "cancelado" con
    // "pista cerrada" y correría la numeración de la pista siguiente.
    expect(progressCalls.includes(1)).toBe(false);
    expect(checks).toBeGreaterThanOrEqual(2);
  });

  it('isCancelled que nunca corta no cambia el render: mismo resultado que sin pasarlo', () => {
    const compiled = compiledEmptyProject();
    const withFlag = renderProject(compiled, { tailSeconds: 0.05, isCancelled: () => false });
    const without = renderProject(compiled, { tailSeconds: 0.05 });
    expect(withFlag.left.length).toBe(without.left.length);
    expect(Array.from(withFlag.left)).toEqual(Array.from(without.left));
    expect(Array.from(withFlag.right)).toEqual(Array.from(without.right));
  });
});

describe('renderStems: cortar a mitad de un lote conserva lo ya renderizado', () => {
  it('isCancelled ya true desde el principio: ninguna pista se renderiza, y ninguna cuenta como error', () => {
    const compiled = compiledEmptyProject();
    const { results, errors } = renderStems(compiled, [0, 1, 2], {
      tailSeconds: 0.02,
      isCancelled: () => true,
    });
    expect(results.size).toBe(0);
    expect(errors.size).toBe(0);
  });

  it('se cancela DESPUÉS de la primera pista: la primera se conserva, las siguientes ni se piden', () => {
    const compiled = compiledEmptyProject();
    let checkedTracks = 0;
    const { results, errors } = renderStems(compiled, [0, 1, 2], {
      // `endBeat` casi cero + cola casi cero: el render de CADA pista queda
      // muy por debajo de las 8192 muestras del checkpoint interno de
      // `renderProject` (ver el test de arriba), así que la ÚNICA llamada a
      // `isCancelled` por pista es el check "antes de cada pista" que hace
      // `renderStems` — aísla justo ese mecanismo, sin que el checkpoint
      // interno se cuele y lo confunda con "a mitad de pista" (ver el test de
      // abajo, que sí lo fuerza a propósito).
      endBeat: 0.01,
      tailSeconds: 0.02,
      isCancelled: () => {
        checkedTracks++;
        return checkedTracks > 1; // dejar arrancar la pista 0, cortar antes de la 1
      },
    });
    expect([...results.keys()]).toEqual([0]);
    // Las pistas 1 y 2 faltan porque nunca se pidieron, no porque fallaran:
    // no deben aparecer como error (eso sería mentir sobre el motivo).
    expect(errors.size).toBe(0);
  });

  it('se cancela A MITAD del render de una pista (no solo entre pistas): esa pista no queda ni en results ni en errors', () => {
    const compiled = compiledEmptyProject();
    let checks = 0;
    const { results, errors } = renderStems(compiled, [0, 1, 2], {
      tailSeconds: 5, // largo: garantiza cruzar el checkpoint DENTRO del render de la pista 0
      isCancelled: () => {
        checks++;
        // false las primeras veces (deja arrancar la pista 0 y avanzar varios
        // checkpoints DENTRO de su propio render), true después: corta a
        // mitad de la pista 0 misma, antes de que renderProject la cierre.
        return checks > 3;
      },
    });
    expect(results.size).toBe(0);
    expect(errors.size).toBe(0);
  });

  it('sin isCancelled (el caso normal, bounce/consolidar): renderStems no comprueba nada y funciona igual que siempre', () => {
    const compiled = compiledEmptyProject();
    const { results, errors } = renderStems(compiled, [0, 1], { tailSeconds: 0.02 });
    expect([...results.keys()].sort()).toEqual([0, 1]);
    expect(errors.size).toBe(0);
  });
});
