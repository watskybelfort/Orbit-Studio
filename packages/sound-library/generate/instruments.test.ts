/**
 * Tests del módulo de instrumentos con altura (instruments.ts): metadatos del
 * catálogo, renders sin NaN, nivel sano, duración en rango, bordes sin click,
 * determinismo bit a bit y reglas de estéreo (bajos en mono).
 */

import { describe, expect, it } from 'vitest';
import { INSTRUMENTS } from './instruments';

const SR = 44100;

const SUBCATEGORIAS = ['teclas', 'cuerdas', 'bajos', 'leads', 'pads', 'campanas'];

function pico(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]!);
    if (v > p) p = v;
  }
  return p;
}

function hayNoFinito(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]!)) return true;
  }
  return false;
}

/** Índice de la primera muestra distinta; -1 si son idénticos bit a bit. */
function primeraDiferencia(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -1;
}

describe('catálogo INSTRUMENTS', () => {
  it('tiene 24+ specs con slugs únicos y metadatos válidos', () => {
    expect(INSTRUMENTS.length).toBeGreaterThanOrEqual(24);
    const slugs = new Set(INSTRUMENTS.map((s) => s.slug));
    expect(slugs.size).toBe(INSTRUMENTS.length);
    for (const s of INSTRUMENTS) {
      expect(s.name.length).toBeGreaterThan(0);
      expect(SUBCATEGORIAS).toContain(s.subcategory);
      expect(s.tags.length).toBeGreaterThan(0);
      expect(s.keyRoot).toBe('C');
      expect(s.rootHz).toBeGreaterThan(30);
      expect(s.rootHz).toBeLessThan(1000);
      expect(s.gainSuggestion).toBeGreaterThanOrEqual(0.5);
      expect(s.gainSuggestion).toBeLessThanOrEqual(1);
    }
  });

  it('cubre todas las familias pedidas', () => {
    const porSub = new Map<string, number>();
    for (const s of INSTRUMENTS) {
      porSub.set(s.subcategory, (porSub.get(s.subcategory) ?? 0) + 1);
    }
    expect(porSub.get('teclas') ?? 0).toBeGreaterThanOrEqual(7); // pianos + EPs + órganos
    expect(porSub.get('cuerdas') ?? 0).toBeGreaterThanOrEqual(4);
    expect(porSub.get('bajos') ?? 0).toBeGreaterThanOrEqual(4);
    expect(porSub.get('pads') ?? 0).toBeGreaterThanOrEqual(3);
    expect(porSub.get('campanas') ?? 0).toBeGreaterThanOrEqual(3);
    expect(porSub.get('leads') ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('los bajos son mono (regla de low-end mono del repo)', () => {
    const bajos = INSTRUMENTS.filter((s) => s.subcategory === 'bajos');
    expect(bajos.length).toBeGreaterThanOrEqual(4);
    for (const s of bajos) {
      const { left, right } = s.render(SR);
      expect(primeraDiferencia(left, right)).toBe(-1);
    }
  });

  it('los pads son estéreo real (L y R difieren)', () => {
    const pads = INSTRUMENTS.filter((s) => s.subcategory === 'pads');
    for (const s of pads) {
      const { left, right } = s.render(SR);
      expect(primeraDiferencia(left, right)).toBeGreaterThanOrEqual(0);
    }
  });
});

for (const s of INSTRUMENTS) {
  describe(s.slug, () => {
    it('render limpio, en rango y determinista', () => {
      const a = s.render(SR);
      // Forma: canales de igual longitud y duración 1.5–4 s.
      expect(a.left.length).toBe(a.right.length);
      const dur = a.left.length / SR;
      expect(dur).toBeGreaterThanOrEqual(1.5);
      expect(dur).toBeLessThanOrEqual(4);
      // Sin NaN/Infinity.
      expect(hayNoFinito(a.left)).toBe(false);
      expect(hayNoFinito(a.right)).toBe(false);
      // Pico interno sano (el módulo apunta a ~0.9).
      const p = Math.max(pico(a.left), pico(a.right));
      expect(p).toBeGreaterThanOrEqual(0.2);
      expect(p).toBeLessThanOrEqual(1.0);
      // Bordes sin click: fades aplicados en ambos extremos.
      expect(Math.abs(a.left[0]!)).toBeLessThan(0.02);
      expect(Math.abs(a.right[0]!)).toBeLessThan(0.02);
      expect(Math.abs(a.left[a.left.length - 1]!)).toBeLessThan(0.02);
      expect(Math.abs(a.right[a.right.length - 1]!)).toBeLessThan(0.02);
      // Determinismo: dos llamadas son idénticas bit a bit.
      const b = s.render(SR);
      expect(primeraDiferencia(a.left, b.left)).toBe(-1);
      expect(primeraDiferencia(a.right, b.right)).toBe(-1);
    });
  });
}
