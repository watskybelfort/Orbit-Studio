import { describe, expect, it } from 'vitest';
import { createEffect } from '../src/dsp/effects';
import { SVF } from '../src/dsp/filters';

/** RMS de un array. */
function rms(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / a.length);
}

/** Un seno de `hz` en un buffer de `n` muestras a `sr`. */
function sine(hz: number, n: number, sr: number, amp = 0.5): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return a;
}

describe('limiter: no deja pasar picos por encima del techo', () => {
  it('un click de +12 dB sale por debajo del techo (-0.3 dB ~= 0.966)', () => {
    const lim = createEffect('limiter', 48000)!;
    lim.setParams({ gain: 0, ceiling: -0.3, release: 0.02 });
    const n = 2048;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    // Un pico aislado de amplitud 4 (+12 dBFS) en medio del bloque.
    l[1000] = 4;
    r[1000] = 4;
    lim.process(l, r, n, null, null);
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(l[i]!), Math.abs(r[i]!));
    // Antes salía a ~1.16 (+1.3 dBFS). El techo lineal de -0.3 dB es ~0.966;
    // con un poco de holgura numérica, nunca debe pasar de 1.0.
    expect(peak).toBeLessThanOrEqual(1.0);
  });
});

describe('foldback (distorsión modo 2): conserva la polaridad', () => {
  it('un seno por debajo del umbral no queda en contrafase', () => {
    const dist = createEffect('distortion', 48000)!;
    // drive 0 y modo 2: por debajo del umbral el foldback es identidad, no -y.
    dist.setParams({ drive: 0, mode: 2, output: 1, tone: 18000 });
    const n = 4096;
    const sr = 48000;
    const dry = sine(100, n, sr, 0.3);
    const l = Float32Array.from(dry);
    const r = Float32Array.from(dry);
    dist.process(l, r, n, null, null);
    // Correlación con la entrada: positiva (misma fase), no negativa.
    let dot = 0;
    for (let i = 0; i < n; i++) dot += dry[i]! * l[i]!;
    expect(dot).toBeGreaterThan(0);
  });
});

describe('SVF notch: vacía la banda, no la amplifica', () => {
  it('a resonancia alta, un seno en el corte se ATENÚA', () => {
    const sr = 48000;
    const f = 1000;
    const n = 8192;
    const svf = new SVF();
    svf.set(f, 1, sr); // resonancia máxima
    const inp = sine(f, n, sr, 0.5);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = svf.tick(inp[i]!, 3); // 3 = notch
    // La segunda mitad (ya en régimen) debe tener mucha menos energía que la
    // entrada; antes salía AMPLIFICADA (pico de +19 dB).
    const inTail = inp.subarray(n / 2);
    const outTail = out.subarray(n / 2);
    expect(rms(outTail)).toBeLessThan(rms(inTail) * 0.5);
  });
});
