/**
 * Preview del Browser: dos clics seguidos no pueden sonar el primero.
 *
 * `previewSound()` espera a leer y decodificar el archivo antes
 * de llamar a `engine.previewSample`. Con dos clics rápidos, la carga del
 * PRIMERO puede terminar después de la del segundo (más lenta por lo que sea),
 * y entonces su `previewSample` pisa el sonido del que el usuario acaba de
 * pulsar. `browser/analysis-queue.ts` y `collab/sample-sync.ts` ya resuelven
 * carreras así con un contador de generación; aquí el token es lo mínimo.
 *
 * El flujo async se prueba en browser-preview-session.test.ts. Aquí se fija
 * la secuencia y el cableado inseparable de los gestos/efectos de React.
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
    seq.invalidate();
    expect(seq.isCurrent(c)).toBe(false);
    const d = seq.begin();
    expect(seq.isCurrent(c)).toBe(false);
    expect(seq.isCurrent(d)).toBe(true);
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
  it('delega audio con el token vigente y guarda indicador, timer y errores', () => {
    const src = readSource('browser/Browser.tsx');
    const body = src.slice(src.indexOf('const preview = async ('), src.indexOf('const addToProject = async ('));
    expect(body).toContain('const seq = previewSeq.current!.begin()');
    expect(body).toContain('const isCurrent = () => previewSeq.current!.isCurrent(seq)');
    expect(body).toContain('await previewSound(entry, (entry.gainSuggestion ?? 0.9) * previewGain, isCurrent)');
    const guardAt = body.indexOf('if (!played || !isCurrent()) return');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(body.indexOf('setPlayingId(entry.id)'));
    expect(body).toContain('() => { if (isCurrent()) setPlayingId(null); }');
    expect(body.slice(body.indexOf('catch (err)'))).toContain('if (!isCurrent()) return');
    expect(body).not.toContain('engine.previewSample');
    expect(body).not.toContain('ensureAudioReady()');
  });

  it('invalida al reemplazar y desmontar, y da de baja listener y timer', () => {
    const src = readSource('browser/Browser.tsx');
    const at = src.indexOf('const sequence = previewSeq.current!');
    const effect = src.slice(at, src.indexOf('}, []);', at));
    expect(effect).toContain('sequence.invalidate()');
    expect(effect).toContain('window.clearTimeout(previewTimer.current)');
    expect(effect).toMatch(/store\.subscribeBeforeReplace\(\(\) => \{\s*invalidate\(\)/);
    expect(effect).toMatch(/return \(\) => \{\s*invalidate\(\);\s*unsubscribe\(\)/);
  });
});
