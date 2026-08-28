/**
 * Lo que cruza HACIA la vista, y por dónde no cruza.
 *
 * La pieza importante que se prueba aquí es negativa: lo que ve el plugin sale
 * de los parámetros y del tap que la UI ya leía, se escribe en un buffer que ya
 * existía, y no hay ni un camino que pase por el hilo de audio. Si algún día
 * alguien mete aquí una llamada al worklet, estas pruebas siguen pasando — pero
 * el comentario de `view-input.ts` deja dicho por qué no debe hacerse.
 */

import { describe, expect, it } from 'vitest';
import { fillViewInput, levelOfFrame } from '../src/plugins/view-input';
import {
  FLAG_LEVEL,
  FLAG_SPECTRUM,
  IN_ASPECT,
  IN_FLAGS,
  IN_LEN,
  IN_LEVEL,
  IN_NBINS,
  IN_NPARAMS,
  IN_PARAMS,
  IN_SAMPLE_RATE,
  IN_SPECTRUM,
  VIEW_MAX_PARAMS,
  VIEW_SPECTRUM_BINS,
} from '../src/plugins/view-protocol';
import { MAX_PARAMS } from '../src/state/plugin-parse';

describe('levelOfFrame', () => {
  it('saca pico y RMS de un frame del tap sin reservar nada', () => {
    const frame = new Float32Array(1000);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.sin((2 * Math.PI * i) / 100) * 0.5;
    const out = new Float32Array(2);
    levelOfFrame(frame, out);
    expect(out[0]).toBeCloseTo(0.5, 2);
    expect(out[1]).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('sin frame (el tap se lo llevó otra vista) devuelve silencio, no basura', () => {
    const out = new Float32Array([9, 9]);
    levelOfFrame(null, out);
    expect(Array.from(out)).toEqual([0, 0]);
    levelOfFrame(new Float32Array(0), out);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  it('recorta por encima de 1 (una pista saturada no desborda el medidor)', () => {
    const out = new Float32Array(2);
    levelOfFrame(new Float32Array([3, -4, 2]), out);
    expect(out[0]).toBe(1);
    expect(out[1]).toBe(1);
  });
});

describe('fillViewInput', () => {
  const base = {
    aspect: 0.5,
    sampleRate: 48000,
    paramKeys: ['a', 'b'] as const,
    params: { a: 3, b: 7 },
    defaults: { a: 1, b: 2 },
    level: null,
    spectrumDb: null,
  };

  it('escribe la cabecera y los params en el orden acordado', () => {
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, base);
    expect(input[IN_ASPECT]).toBe(0.5);
    expect(input[IN_SAMPLE_RATE]).toBe(48000);
    expect(input[IN_NPARAMS]).toBe(2);
    expect(input[IN_PARAMS]).toBe(3);
    expect(input[IN_PARAMS + 1]).toBe(7);
    expect(input[IN_FLAGS]).toBe(0);
  });

  it('un param que aún no tiene valor cae a su default', () => {
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, params: { a: 5 } });
    expect(input[IN_PARAMS]).toBe(5);
    expect(input[IN_PARAMS + 1]).toBe(2);
  });

  it('un valor corrupto en el proyecto no se cuela como NaN', () => {
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, params: { a: NaN, b: Infinity } });
    expect(input[IN_PARAMS]).toBe(1);
    expect(input[IN_PARAMS + 1]).toBe(2);
  });

  it('solo manda el nivel si la vista lo pidió', () => {
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, level: new Float32Array([0.8, 0.4]) });
    expect(input[IN_FLAGS]! & FLAG_LEVEL).toBe(FLAG_LEVEL);
    expect(input[IN_LEVEL]).toBeCloseTo(0.8);
    expect(input[IN_LEVEL + 1]).toBeCloseTo(0.4);

    const sin = new Float32Array(IN_LEN);
    fillViewInput(sin, base);
    expect(sin[IN_FLAGS]! & FLAG_LEVEL).toBe(0);
    expect(sin[IN_LEVEL]).toBe(0);
  });

  it('solo copia el espectro si la vista lo pidió (512 floats no son gratis)', () => {
    const db = new Float32Array(VIEW_SPECTRUM_BINS);
    db.fill(-40);
    db[7] = -3;
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, spectrumDb: db });
    expect(input[IN_FLAGS]! & FLAG_SPECTRUM).toBe(FLAG_SPECTRUM);
    expect(input[IN_NBINS]).toBe(VIEW_SPECTRUM_BINS);
    expect(input[IN_SPECTRUM + 7]).toBe(-3);

    const sin = new Float32Array(IN_LEN);
    fillViewInput(sin, base);
    expect(sin[IN_NBINS]).toBe(0);
    expect(sin[IN_SPECTRUM + 7]).toBe(0);
  });

  it('un analizador con más bins de los que caben se recorta', () => {
    const db = new Float32Array(VIEW_SPECTRUM_BINS * 2).fill(-10);
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, spectrumDb: db });
    expect(input[IN_NBINS]).toBe(VIEW_SPECTRUM_BINS);
    expect(input.length).toBe(IN_LEN); // no se salió del buffer
  });

  it('más perillas de las que caben no desbordan el frame', () => {
    const keys = Array.from({ length: VIEW_MAX_PARAMS + 10 }, (_, i) => `k${i}`);
    const params: Record<string, number> = {};
    for (const k of keys) params[k] = 1;
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, paramKeys: keys, params, defaults: {} });
    expect(input[IN_NPARAMS]).toBe(VIEW_MAX_PARAMS);
    // El último slot de params sigue dentro, y el nivel no se pisó.
    expect(input[IN_PARAMS + VIEW_MAX_PARAMS - 1]).toBe(1);
    expect(input[IN_LEVEL]).toBe(0);
  });

  it('el frame tiene sitio para tantas perillas como pinta la UI', () => {
    // Si alguien sube el tope de perillas del parser sin subir el del frame,
    // las últimas dejarían de llegar a la vista sin decir nada.
    expect(VIEW_MAX_PARAMS).toBe(MAX_PARAMS);
  });

  it('un aspecto absurdo cae a 1 en vez de deformar el dibujo', () => {
    const input = new Float32Array(IN_LEN);
    fillViewInput(input, { ...base, aspect: NaN });
    expect(input[IN_ASPECT]).toBe(1);
    fillViewInput(input, { ...base, aspect: 0 });
    expect(input[IN_ASPECT]).toBe(1);
  });

  it('rellenar mil frames no cambia el buffer de sitio (nada se reserva)', () => {
    const input = new Float32Array(IN_LEN);
    const buffer = input.buffer;
    const db = new Float32Array(VIEW_SPECTRUM_BINS).fill(-20);
    for (let i = 0; i < 1000; i++) {
      fillViewInput(input, { ...base, level: new Float32Array([0.1, 0.1]), spectrumDb: db });
    }
    expect(input.buffer).toBe(buffer);
    expect(input.length).toBe(IN_LEN);
  });
});
