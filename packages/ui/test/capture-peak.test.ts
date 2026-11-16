import { describe, expect, it } from 'vitest';
import {
  isClipped,
  peakOf,
  TAKE_CLIP_THRESHOLD,
  takeClipWarning,
} from '../src/state/capture-peak';

describe('peakOf', () => {
  it('mide el máximo absoluto de los dos canales', () => {
    expect(peakOf(new Float32Array([0.1, -0.5, 0.2]), new Float32Array([0.3, 0.1]))).toBeCloseTo(0.5);
  });

  it('un canal más alto manda, aunque el otro sea el que tiene el signo', () => {
    expect(peakOf(new Float32Array([0.01]), new Float32Array([-0.9]))).toBeCloseTo(0.9);
  });

  it('sin muestras o con NaN devuelve 0, no NaN', () => {
    expect(peakOf(new Float32Array([]))).toBe(0);
    expect(peakOf(new Float32Array([NaN, 0.2]))).toBeCloseTo(0.2);
  });
});

describe('isClipped', () => {
  it('el umbral deja fuera un pico que solo roza 1', () => {
    expect(isClipped(TAKE_CLIP_THRESHOLD - 1e-6)).toBe(false);
    expect(isClipped(TAKE_CLIP_THRESHOLD)).toBe(true);
    expect(isClipped(1)).toBe(true);
  });

  it('NaN no se anuncia como clipping', () => {
    expect(isClipped(NaN)).toBe(false);
  });
});

describe('takeClipWarning', () => {
  it('sin tomas recortadas no hay aviso', () => {
    expect(takeClipWarning([{ name: 'Voz', peak: 0.5 }])).toBeNull();
  });

  it('nombra la toma recortada, y solo esa', () => {
    const text = takeClipWarning([
      { name: 'Voz', peak: 1 },
      { name: 'Guitarra', peak: 0.6 },
    ]);
    expect(text).toContain('«Voz»');
    expect(text).not.toContain('Guitarra');
    expect(text).toContain('ganancia del aparato');
  });

  it('con dos recortadas las nombra a las dos', () => {
    const text = takeClipWarning([
      { name: 'Voz', peak: 1 },
      { name: 'Guitarra', peak: 0.999 },
    ]);
    expect(text).toContain('«Voz»');
    expect(text).toContain('«Guitarra»');
  });
});
