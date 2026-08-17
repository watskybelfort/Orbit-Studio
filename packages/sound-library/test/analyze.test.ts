/**
 * Tests del análisis automático (analyze.ts) con señales sintéticas: un click
 * periódico a 120 BPM (y a otros tempos), un acorde de Do mayor y uno de La
 * menor. Todo determinista: el ruido usa un PRNG con semilla fija.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeSample,
  chromagram,
  detectBpm,
  detectKey,
  NOTE_NAMES,
  onsetEnvelope,
  toMono,
} from '../src/analyze';

const SR = 44100;

// ── Generadores de señal ─────────────────────────────────────────────────────

/** PRNG mulberry32: ruido reproducible entre ejecuciones. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Click periódico: golpe de ruido con caída exponencial más un tono corto,
 * repetido al tempo pedido. Es el caso de libro para la autocorrelación.
 */
function clickTrain(bpm: number, seconds: number, seed = 7): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const rnd = rng(seed);
  const period = (60 / bpm) * SR;
  const decay = 0.012 * SR;
  for (let hit = 0; ; hit++) {
    const start = Math.round(hit * period);
    if (start >= n) break;
    for (let i = 0; i < decay * 5 && start + i < n; i++) {
      const env = Math.exp(-i / decay);
      const noise = rnd() * 2 - 1;
      const tone = Math.sin((2 * Math.PI * 180 * i) / SR);
      out[start + i] = out[start + i]! + env * (0.6 * noise + 0.4 * tone);
    }
  }
  return out;
}

/** Nota con 4 armónicos decrecientes (más parecido a un instrumento real). */
function note(hz: number, seconds: number, amp = 0.25): Float32Array {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const partials = [1, 0.42, 0.22, 0.12];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let p = 0; p < partials.length; p++) {
      v += partials[p]! * Math.sin((2 * Math.PI * hz * (p + 1) * i) / SR);
    }
    // Fundido de entrada/salida para que no haya clicks en los bordes.
    const fade = Math.min(1, i / (0.02 * SR), (n - 1 - i) / (0.02 * SR));
    out[i] = amp * v * fade;
  }
  return out;
}

function mix(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] = out[i]! + p[i]!;
  return out;
}

/** Frecuencia de una nota por su nombre y octava (A4 = 440). */
function hz(name: string, octave: number): number {
  const pc = NOTE_NAMES.indexOf(name as (typeof NOTE_NAMES)[number]);
  if (pc < 0) throw new Error(`nota desconocida: ${name}`);
  const midi = (octave + 1) * 12 + pc;
  return 440 * Math.pow(2, (midi - 69) / 12);
}

const chord = (notes: [string, number][], seconds = 4): Float32Array =>
  mix(...notes.map(([n, o]) => note(hz(n, o), seconds)));

// ── BPM ──────────────────────────────────────────────────────────────────────

describe('detectBpm', () => {
  it('clava 120 BPM en un click periódico (±2)', () => {
    const est = detectBpm(clickTrain(120, 8), SR);
    expect(est).not.toBeNull();
    expect(est!.bpm).toBeGreaterThan(118);
    expect(est!.bpm).toBeLessThan(122);
    expect(est!.confidence).toBeGreaterThan(0.5);
  });

  it('acierta otros tempos del rango (±2)', () => {
    for (const bpm of [75, 90, 100, 140, 160]) {
      const est = detectBpm(clickTrain(bpm, 10), SR);
      expect(est, `sin estimación a ${bpm} BPM`).not.toBeNull();
      expect(Math.abs(est!.bpm - bpm), `error a ${bpm} BPM: ${est!.bpm}`).toBeLessThanOrEqual(2);
    }
  });

  it('resuelve la ambigüedad de octava: 160 no se lee como 80', () => {
    const est = detectBpm(clickTrain(160, 10), SR);
    expect(est).not.toBeNull();
    expect(Math.abs(est!.bpm - 160)).toBeLessThanOrEqual(2);
  });

  it('desempata con el cuadre en compases cuando el pico es plano', () => {
    // Pad sostenido de 4 compases a 128 BPM: 4·4·60/128 = 7,5 s exactos. Sin
    // ataques marcados la autocorrelación da una meseta; el cuadre decide.
    const dur = (4 * 4 * 60) / 128;
    const pad = chord([['D', 3], ['F', 3], ['A', 3]], dur);
    const pulso = clickTrain(128, dur, 11);
    for (let i = 0; i < pad.length; i++) pad[i] = pad[i]! + 0.25 * pulso[i]!;
    const est = detectBpm(pad, SR);
    expect(est).not.toBeNull();
    expect(Math.abs(est!.bpm - 128)).toBeLessThanOrEqual(2);
    // Con el cuadre desactivado el detector solo mira la autocorrelación.
    expect(detectBpm(pad, SR, { barPrior: false })).not.toBeNull();
  });

  it('no inventa tempo con silencio ni con audio demasiado corto', () => {
    expect(detectBpm(new Float32Array(SR * 4), SR)).toBeNull();
    expect(detectBpm(clickTrain(120, 0.5), SR)).toBeNull();
  });

  it('no da tempo a un one-shot ni a una nota sostenida sin ataques', () => {
    // Un solo golpe con cola: la autocorrelación saca lags "buenos" igual, así
    // que el portero es el número de ataques, no la correlación.
    const golpe = new Float32Array(SR * 3);
    const decay = 0.05 * SR;
    for (let i = 0; i < decay * 12; i++) {
      golpe[i] = Math.exp(-i / decay) * Math.sin((2 * Math.PI * 55 * i) / SR);
    }
    expect(detectBpm(golpe, SR)).toBeNull();
    expect(detectBpm(note(hz('C', 3), 4), SR)).toBeNull();
  });

  it('la envolvente de onsets marca un golpe por click', () => {
    const { values, rate } = onsetEnvelope(clickTrain(120, 4), SR);
    expect(rate).toBeCloseTo(SR / 256, 3);
    // Disparo con periodo refractario de 0.2 s: un click deja varios frames
    // activos (el ruido decae ~60 ms), lo que interesa es cuántos ataques hay.
    let max = 0;
    for (const v of values) if (v > max) max = v;
    const umbral = max * 0.35;
    const refract = Math.round(0.2 * rate);
    let golpes = 0;
    let bloqueoHasta = -1;
    for (let i = 0; i < values.length; i++) {
      if (i > bloqueoHasta && values[i]! > umbral) {
        golpes++;
        bloqueoHasta = i + refract;
      }
    }
    // 8 golpes en 4 s a 120 BPM (el último puede caer fuera del último frame).
    expect(golpes).toBeGreaterThanOrEqual(7);
    expect(golpes).toBeLessThanOrEqual(8);
  });
});

// ── Tonalidad ────────────────────────────────────────────────────────────────

describe('detectKey', () => {
  it('reconoce un acorde de Do mayor', () => {
    const est = detectKey(chord([['C', 4], ['E', 4], ['G', 4]]), SR);
    expect(est).not.toBeNull();
    expect(est!.keyRoot).toBe('C');
    expect(est!.mode).toBe('major');
    expect(est!.confidence).toBeGreaterThan(0.3);
  });

  it('reconoce un acorde de La menor', () => {
    const est = detectKey(chord([['A', 3], ['C', 4], ['E', 4]]), SR);
    expect(est).not.toBeNull();
    expect(est!.keyRoot).toBe('A');
    expect(est!.mode).toBe('minor');
    expect(est!.confidence).toBeGreaterThan(0.3);
  });

  it('reconoce una raíz con sostenido (Fa# menor)', () => {
    const est = detectKey(chord([['F#', 3], ['A', 3], ['C#', 4]]), SR);
    expect(est).not.toBeNull();
    expect(est!.keyRoot).toBe('F#');
    expect(est!.mode).toBe('minor');
  });

  it('lee la nota de un sub tipo 808 por su fundamental, no por la quinta', () => {
    // 808 en C1 (32,7 Hz): con una ventana corta el fundamental se pierde en la
    // fuga espectral y el croma se quedaba con el tercer armónico (G).
    const sub = note(hz('C', 1), 2.5, 0.8);
    const c = chromagram(sub, SR);
    let max = 0;
    let idx = -1;
    for (let i = 0; i < 12; i++) {
      if (c[i]! > max) {
        max = c[i]!;
        idx = i;
      }
    }
    expect(NOTE_NAMES[idx]).toBe('C');
  });

  it('el croma pone la energía en las notas del acorde', () => {
    const c = chromagram(chord([['C', 4], ['E', 4], ['G', 4]]), SR);
    const idx = [...c.keys()].sort((a, b) => c[b]! - c[a]!).slice(0, 3);
    expect(new Set(idx)).toEqual(new Set([0, 4, 7])); // C, E, G
  });

  it('no inventa tonalidad con silencio', () => {
    expect(detectKey(new Float32Array(SR * 4), SR)).toBeNull();
  });
});

// ── Fachada ──────────────────────────────────────────────────────────────────

describe('analyzeSample', () => {
  it('devuelve BPM y tonalidad de un loop tonal con pulso', () => {
    const loop = mix(clickTrain(120, 8), chord([['A', 3], ['C', 4], ['E', 4]], 8));
    const a = analyzeSample(loop, SR);
    expect(a.bpm).toBeDefined();
    expect(Math.abs(a.bpm! - 120)).toBeLessThanOrEqual(2);
    expect(a.keyRoot).toBe('A');
    expect(a.mode).toBe('minor');
  });

  it('deja los campos vacíos si la señal no da para estimar', () => {
    const a = analyzeSample(new Float32Array(SR * 3), SR);
    expect(a.bpm).toBeUndefined();
    expect(a.keyRoot).toBeUndefined();
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

describe('toMono', () => {
  it('promedia los dos canales', () => {
    const l = Float32Array.from([1, 0, -1]);
    const r = Float32Array.from([0, 1, -1]);
    expect([...toMono(l, r)]).toEqual([0.5, 0.5, -1]);
  });

  it('devuelve el canal tal cual si es mono', () => {
    const l = Float32Array.from([0.5]);
    expect(toMono(l)).toBe(l);
  });
});
