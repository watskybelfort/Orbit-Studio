/**
 * Transponer con "Afinar" no puede cambiar la duración de la toma.
 *
 * El PSOLA avanzaba el origen un periodo entero mientras el destino avanzaba
 * `periodo/ratio`, así que la salida duraba `duración/ratio`: subir una octava
 * dejaba la mitad final en silencio y bajarla estiraba la toma. Y la
 * transposición entraba DENTRO del interpolado de fuerza, así que con la fuerza
 * a la mitad transponía la mitad de los semitonos pedidos.
 */

import { describe, expect, it } from 'vitest';
import { correctPitch } from '../src/render/pitch';

const SR = 44100;
const SECONDS = 1;

/** Un segundo de seno con algo de armónico (para que el detector agarre). */
function note(hz: number): Float32Array {
  const n = SR * SECONDS;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = 0.6 * Math.sin(2 * Math.PI * hz * t) + 0.2 * Math.sin(4 * Math.PI * hz * t);
  }
  return out;
}

/** Último instante con señal audible (para medir cuánto dura de verdad). */
function endSeconds(xs: Float32Array): number {
  for (let i = xs.length - 1; i >= 0; i--) {
    if (Math.abs(xs[i]!) > 0.02) return (i + 1) / SR;
  }
  return 0;
}

/** Frecuencia dominante por cruces por cero en la parte estable. */
function estimateHz(xs: Float32Array): number {
  const from = Math.round(0.2 * SR);
  const to = Math.round(0.8 * SR);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) {
    if (xs[i - 1]! <= 0 && xs[i]! > 0) crossings++;
  }
  return (crossings * SR) / (to - from);
}

describe('correctPitch: transponer', () => {
  it('sin transponer, la toma dura lo mismo', () => {
    const src = note(220);
    const out = correctPitch(src, src, SR, { transpose: 0 });
    expect(endSeconds(out.left)).toBeGreaterThan(0.95);
  });

  it('una octava arriba NO se come la mitad de la toma', () => {
    const src = note(220);
    const out = correctPitch(src, src, SR, { transpose: 12 });
    // Antes acababa en 0,508 s.
    expect(endSeconds(out.left)).toBeGreaterThan(0.95);
  });

  it('una octava abajo tampoco la estira', () => {
    const src = note(220);
    const out = correctPitch(src, src, SR, { transpose: -12 });
    // Antes acababa en 1,521 s (más larga que el buffer de entrada).
    expect(endSeconds(out.left)).toBeGreaterThan(0.95);
    expect(endSeconds(out.left)).toBeLessThanOrEqual(SECONDS + 1e-6);
  });

  it('una octava arriba suena una octava arriba', () => {
    const src = note(220);
    const out = correctPitch(src, src, SR, { transpose: 12 });
    const hz = estimateHz(out.left);
    expect(hz).toBeGreaterThan(400);
    expect(hz).toBeLessThan(480);
  });

  it('la fuerza de afinación no recorta la transposición', () => {
    const src = note(220);
    const entera = estimateHz(correctPitch(src, src, SR, { transpose: 12, strength: 1 }).left);
    const media = estimateHz(correctPitch(src, src, SR, { transpose: 12, strength: 0.5 }).left);
    const nada = estimateHz(correctPitch(src, src, SR, { transpose: 12, strength: 0 }).left);
    // Antes: 441 / 310 / 220 Hz. La transposición es un traslado pedido a mano.
    expect(Math.abs(media - entera)).toBeLessThan(40);
    expect(Math.abs(nada - entera)).toBeLessThan(40);
  });
});
