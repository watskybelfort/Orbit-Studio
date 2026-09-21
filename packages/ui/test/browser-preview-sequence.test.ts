/**
 * Preview del Browser: dos clics seguidos no pueden sonar el primero.
 *
 * `preview()` espera a `loadIntoEngine` (leer y decodificar el archivo) antes
 * de llamar a `engine.previewSample`. Con dos clics rápidos, la carga del
 * PRIMERO puede terminar después de la del segundo (más lenta por lo que sea),
 * y entonces su `previewSample` pisa el sonido del que el usuario acaba de
 * pulsar. `browser/analysis-queue.ts` y `collab/sample-sync.ts` ya resuelven
 * carreras así con un contador de generación; aquí el token es lo mínimo.
 *
 * El test fija la secuencia en el módulo puro y, con `read-source`, que
 * Browser.tsx comprueba el token DESPUÉS del `await` y ANTES de sonar.
 */

import { describe, expect, it } from 'vitest';
import { createPreviewSequence } from '../src/browser/preview-sequence';
import { readSource } from './read-source';

describe('createPreviewSequence', () => {
  it('solo la última carga arrancada sigue siendo la actual', () => {
    const seq = createPreviewSequence();
    const a = seq.begin();
    expect(seq.isCurrent(a)).toBe(true);
    const b = seq.begin();
    expect(seq.isCurrent(a)).toBe(false);
    expect(seq.isCurrent(b)).toBe(true);
    const c = seq.begin();
    expect(seq.isCurrent(b)).toBe(false);
    expect(seq.isCurrent(c)).toBe(true);
  });

  it('el token viejo nunca revive, aunque se pregunte muchas veces', () => {
    const seq = createPreviewSequence();
    const viejo = seq.begin();
    seq.begin();
    seq.begin();
    expect(seq.isCurrent(viejo)).toBe(false);
    expect(seq.isCurrent(viejo - 1)).toBe(false);
    expect(seq.isCurrent(0)).toBe(false);
  });
});

describe('Browser.preview descarta las cargas viejas', () => {
  it('comprueba el token entre el await y el previewSample', () => {
    const src = readSource('browser/Browser.tsx');
    const at = src.indexOf('const preview = async (');
    expect(at).toBeGreaterThanOrEqual(0);
    const awaitAt = src.indexOf('await loadIntoEngine(entry)', at);
    const guardAt = src.indexOf('isCurrent(', awaitAt);
    const playAt = src.indexOf('engine.previewSample(entry.id', awaitAt);
    const beginAt = src.indexOf('.begin()', at);

    expect(beginAt).toBeGreaterThan(at);
    expect(beginAt).toBeLessThan(awaitAt);
    expect(awaitAt).toBeGreaterThan(at);
    expect(guardAt).toBeGreaterThan(awaitAt);
    expect(guardAt).toBeLessThan(playAt);
  });
});
