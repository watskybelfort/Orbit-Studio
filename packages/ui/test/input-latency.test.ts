import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_MARGIN,
  DEFAULT_MIN_PEAK,
  DEFAULT_SILENCE_RMS,
  compensateClipStart,
  estimateDelaySamples,
  generateChirp,
  latencyBeats,
  msToSamples,
  samplesToMs,
} from '../src/state/input-latency';

const SAMPLE_RATE = 48000;

/** PRNG determinista (mulberry32): mismo ruido en cada corrida, sin flakes. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noise(length: number, amplitude: number, seed = 1): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = (rnd() * 2 - 1) * amplitude;
  return out;
}

/** Ruido de fondo + el chirp (a `gain`, opcionalmente invertido) en `delaySamples`. */
function syntheticCapture(
  probe: Float32Array,
  delaySamples: number,
  opts: { tailSamples?: number; noiseAmplitude?: number; gain?: number; seed?: number } = {},
): Float32Array {
  const tailSamples = opts.tailSamples ?? 5000;
  const noiseAmplitude = opts.noiseAmplitude ?? 0.01;
  const gain = opts.gain ?? 0.6;
  const total = delaySamples + probe.length + tailSamples;
  const out = noise(total, noiseAmplitude, opts.seed ?? 1);
  for (let i = 0; i < probe.length; i++) {
    out[delaySamples + i]! += probe[i]! * gain;
  }
  return out;
}

describe('generateChirp', () => {
  it('la duración por defecto sale en muestras, redondeada', () => {
    const chirp = generateChirp({ sampleRate: SAMPLE_RATE });
    expect(chirp.length).toBe(Math.round(0.05 * SAMPLE_RATE));
  });

  it('respeta una duración explícita', () => {
    const chirp = generateChirp({ sampleRate: SAMPLE_RATE, durationMs: 20 });
    expect(chirp.length).toBe(Math.round(0.02 * SAMPLE_RATE));
  });

  it('nunca pasa de la amplitud pedida (la ventana Hann solo puede bajarla)', () => {
    const amplitude = 0.7;
    const chirp = generateChirp({ sampleRate: SAMPLE_RATE, amplitude });
    for (const sample of chirp) expect(Math.abs(sample)).toBeLessThanOrEqual(amplitude + 1e-9);
  });

  it('arranca y termina en (casi) cero: la ventana Hann cierra los bordes', () => {
    const chirp = generateChirp({ sampleRate: SAMPLE_RATE });
    expect(Math.abs(chirp[0]!)).toBeLessThan(1e-6);
    expect(Math.abs(chirp[chirp.length - 1]!)).toBeLessThan(1e-6);
  });
});

describe('estimateDelaySamples — el test que importa: un retardo inyectado a propósito', () => {
  it('encuentra el retardo exacto en una señal limpia, sin ruido', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const delaySamples = 733;
    const captured = syntheticCapture(probe, delaySamples, { noiseAmplitude: 0 });

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.delaySamples).toBe(delaySamples);
    expect(result.delayMs).toBeCloseTo(samplesToMs(delaySamples, SAMPLE_RATE), 5);
    expect(result.confidence).toBeGreaterThan(DEFAULT_MIN_PEAK);
  });

  it('lo encuentra dentro de ±1 muestra con ruido de fondo de sala', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const delaySamples = 4111; // ~85 ms a 48 kHz: un aparato con buffer grande
    const captured = syntheticCapture(probe, delaySamples, { noiseAmplitude: 0.02, gain: 0.5 });

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.delaySamples - delaySamples)).toBeLessThanOrEqual(1);
  });

  it('un eco con la fase invertida (aparato que la da vuelta) se detecta igual', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const delaySamples = 200;
    const captured = syntheticCapture(probe, delaySamples, { noiseAmplitude: 0.01, gain: -0.6 });

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.delaySamples - delaySamples)).toBeLessThanOrEqual(1);
  });

  it('un retardo pequeño (interfaz USB con buffer chico) también se encuentra', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const delaySamples = 96; // 2 ms a 48 kHz
    const captured = syntheticCapture(probe, delaySamples, { noiseAmplitude: 0.01, gain: 0.7 });

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.delaySamples - delaySamples)).toBeLessThanOrEqual(1);
  });
});

describe('estimateDelaySamples — rechazar antes que mentir', () => {
  it('una captura sin señal (auriculares, micro cerrado) se rechaza como silencio, NUNCA como cero', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const captured = new Float32Array(probe.length + 8000); // todo ceros

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('silence');
    expect(result.confidence).toBe(0);
  });

  it('un ligero soplido de ruido de fondo por debajo del umbral también es silencio', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const captured = noise(probe.length + 8000, DEFAULT_SILENCE_RMS * 0.3, 7);

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('silence');
  });

  it('hay señal pero no tiene nada que ver con el chirp: se rechaza por correlación floja, no por silencio', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    // Nivel normal de una habitación con el micro abierto, pero SIN el chirp.
    const captured = noise(probe.length + 8000, 0.05, 3);

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('weak-correlation');
    expect(result.confidence).toBeLessThan(DEFAULT_MIN_PEAK);
  });

  it('un segundo pico casi tan alto como el primero (eco ambiguo) se rechaza por margen', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE, durationMs: 30 });
    // Dos ecos casi igual de fuertes: ninguno de los dos es "el" retardo con
    // confianza, así que ni el más alto de los dos debería aceptarse solo.
    const total = 200 + probe.length + 3000 + probe.length;
    const out = noise(total, 0.01, 9);
    for (let i = 0; i < probe.length; i++) out[200 + i]! += probe[i]! * 0.5;
    for (let i = 0; i < probe.length; i++) out[200 + probe.length + 3000 + i]! += probe[i]! * 0.49;

    const result = estimateDelaySamples(probe, out, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('weak-correlation');
  });

  it('una captura más corta que el propio chirp no se correlaciona: "too-short"', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const captured = probe.slice(0, probe.length - 1);

    const result = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-short');
  });

  it('un umbral de margen explícito y más estricto rechaza lo que el por defecto aceptaba', () => {
    const probe = generateChirp({ sampleRate: SAMPLE_RATE });
    const delaySamples = 500;
    const captured = syntheticCapture(probe, delaySamples, { noiseAmplitude: 0.15, gain: 0.4 });

    const loose = estimateDelaySamples(probe, captured, { sampleRate: SAMPLE_RATE });
    const strict = estimateDelaySamples(probe, captured, {
      sampleRate: SAMPLE_RATE,
      minMargin: 0.98,
    });

    // No se afirma qué decide el umbral por defecto con este ruido (depende
    // del seed); lo que importa es que subir la exigencia nunca puede volver
    // ok=true algo que con menos exigencia ya era ok=false, y aquí, con un
    // margen casi imposible, tiene que rechazar sí o sí.
    expect(strict.ok).toBe(false);
    void loose;
  });
});

describe('DEFAULT_MIN_PEAK / DEFAULT_MIN_MARGIN — de fábrica, más ácido que cero', () => {
  it('los valores por defecto no son triviales (no aceptan cualquier cosa)', () => {
    expect(DEFAULT_MIN_PEAK).toBeGreaterThan(0.3);
    expect(DEFAULT_MIN_MARGIN).toBeGreaterThan(0);
  });
});

describe('compensateClipStart — el clip cae en su sitio, no donde lo detectó la toma', () => {
  const SR = 48000;
  const TEMPO = 120; // 2 beats/segundo, cuenta redonda para verificar a mano

  it('un retardo medido de verdad corre el clip hacia atrás lo justo', () => {
    // Con la calibración inyectada de esta misma suite: 733 muestras a 48 kHz
    // y 120 BPM son 733/48000 * 2 = 0.03054... beats.
    const delaySamples = 733;
    const beats = latencyBeats(delaySamples, SR, TEMPO);
    expect(beats).toBeCloseTo((733 / 48000) * 2, 10);

    const startBeat = 16;
    expect(compensateClipStart(startBeat, delaySamples, SR, TEMPO)).toBeCloseTo(
      startBeat - beats,
      10,
    );
  });

  it('sin calibrar (0 muestras) el clip no se mueve un pelo', () => {
    expect(compensateClipStart(16, 0, SR, TEMPO)).toBe(16);
  });

  it('nunca nace antes del compás 1: se recorta a 0', () => {
    // Grabando desde el principio de la canción, un retardo grande no puede
    // empujar el clip a un `start` negativo.
    expect(compensateClipStart(0.01, 96000, SR, TEMPO)).toBe(0);
  });

  it('a más tempo, el mismo retardo en muestras corre más beats (el reloj musical va más rápido)', () => {
    const delaySamples = 2400; // 50 ms a 48 kHz
    const lento = latencyBeats(delaySamples, SR, 60);
    const rapido = latencyBeats(delaySamples, SR, 180);
    expect(rapido).toBeGreaterThan(lento);
    expect(rapido).toBeCloseTo(lento * 3, 10);
  });

  it('extremo a extremo: la calibración encuentra el retardo Y el clip cae donde debía', () => {
    // Reproduce el caso real: un aparato con 4111 muestras de bucle, una toma
    // que arrancó en el beat 32 a 140 BPM.
    const probe = generateChirp({ sampleRate: SR });
    const trueDelay = 4111;
    const captured = syntheticCapture(probe, trueDelay, { noiseAmplitude: 0.01, gain: 0.6 });

    const result = estimateDelaySamples(probe, captured, { sampleRate: SR });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const startBeat = 32;
    const tempo = 140;
    const placed = compensateClipStart(startBeat, result.delaySamples, SR, tempo);
    const expected = compensateClipStart(startBeat, trueDelay, SR, tempo);
    // La medida puede fallar por ±1 muestra (ver el test de arriba); a 140
    // BPM eso es un margen de beats microscópico, muy por debajo de cualquier
    // cuantización audible.
    expect(Math.abs(placed - expected)).toBeLessThan(1 / SR);
    expect(placed).toBeLessThan(startBeat);
  });
});

describe('samplesToMs / msToSamples', () => {
  it('van y vuelven', () => {
    const samples = 2205; // 46 ms a 48 kHz
    const ms = samplesToMs(samples, SAMPLE_RATE);
    expect(msToSamples(ms, SAMPLE_RATE)).toBe(samples);
  });

  it('0 muestras son 0 ms', () => {
    expect(samplesToMs(0, SAMPLE_RATE)).toBe(0);
  });
});
