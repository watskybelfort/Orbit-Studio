/**
 * `trackStemProgress` es lo que traduce el `onProgress(fraction)` de
 * `renderStems` —reiniciado a 0 en cada pista, cerrado siempre con un 1— en
 * "empezó a renderizar la pista i". Es la pieza que permite mandar TODOS los
 * stems en una sola petición al worker y aun así avisar stem a stem, en vez
 * de una barra quieta hasta que vuelve todo junto.
 *
 * Se prueba aparte del worker porque render-worker.ts referencia `self` al
 * cargar el módulo y no se puede importar en Node/vitest.
 */
import { describe, expect, it } from 'vitest';
import { trackStemProgress } from '../src/export/stem-progress';

describe('trackStemProgress', () => {
  it('avisa el índice 0 en el primer progreso, aunque no sea 1', () => {
    const started: number[] = [];
    const onProgress = trackStemProgress(3, (i) => started.push(i));
    onProgress(0.01);
    expect(started).toEqual([0]);
  });

  it('una pista con varios ticks intermedios solo avisa UNA vez su inicio', () => {
    const started: number[] = [];
    const onProgress = trackStemProgress(2, (i) => started.push(i));
    onProgress(0.1);
    onProgress(0.4);
    onProgress(0.8);
    onProgress(1); // cierra la pista 0
    expect(started).toEqual([0]);
  });

  it('el cierre de una pista (fraction 1) deja lista la siguiente', () => {
    const started: number[] = [];
    const onProgress = trackStemProgress(3, (i) => started.push(i));
    onProgress(0.5);
    onProgress(1); // pista 0 → cerrada
    onProgress(0.2); // pista 1 → arranca
    onProgress(1); // pista 1 → cerrada
    onProgress(1); // pista 2 → arranca y cierra en la misma llamada
    expect(started).toEqual([0, 1, 2]);
  });

  it('pistas que no dan ningún tick intermedio (solo el 1 final) igual cuentan en orden', () => {
    // Un stem muy corto puede no cruzar nunca el umbral de progreso interno
    // del render y llegar directo al onProgress(1) de cierre.
    const started: number[] = [];
    const onProgress = trackStemProgress(4, (i) => started.push(i));
    onProgress(1);
    onProgress(1);
    onProgress(1);
    onProgress(1);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it('nunca avisa un índice fuera de rango aunque lleguen más cierres que pistas', () => {
    // De más no debería llegar (el worker manda exactamente `total` cierres),
    // pero si llegara, el índice se queda pegado al último válido en vez de
    // salirse del array de `stemTracks` en run-export.ts.
    const started: number[] = [];
    const onProgress = trackStemProgress(2, (i) => started.push(i));
    onProgress(1);
    onProgress(1);
    onProgress(1); // de más: no hay pista 2
    expect(started).toEqual([0, 1, 1]);
    expect(Math.max(...started)).toBeLessThan(2);
  });
});
