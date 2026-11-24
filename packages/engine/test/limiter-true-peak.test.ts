import { describe, expect, it } from 'vitest';
import { createEffect } from '../src/dsp/effects';

/**
 * Un seno a fs/4 con fase de 45°: todas las muestras valen ±0,707 pero la onda
 * llega a 1,0 ENTRE muestras. Es el caso de libro del true peak: un limitador
 * que solo mira el pico de muestra lo deja pasar entero aunque el techo sea
 * -1 dB (0,891), y al convertirlo a MP3 o pasarlo por un DAC clipea.
 */
function interSampleSine(n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
  return a;
}

/** Pico real estimado sobremuestreando ×16 con interpolación sinc larga (referencia independiente). */
function truePeakOf(x: Float32Array, from: number): number {
  let peak = 0;
  for (let i = from + 32; i < x.length - 32; i++) {
    for (let k = 0; k < 16; k++) {
      const t = i + k / 16;
      let y = 0;
      for (let j = Math.floor(t) - 31; j <= Math.floor(t) + 32; j++) {
        const d = t - j;
        y += x[j]! * (Math.abs(d) < 1e-9 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d));
      }
      peak = Math.max(peak, Math.abs(y));
    }
  }
  return peak;
}

function run(truePeak: number): Float32Array {
  const lim = createEffect('limiter', 48000)!;
  lim.setParams({ gain: 0, ceiling: -1, release: 0.05, truePeak });
  const n = 4096;
  const l = interSampleSine(n);
  const r = interSampleSine(n);
  lim.process(l, r, n, null, null);
  return l;
}

describe('limiter con true peak', () => {
  it('apagado (por defecto) deja pasar el pico entre muestras: así se comportaba siempre', () => {
    expect(truePeakOf(run(0), 1024)).toBeGreaterThan(0.97);
  });

  it('encendido, el pico real queda por debajo del techo de -1 dB', () => {
    const tp = truePeakOf(run(1), 1024);
    // Techo -1 dB = 0,891; holgura del sinc corto de 8 coeficientes.
    expect(tp).toBeLessThan(0.9);
    // Y no aplasta de más: sigue cerca del techo.
    expect(tp).toBeGreaterThan(0.8);
  });

  it('sin parámetro truePeak suena igual que con truePeak 0 (proyectos y golden intactos)', () => {
    const lim = createEffect('limiter', 48000)!;
    lim.setParams({ gain: 0, ceiling: -1, release: 0.05 });
    const n = 4096;
    const l = interSampleSine(n);
    const r = interSampleSine(n);
    lim.process(l, r, n, null, null);
    expect(Array.from(l)).toEqual(Array.from(run(0)));
  });
});
