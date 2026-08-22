/**
 * FFT y MDCT del encoder Opus.
 *
 * La estrategia de estos tests es la que hace que se pueda confiar en código de
 * transformadas: **todo lo rápido se compara contra lo lento**. La definición
 * directa es imposible de discutir —es la fórmula, escrita tal cual— así que
 * sirve de juez. Y encima de eso, la propiedad que de verdad importa: TDAC,
 * que la señal vuelva entera después de ir y venir.
 */

import { describe, expect, it } from 'vitest';
import { dftNaive, factorize, fft } from '../src/render/opus/fft';
import {
  OPUS_FRAME_SIZES,
  celtWindow,
  celtWindowFull,
  imdct,
  imdctNaive,
  mdct,
  mdctAnalyze,
  mdctNaive,
  mdctSynthesize,
} from '../src/render/opus/mdct';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

function noise(n: number, seed: number): Float64Array {
  const random = rng(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = random();
  return out;
}

/** Error máximo entre dos vectores, relativo a la amplitud del mayor. */
function maxError(a: Float64Array, b: Float64Array): number {
  let peak = 1e-12;
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    peak = Math.max(peak, Math.abs(a[i]!), Math.abs(b[i]!));
    worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  }
  return worst / peak;
}

describe('fft · radix mixto', () => {
  it('factoriza los tamaños de Opus (ninguno es potencia de dos)', () => {
    // Ésta es la razón de existir del módulo: 960 = 2^6 · 15.
    expect(factorize(960)).toEqual([4, 4, 4, 3, 5]);
    expect(factorize(120)).toEqual([4, 2, 3, 5]);
    expect(OPUS_FRAME_SIZES.every((n) => n % 2 === 0)).toBe(true);
  });

  it('coincide con la DFT directa en tamaños con factores 2, 3 y 5', () => {
    for (const n of [2, 3, 4, 5, 6, 8, 12, 15, 16, 30, 60, 120, 240, 480, 960, 1920]) {
      const re = noise(n, n);
      const im = noise(n, n + 7919);
      const reference = dftNaive(re, im, -1);
      const fastRe = Float64Array.from(re);
      const fastIm = Float64Array.from(im);
      fft(fastRe, fastIm, -1);
      expect(maxError(fastRe, reference.re), `parte real, n=${n}`).toBeLessThan(1e-12);
      expect(maxError(fastIm, reference.im), `parte imaginaria, n=${n}`).toBeLessThan(1e-12);
    }
  });

  it('ida y vuelta devuelve la señal (dividiendo por n)', () => {
    const n = 480;
    const re = noise(n, 11);
    const im = noise(n, 12);
    const workRe = Float64Array.from(re);
    const workIm = Float64Array.from(im);
    fft(workRe, workIm, -1);
    fft(workRe, workIm, 1);
    for (let i = 0; i < n; i++) {
      workRe[i] = workRe[i]! / n;
      workIm[i] = workIm[i]! / n;
    }
    expect(maxError(workRe, re)).toBeLessThan(1e-12);
    expect(maxError(workIm, im)).toBeLessThan(1e-12);
  });
});

describe('mdct · contra la definición', () => {
  it('la MDCT rápida da lo mismo que la fórmula, en todos los tamaños', () => {
    for (const n of OPUS_FRAME_SIZES) {
      const x = noise(2 * n, n + 100);
      expect(maxError(mdct(x, n), mdctNaive(x, n)), `MDCT n=${n}`).toBeLessThan(1e-12);
    }
  });

  it('la IMDCT rápida da lo mismo que la fórmula, en todos los tamaños', () => {
    for (const n of OPUS_FRAME_SIZES) {
      const coeffs = noise(n, n + 200);
      expect(maxError(imdct(coeffs, n), imdctNaive(coeffs, n)), `IMDCT n=${n}`).toBeLessThan(1e-12);
    }
  });

  it('saca la mitad de coeficientes que muestras entran', () => {
    expect(mdct(noise(1920, 1), 960)).toHaveLength(960);
    expect(imdct(noise(960, 1), 960)).toHaveLength(1920);
  });

  it('rechaza tamaños que no cuadran en vez de dar basura', () => {
    expect(() => mdct(noise(100, 1), 960)).toThrow(/pide 1920/);
    expect(() => imdct(noise(100, 1), 960)).toThrow(/pide 960/);
  });
});

describe('mdct · la ventana de CELT', () => {
  it('cumple Princen-Bradley: w[i]² + w[L-1-i]² = 1', () => {
    // Sin esto no hay cancelación de aliasing. Es LA condición.
    for (const overlap of [24, 48, 96, 120, 240]) {
      const w = celtWindow(overlap);
      for (let i = 0; i < overlap; i++) {
        const sum = w[i]! ** 2 + w[overlap - 1 - i]! ** 2;
        expect(Math.abs(sum - 1), `overlap=${overlap}, i=${i}`).toBeLessThan(1e-12);
      }
    }
  });

  it('sube de 0 a 1 de forma monótona', () => {
    const w = celtWindow(120);
    expect(w[0]!).toBeLessThan(0.05);
    expect(w[119]!).toBeGreaterThan(0.95);
    for (let i = 1; i < 120; i++) expect(w[i]!).toBeGreaterThan(w[i - 1]!);
  });

  it('la ventana completa es de solape corto: colas a cero y centro plano', () => {
    const n = 960;
    const overlap = 120;
    const w = celtWindowFull(n, overlap);
    expect(w).toHaveLength(2 * n);
    const pad = (n - overlap) / 2;
    // Cola de silencio: la trama de al lado no aporta nada ahí.
    for (let i = 0; i < pad; i++) expect(w[i]).toBe(0);
    // Centro plano: la señal pasa sin tocar.
    for (let i = pad + overlap; i < n; i++) expect(w[i]).toBe(1);
    // Simetría.
    for (let i = 0; i < n; i++) expect(w[2 * n - 1 - i]).toBe(w[i]);
  });

  it('la ventana completa también cumple Princen-Bradley (w[n]² + w[n+N]² = 1)', () => {
    const n = 480;
    const w = celtWindowFull(n, 120);
    for (let i = 0; i < n; i++) {
      const sum = w[i]! ** 2 + w[i + n]! ** 2;
      expect(Math.abs(sum - 1), `i=${i}`).toBeLessThan(1e-12);
    }
  });

  it('exige que (N - overlap) sea par', () => {
    expect(() => celtWindowFull(960, 121)).toThrow(/par/);
    expect(() => celtWindowFull(120, 240)).toThrow(/no cabe/);
  });
});

describe('mdct · TDAC (la prueba de verdad)', () => {
  it('ruido blanco vuelve entero tras ir y venir', () => {
    // Si el aliasing no se cancelara, esto fallaría por goleada, no por poco.
    for (const n of OPUS_FRAME_SIZES) {
      const overlap = n / 4;
      const signal = noise(n * 5, n + 300);
      const frames = mdctAnalyze(signal, n, overlap);
      const back = mdctSynthesize(frames, n, overlap, signal.length);
      expect(maxError(back, signal), `TDAC n=${n}`).toBeLessThan(1e-11);
    }
  });

  it('un seno puro vuelve entero (y no deja rizado en los bordes de trama)', () => {
    const n = 480;
    const signal = new Float64Array(n * 6);
    for (let i = 0; i < signal.length; i++) signal[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    const frames = mdctAnalyze(signal, n, 120);
    const back = mdctSynthesize(frames, n, 120, signal.length);
    expect(maxError(back, signal)).toBeLessThan(1e-11);
  });

  it('un impulso vuelve entero: el caso que más delata el pre-eco', () => {
    const n = 240;
    const signal = new Float64Array(n * 6);
    signal[n * 3 + 17] = 1;
    const frames = mdctAnalyze(signal, n, 60);
    const back = mdctSynthesize(frames, n, 60, signal.length);
    let worst = 0;
    for (let i = 0; i < signal.length; i++) worst = Math.max(worst, Math.abs(back[i]! - signal[i]!));
    expect(worst).toBeLessThan(1e-11);
  });

  it('el silencio se queda en silencio', () => {
    const n = 120;
    const signal = new Float64Array(n * 4);
    const frames = mdctAnalyze(signal, n, 30);
    for (const frame of frames) for (const c of frame) expect(Math.abs(c)).toBeLessThan(1e-15);
    const back = mdctSynthesize(frames, n, 30, signal.length);
    for (const s of back) expect(Math.abs(s)).toBeLessThan(1e-15);
  });

  it('la energía se concentra: un tono ocupa pocos coeficientes', () => {
    // Esto es lo que hace que el códec pueda comprimir. Si la MDCT repartiera
    // la energía por todas partes, no habría nada que tirar.
    const n = 480;
    const signal = new Float64Array(n * 4);
    for (let i = 0; i < signal.length; i++) signal[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const frame = mdctAnalyze(signal, n, 120)[2]!;
    const total = frame.reduce((sum, c) => sum + c * c, 0);
    const sorted = Array.from(frame, (c) => c * c).sort((a, b) => b - a);
    const top = sorted.slice(0, 8).reduce((sum, c) => sum + c, 0);
    expect(top / total).toBeGreaterThan(0.95);
  });
});
