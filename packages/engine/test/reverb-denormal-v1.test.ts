/**
 * Flush de denormales en la reverb (Comb y AllpassFV, reverb.ts). Cuando la
 * reverb deja de recibir señal, la cola decae exponencialmente hacia cero
 * pero nunca llega: sin flush, el estado recursivo entra en rango denormal
 * y cada operación de punto flotante cuesta un orden de magnitud más — justo
 * cuando la música PARA. Medido aparte con un benchmark standalone (ver
 * informe): con el preset por defecto (size 0.6, damp 0.4), el comb SIN
 * flush cruza a denormal de float64 a los ~6-7 millones de muestras de
 * silencio (~140 s a 48 kHz) y el costo por muestra sube de ~68 ns a
 * ~2300 ns (~34x). Con el flush, el estado converge a un piso de ~1e-19 y se
 * queda ahí: nunca denormal, nunca 0 exacto, siempre silencio a todo efecto
 * práctico (float64 denormal empieza en ~2.2e-308; 24 bits de audio ya no
 * distinguen nada por debajo de ~6e-8).
 */
import { describe, expect, it } from 'vitest';
import { Reverb } from '../src/dsp/reverb';

const FLOAT64_MIN_NORMAL = 2.2250738585072014e-308;

describe('Reverb: flush de denormales en la cola larga sin entrada', () => {
  it('el estado de los combs converge a un piso muy por encima del umbral denormal, nunca a denormal ni a 0 exacto', () => {
    const sr = 48000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rv = new Reverb(sr) as any;
    rv.set(0.6, 0.4, 1, 0, sr); // preset por defecto de ReverbUnit (effects.ts)
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 4000; i++) rv.tick(Math.sin(i * 0.037) * 0.9, Math.sin(i * 0.041) * 0.9, out);
    // 300k muestras de silencio (~6.25 s a 48 kHz): según el benchmark, el
    // piso ya se alcanza en los primeros miles de muestras con este preset.
    for (let i = 0; i < 300000; i++) rv.tick(0, 0, out);
    for (const comb of rv.combsL as Array<{ filterStore: number }>) {
      expect(Number.isFinite(comb.filterStore)).toBe(true);
      expect(Math.abs(comb.filterStore)).toBeGreaterThan(0);
      expect(Math.abs(comb.filterStore)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
      // Y muy por debajo de cualquier piso de ruido audible: sigue siendo
      // silencio a todo efecto práctico.
      expect(Math.abs(comb.filterStore)).toBeLessThan(1e-10);
    }
    for (const comb of rv.combsR as Array<{ filterStore: number }>) {
      expect(Math.abs(comb.filterStore)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    }
  });

  it('AllpassFV: el contenido de la línea de retardo tampoco cae en denormal', () => {
    const sr = 48000;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rv = new Reverb(sr) as any;
    rv.set(0.6, 0.4, 1, 0, sr);
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 4000; i++) rv.tick(Math.sin(i * 0.031) * 0.9, Math.sin(i * 0.043) * 0.9, out);
    for (let i = 0; i < 300000; i++) rv.tick(0, 0, out);
    for (const ap of rv.apL as Array<{ buf: Float32Array }>) {
      let minNonZeroAbs = Infinity;
      for (const v of ap.buf) {
        if (v !== 0) minNonZeroAbs = Math.min(minNonZeroAbs, Math.abs(v));
      }
      // Float32Array: el umbral denormal relevante es el de float32.
      const FLOAT32_MIN_NORMAL = 1.1754943508222875e-38;
      if (Number.isFinite(minNonZeroAbs)) {
        expect(minNonZeroAbs).toBeGreaterThan(FLOAT32_MIN_NORMAL);
      }
    }
  });

  it('la salida se mantiene finita y acotada durante una cola larga sin entrada', () => {
    const sr = 48000;
    const rv = new Reverb(sr);
    rv.set(0.9, 0.2, 1, 0, sr); // cola más larga todavía (feedback más alto)
    const out: [number, number] = [0, 0];
    for (let i = 0; i < 4000; i++) rv.tick(Math.sin(i * 0.05) * 0.8, Math.sin(i * 0.06) * 0.8, out);
    let maxAbs = 0;
    let allFinite = true;
    for (let i = 0; i < 200000; i++) {
      rv.tick(0, 0, out);
      if (!Number.isFinite(out[0]) || !Number.isFinite(out[1])) allFinite = false;
      maxAbs = Math.max(maxAbs, Math.abs(out[0]), Math.abs(out[1]));
    }
    expect(allFinite).toBe(true);
    // La cola decae: hacia el final del tramo ya no debería quedar energía
    // perceptible (muy por debajo de la ráfaga inicial).
    expect(maxAbs).toBeLessThan(1);
  });
});
