/**
 * Flush de denormales en filters.ts (Biquad, SVF, Allpass1) y en los lazos
 * de feedback de effects.ts (DelayUnit, FlangerUnit, PhaserUnit) — la misma
 * clase de bug que reverb-denormal-v1.test.ts cubre para la reverb, aplicada
 * a los sitios que ese fix no tocó (ver la tarea "Anti-denormal en filters.ts
 * y en delay/flanger/phaser").
 *
 * Biquad es StripEq (kernel-core.ts), así que corre en CADA canal del mixer
 * todo el tiempo: medido aparte con un benchmark standalone, un Biquad
 * resonante (Q=8, +12 dB @ 1 kHz) sin flush no solo pasa por denormal al
 * soltar la señal — con dos polos complejos el estado entra en un CICLO
 * LÍMITE dentro del rango subnormal de float64 y se queda ahí para SIEMPRE
 * (nunca llega a 0 exacto), costando ~8x el ns/muestra base de forma
 * indefinida (9.5 ns/muestra en decaimiento normal vs 73 ns/muestra atrapado
 * en el ciclo, medido sobre 6M muestras de silencio sin que baje). Con el
 * flush, el mismo filtro converge en <200k muestras a un punto fijo estable
 * (~5.87e-19, que es exactamente eps/(1+a1+a2) con a1=-1.975, a2=0.992) y el
 * costo vuelve a la línea base (10.35 ns/muestra en la misma ventana que
 * antes cruzaba a denormal, 4.11 ns/muestra 8M muestras después).
 *
 * PhaserUnit y FlangerUnit, sin flush, SÍ llegan a magnitudes denormales
 * reales tras una cola de silencio larga (confirmado con el mismo método que
 * usa reverb-denormal-v1.test.ts): PhaserUnit's fbL a -2.5e-323 (denormal de
 * float64) y FlangerUnit's fbL a -5.6e-45 (denormal de float32, el umbral
 * más exigente porque su línea de retardo es un Float32Array). Con el flush
 * ambos convergen a un punto fijo normal muy por debajo del piso de 24 bits.
 */
import { describe, expect, it } from 'vitest';
import { Allpass1, Biquad, SVF } from '../src/dsp/filters';
import { createEffect } from '../src/dsp/effects';

const FLOAT64_MIN_NORMAL = 2.2250738585072014e-308;
const FLOAT32_MIN_NORMAL = 1.1754943508222875e-38;
// Piso de ruido de 24 bits: por debajo de esto es silencio a todo efecto
// práctico, tal como ya usa reverb-denormal-v1.test.ts.
const FLOOR_24BIT = 6e-8;

function seedAndSilence(tick: (x: number) => void, seedSamples: number, silentSamples: number): void {
  for (let i = 0; i < seedSamples; i++) tick(Math.sin(i * 0.05) * 0.9);
  for (let i = 0; i < silentSamples; i++) tick(0);
}

describe('filters.ts: flush de denormales en el estado recursivo', () => {
  it('Biquad (StripEq): z1/z2 convergen a un punto fijo estable, nunca a denormal ni a un ciclo límite', () => {
    const sr = 48000;
    const b = new Biquad();
    // Peaking resonante (Q=8): el peor caso realista de un EQ automatizado a
    // Q alto, el que más tarda en decaer y el que más se beneficia del flush.
    b.peaking(1000, 12, 8, sr);
    seedAndSilence((x) => b.tick(x), 10000, 400000);
    const { z1, z2 } = b as unknown as { z1: number; z2: number };
    expect(Number.isFinite(z1)).toBe(true);
    expect(Number.isFinite(z2)).toBe(true);
    expect(Math.abs(z1)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(z2)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(z1)).toBeLessThan(FLOOR_24BIT);
    expect(Math.abs(z2)).toBeLessThan(FLOOR_24BIT);
  });

  it('Biquad: el punto fijo se mantiene estable (no sigue derivando) en una cola mucho más larga', () => {
    const sr = 48000;
    const b = new Biquad();
    b.peaking(1000, 12, 8, sr);
    seedAndSilence((x) => b.tick(x), 10000, 400000);
    const early = (b as unknown as { z1: number }).z1;
    seedAndSilence(() => b.tick(0), 0, 4000000);
    const late = (b as unknown as { z1: number }).z1;
    // Mismo orden de magnitud: converge, no oscila entre denormal y no-denormal.
    expect(Math.abs(late - early)).toBeLessThan(1e-19);
  });

  it('SVF: ic1eq/ic2eq no caen en denormal ni con un corte muy grave (g mínimo)', () => {
    const sr = 48000;
    const svf = new SVF();
    svf.set(20, 0.9, sr); // corte grave + resonancia alta: peor caso para el SVF
    seedAndSilence((x) => svf.tick(x, 0), 10000, 400000);
    const { ic1eq, ic2eq } = svf as unknown as { ic1eq: number; ic2eq: number };
    expect(Number.isFinite(ic1eq)).toBe(true);
    expect(Number.isFinite(ic2eq)).toBe(true);
    expect(Math.abs(ic1eq)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(ic2eq)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(ic1eq)).toBeLessThan(FLOOR_24BIT);
    expect(Math.abs(ic2eq)).toBeLessThan(FLOOR_24BIT);
  });

  it('Allpass1 (phaser): z no cae en denormal ni con una frecuencia muy grave', () => {
    const sr = 48000;
    const ap = new Allpass1();
    ap.set(30, sr); // 30 Hz: por fuera del rango real de PhaserUnit (min ~300 Hz), a propósito
    seedAndSilence((x) => ap.tick(x), 10000, 400000);
    const z = (ap as unknown as { z: number }).z;
    expect(Number.isFinite(z)).toBe(true);
    expect(Math.abs(z)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(z)).toBeLessThan(FLOOR_24BIT);
  });
});

describe('effects.ts: flush de denormales en DelayUnit/FlangerUnit/PhaserUnit', () => {
  function driveEffectSilence(
    fx: { process(l: Float32Array, r: Float32Array, n: number, a: null, b: null): void },
    seedBlocks: number,
    silentBlocks: number,
    n: number,
  ): void {
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let bl = 0; bl < seedBlocks; bl++) {
      for (let i = 0; i < n; i++) { l[i] = Math.sin(i * 0.1) * 0.9; r[i] = Math.sin(i * 0.11) * 0.9; }
      fx.process(l, r, n, null, null);
    }
    for (let bl = 0; bl < silentBlocks; bl++) {
      // process() escribe la salida IN-PLACE: hay que volver a poner silencio
      // en l/r antes de cada bloque o se re-inyecta la salida anterior como
      // si fuera entrada nueva.
      l.fill(0);
      r.fill(0);
      fx.process(l, r, n, null, null);
    }
  }

  it('DelayUnit: el contenido de la línea de retardo no cae en denormal float32 tras una cola larga', () => {
    const sr = 44100;
    const fx = createEffect('delay', sr);
    fx.setTempo!(140);
    fx.setParams({ time: 0, feedback: 0.95, pingpong: 1, filter: 3500 });
    driveEffectSilence(fx, 50, 4000, 512);
    const buf = (fx as unknown as { dl: { buf: Float32Array } }).dl.buf;
    let maxAbs = 0;
    for (const v of buf) {
      const a = Math.abs(v);
      maxAbs = Math.max(maxAbs, a);
      if (a !== 0) expect(a).toBeGreaterThan(FLOAT32_MIN_NORMAL);
    }
    expect(Number.isFinite(maxAbs)).toBe(true);
    expect(maxAbs).toBeLessThan(FLOOR_24BIT);
  });

  it('FlangerUnit: fbL/fbR convergen a eps/(1-feedback), no a denormal', () => {
    const sr = 44100;
    const fx = createEffect('flanger', sr);
    fx.setParams({ rate: 0.3, depth: 0.6, feedback: 0.9 });
    driveEffectSilence(fx, 50, 4000, 512);
    const { fbL, fbR } = fx as unknown as { fbL: number; fbR: number };
    expect(Number.isFinite(fbL)).toBe(true);
    expect(Number.isFinite(fbR)).toBe(true);
    if (fbL !== 0) expect(Math.abs(fbL)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(fbL)).toBeLessThan(FLOOR_24BIT);
    // eps/(1-0.9) = 1e-19: el punto fijo esperado.
    expect(Math.abs(fbL)).toBeCloseTo(1e-19, 20);
  });

  it('PhaserUnit: fbL/fbR convergen a un punto fijo normal, no a denormal', () => {
    const sr = 44100;
    const fx = createEffect('phaser', sr);
    fx.setParams({ rate: 0.4, depth: 0.7, stages: 4, feedback: 0.9 });
    driveEffectSilence(fx, 50, 4000, 512);
    const { fbL, fbR } = fx as unknown as { fbL: number; fbR: number };
    expect(Number.isFinite(fbL)).toBe(true);
    expect(Number.isFinite(fbR)).toBe(true);
    if (fbL !== 0) expect(Math.abs(fbL)).toBeGreaterThan(FLOAT64_MIN_NORMAL);
    expect(Math.abs(fbL)).toBeLessThan(FLOOR_24BIT);
  });

  it('la salida de los tres efectos se mantiene finita durante una cola larga sin entrada, y termina decayendo', () => {
    const sr = 44100;
    for (const kind of ['delay', 'flanger', 'phaser'] as const) {
      const fx = createEffect(kind, sr);
      if (kind === 'delay') fx.setTempo!(140);
      fx.setParams({ time: 4, feedback: 0.9, pingpong: 1, filter: 3500, rate: 0.4, depth: 0.7, stages: 4 });
      const l = new Float32Array(512);
      const r = new Float32Array(512);
      for (let bl = 0; bl < 20; bl++) {
        for (let i = 0; i < 512; i++) { l[i] = Math.sin(i * 0.1) * 0.9; r[i] = Math.sin(i * 0.11) * 0.9; }
        fx.process(l, r, 512, null, null);
      }
      let allFinite = true;
      // El comb/allpass con feedback puede sobrepasar la amplitud de entrada
      // en el transitorio justo al cortar la señal (resonancia, no un bug:
      // Comb en reverb.ts hace lo mismo) — lo que importa para el fix de
      // denormales es que la COLA LARGA termine decayendo, no que nunca
      // pase de 1 en el golpe inicial.
      let maxAbsFinal = 0;
      const TOTAL_BLOCKS = 3000;
      for (let bl = 0; bl < TOTAL_BLOCKS; bl++) {
        l.fill(0);
        r.fill(0);
        fx.process(l, r, 512, null, null);
        for (let i = 0; i < 512; i++) {
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) allFinite = false;
          if (bl >= TOTAL_BLOCKS - 20) maxAbsFinal = Math.max(maxAbsFinal, Math.abs(l[i]!), Math.abs(r[i]!));
        }
      }
      expect(allFinite, `${kind}: salida finita`).toBe(true);
      expect(maxAbsFinal, `${kind}: la cola ya decayó al final de la ventana`).toBeLessThan(1e-4);
    }
  });
});
