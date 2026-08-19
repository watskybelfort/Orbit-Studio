/**
 * El chorus tiene que salir centrado.
 *
 * Repartía las voces alternando izquierda/derecha (`v % 2`) pero normalizaba
 * las dos por igual, así que con un número IMPAR de voces la izquierda recibía
 * un tap más. Con 3 —el valor por defecto del efecto— la imagen se iba 2,35 dB
 * a la izquierda: el chorus de fábrica descentraba la mezcla.
 */

import { describe, expect, it } from 'vitest';
import { createEffect } from '../src/dsp/effects';

const SR = 44100;

/** Ruido determinista (nada de Math.random: el test tiene que repetirse). */
function noise(n: number): Float32Array {
  const out = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x3fffffff - 1) * 0.5;
  }
  return out;
}

function rms(xs: Float32Array): number {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, xs.length));
}

/** Desequilibrio L/R en dB con una entrada mono idéntica en los dos canales. */
function balanceDb(voices: number): number {
  const n = SR;
  const src = noise(n);
  const l = src.slice();
  const r = src.slice();
  const fx = createEffect('chorus', SR);
  fx.setParams({ rate: 0.8, depth: 0.5, voices });
  const block = 128;
  for (let i = 0; i < n; i += block) {
    const size = Math.min(block, n - i);
    fx.process(l.subarray(i, i + size), r.subarray(i, i + size), size, null, null);
  }
  // Se descarta el arranque (las líneas de retardo aún se están llenando).
  const from = Math.round(0.2 * SR);
  return 20 * Math.log10(rms(l.subarray(from)) / Math.max(1e-12, rms(r.subarray(from))));
}

describe('chorus: equilibrio estéreo', () => {
  it('con 3 voces (el default) no se va a la izquierda', () => {
    expect(Math.abs(balanceDb(3))).toBeLessThan(0.5);
  });

  it('con cualquier número de voces la imagen queda centrada', () => {
    for (const voices of [2, 3, 4, 5, 6]) {
      expect(Math.abs(balanceDb(voices))).toBeLessThan(1);
    }
  });

  it('y sigue sonando (no se ha centrado apagándolo)', () => {
    const n = SR;
    const src = noise(n);
    const l = src.slice();
    const r = src.slice();
    const fx = createEffect('chorus', SR);
    fx.setParams({ rate: 0.8, depth: 0.5, voices: 3 });
    fx.process(l, r, n, null, null);
    expect(rms(l)).toBeGreaterThan(0.05);
  });
});
