/**
 * Tests del analizador de audio del motor (`analysis/`): tempo y tonalidad
 * sobre señales sintéticas que imitan el flujo de Orbit (boom bap, trap,
 * reggaetón) y sobre los casos donde un detector naíf se equivoca: síncopa,
 * mitad/doble, intro ambient, 808, afinación corrida y ruido.
 *
 * Las señales son deterministas (PRNG con semilla fija), así que cualquier
 * regresión de la métrica o del croma rompe un test concreto.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeAudio,
  analyzeStereo,
  estimateKey,
  estimateTempo,
  MAX_GRID_BEATS,
  NOTE_NAMES,
} from '../src/analysis/index';

const SR = 44100;

// ── Señales ──────────────────────────────────────────────────────────────────

/** PRNG mulberry32: reproducible entre ejecuciones. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bombo: seno grave con caída de frecuencia y de amplitud. */
function addKick(out: Float32Array, at: number, amp = 0.95): void {
  const n = out.length;
  const len = Math.floor(0.12 * SR);
  for (let i = 0; i < len && at + i < n; i++) {
    const t = i / SR;
    const hz = 48 + 90 * Math.exp(-t * 30);
    out[at + i] = out[at + i]! + amp * Math.exp(-t * 18) * Math.sin(2 * Math.PI * hz * t);
  }
}

/** Caja: ruido con caída rápida + un tono corto. */
function addSnare(out: Float32Array, at: number, rnd: () => number, amp = 0.55): void {
  const n = out.length;
  const len = Math.floor(0.09 * SR);
  for (let i = 0; i < len && at + i < n; i++) {
    const env = Math.exp(-i / (0.025 * SR));
    const body = Math.sin((2 * Math.PI * 190 * i) / SR);
    out[at + i] = out[at + i]! + amp * env * (0.75 * (rnd() * 2 - 1) + 0.25 * body);
  }
}

/** Hat: ruido muy corto; es el tatum que tienta al detector a doblar. */
function addHat(out: Float32Array, at: number, rnd: () => number, amp = 0.16): void {
  const n = out.length;
  const len = Math.floor(0.03 * SR);
  for (let i = 0; i < len && at + i < n; i++) {
    out[at + i] = out[at + i]! + amp * Math.exp(-i / (0.006 * SR)) * (rnd() * 2 - 1);
  }
}

/**
 * Beat de 4/4: bombo en 1 y 3, caja en 2 y 4, hats en corcheas. Es el patrón
 * con el que el detector tiene que decidir el NIVEL (pulso, mitad o doble).
 */
function beat(bpm: number, seconds: number, seed = 3): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const rnd = rng(seed);
  const period = (60 / bpm) * SR;
  for (let b = 0; ; b++) {
    const at = Math.round(b * period);
    if (at >= out.length) break;
    const inBar = b % 4;
    if (inBar === 0 || inBar === 2) addKick(out, at);
    else addSnare(out, at, rnd);
    addHat(out, at, rnd, 0.16);
    addHat(out, Math.round(at + period / 2), rnd, 0.1);
  }
  return out;
}

/**
 * Trap: bombo sincopado (tresillo 3+3+2) y hats en semicorcheas. La síncopa
 * hace que la autocorrelación tenga un pico fuerte a 4/3 del pulso real; el test
 * de 85 BPM es el que caza ese error.
 */
function trap(bpm: number, seconds: number, seed = 5): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const rnd = rng(seed);
  const period = (60 / bpm) * SR;
  const kicks = new Set([0, 3, 6, 8, 11, 14]);
  for (let bar = 0; ; bar++) {
    const barAt = Math.round(bar * 4 * period);
    if (barAt >= out.length) break;
    for (let step = 0; step < 16; step++) {
      const at = Math.round(barAt + (step * period) / 4);
      if (kicks.has(step)) addKick(out, at, 0.9);
      if (step === 4 || step === 12) addSnare(out, at, rnd, 0.6);
      addHat(out, at, rnd, step % 2 === 0 ? 0.16 : 0.09);
    }
  }
  return out;
}

/** Nota con cuatro armónicos decrecientes (más parecida a un instrumento). */
function tone(hz: number, seconds: number, amp = 0.2): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SR));
  const partials = [1, 0.45, 0.22, 0.12];
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let p = 0; p < partials.length; p++) {
      v += partials[p]! * Math.sin((2 * Math.PI * hz * (p + 1) * i) / SR);
    }
    const fade = Math.min(1, i / (0.02 * SR), (out.length - 1 - i) / (0.02 * SR));
    out[i] = amp * v * fade;
  }
  return out;
}

/** Frecuencia de una nota (A4 = 440), con desafinación opcional en cents. */
function hzOf(name: string, octave: number, cents = 0): number {
  const pc = NOTE_NAMES.indexOf(name as (typeof NOTE_NAMES)[number]);
  return 440 * Math.pow(2, ((octave + 1) * 12 + pc - 69) / 12 + cents / 1200);
}

function mix(parts: Float32Array[], seconds?: number): Float32Array {
  const n = seconds ? Math.floor(seconds * SR) : Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const part of parts) {
    for (let i = 0; i < part.length && i < n; i++) out[i] = out[i]! + part[i]!;
  }
  return out;
}

function addAt(out: Float32Array, src: Float32Array, atSec: number): void {
  const from = Math.round(atSec * SR);
  for (let i = 0; i < src.length && from + i < out.length; i++) out[from + i] = out[from + i]! + src[i]!;
}

/** Progresión I–V–vi–IV (mayor) o i–v–VI–iv (menor) con bajo en la tónica. */
function progression(root: number, mode: 'major' | 'minor', seconds: number): Float32Array {
  const major = [0, 2, 4, 5, 7, 9, 11];
  const minor = [0, 2, 3, 5, 7, 8, 10];
  const scale = mode === 'major' ? major : minor;
  const degrees = [0, 4, 5, 3];
  const chordDur = seconds / degrees.length;
  const out = new Float32Array(Math.floor(seconds * SR));
  const noteName = (pc: number): string => NOTE_NAMES[(((root + pc) % 12) + 12) % 12]!;
  degrees.forEach((degree, index) => {
    const at = index * chordDur;
    const base = scale[degree]!;
    const third = scale[(degree + 2) % 7]!;
    const fifth = scale[(degree + 4) % 7]!;
    for (const [pc, octave] of [
      [base, 3],
      [third, 4],
      [fifth, 4],
    ] as [number, number][]) {
      addAt(out, tone(hzOf(noteName(pc), octave), chordDur, 0.16), at);
    }
    addAt(out, tone(hzOf(noteName(base), 2), chordDur, 0.35), at);
  });
  return out;
}

/** ¿El tempo medido es el mismo pulso, su mitad o su doble? */
function metricalFamily(detected: number, expected: number): boolean {
  const ratio = detected / expected;
  return Math.abs(ratio - 1) <= 0.03 || Math.abs(ratio - 2) <= 0.06 || Math.abs(ratio - 0.5) <= 0.03;
}

// ── Tempo ────────────────────────────────────────────────────────────────────

describe('tempo', () => {
  it('mide de 70 a 200 BPM sin salir de la familia métrica', { timeout: 20_000 }, () => {
    for (const bpm of [70, 72, 78, 84, 85, 90, 96, 100, 105, 115, 125, 132, 144, 152, 160, 174, 186, 196]) {
      const result = analyzeAudio(beat(bpm, 12), SR).tempo;
      expect(result, `sin tempo a ${bpm} BPM`).not.toBeNull();
      expect(
        metricalFamily(result!.bpm, bpm),
        `a ${bpm} BPM midió ${result!.bpm.toFixed(2)} (no es 1×, 2× ni ½)`,
      ).toBe(true);
    }
  });

  it('clava los tempos del flujo de producción (85–160) en la lectura natural', () => {
    for (const bpm of [85, 90, 100, 120, 128, 140, 160]) {
      const result = analyzeAudio(beat(bpm, 12), SR).tempo!;
      expect(Math.abs(result.bpm - bpm), `a ${bpm} BPM midió ${result.bpm.toFixed(2)}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('no confunde la síncopa del trap con un tempo a 4/3 del real', () => {
    // En el patrón de trap el bombo hace 3+3+2 semicorcheas: la
    // autocorrelación tiene un pico en el pulso de negra con puntillo. Medir
    // 113,36 en un tema de 85 es el error que este test impide.
    for (const bpm of [85, 90, 100, 120, 128, 140, 150, 160]) {
      const result = analyzeAudio(trap(bpm, 12), SR).tempo!;
      expect(Math.abs(result.bpm - bpm), `trap a ${bpm} BPM midió ${result.bpm.toFixed(2)}`).toBeLessThanOrEqual(1.5);
    }
  });

  it('cuando la síncopa es 174 la lectura de 87 es la misma rejilla', () => {
    const result = analyzeAudio(trap(174, 12), SR).tempo!;
    expect(metricalFamily(result.bpm, 174)).toBe(true);
    expect(result.candidates.some((c) => Math.abs(c.bpm - 174) <= 1.5)).toBe(true);
  });

  it('expone la mitad y el doble como alternativas, no como errores', () => {
    const slow = analyzeAudio(beat(85, 12), SR).tempo!;
    expect(slow.candidates.some((c) => Math.abs(c.bpm - 170) <= 1.5)).toBe(true);
    const fast = analyzeAudio(beat(140, 12), SR).tempo!;
    expect(fast.candidates.some((c) => Math.abs(c.bpm - 70) <= 1.5)).toBe(true);
  });

  it('la rejilla cae sobre los ataques y el periodo es el del tempo', () => {
    const tempo = analyzeAudio(beat(120, 8), SR).tempo!;
    expect(tempo.grid.beatPeriodSec).toBeCloseTo(0.5, 1);
    expect(tempo.grid.beatsPerBar).toBe(4);
    expect(tempo.grid.beatTimes.length).toBeGreaterThan(8);
    expect(tempo.grid.beatTimes.length).toBeLessThanOrEqual(MAX_GRID_BEATS);
    // La envolvente marca el ataque al principio de la ventana de FFT, así que
    // el pulso puede adelantarse hasta ~45 ms; nunca más.
    for (const t of tempo.grid.beatTimes.slice(0, 12)) {
      const error = Math.abs(t - Math.round(t / 0.5) * 0.5);
      expect(error, `pulso en ${t.toFixed(3)} s`).toBeLessThan(0.06);
    }
    expect(tempo.grid.downbeatSec).toBeGreaterThanOrEqual(tempo.grid.offsetSec - 0.001);
  });

  it('elige el tramo con pulso en un tema con intro y outro ambient', { timeout: 20_000 }, () => {
    const track = new Float32Array(Math.floor(140 * SR));
    addAt(track, mix([tone(hzOf('F', 3), 40, 0.12)]), 0);
    addAt(track, beat(144, 60), 40);
    addAt(track, mix([tone(hzOf('F', 3), 40, 0.12)]), 100);
    const analysis = analyzeAudio(track, SR);
    expect(analysis.tempo).not.toBeNull();
    expect(metricalFamily(analysis.tempo!.bpm, 144)).toBe(true);
    // La rejilla se extiende por el tema (puede empezar antes del cuerpo), así
    // que lo que importa es que cubra el tramo del beat y que el análisis no
    // haya tenido que escuchar los 140 s enteros.
    expect(analysis.tempo!.grid.beatTimes.some((t) => t >= 40 && t < 100)).toBe(true);
    expect(analysis.tempo!.grid.beatTimes.length).toBeGreaterThan(100);
    expect(analysis.analyzedSec).toBeLessThanOrEqual(121);
    expect(analysis.durationSec).toBeCloseTo(140, 0);
  });

  it('no inventa pulso en un one-shot, una nota sostenida ni silencio', () => {
    const oneShot = new Float32Array(Math.floor(3 * SR));
    addKick(oneShot, 0, 1);
    expect(analyzeAudio(oneShot, SR).tempo).toBeNull();
    expect(analyzeAudio(tone(hzOf('C', 3), 4), SR).tempo).toBeNull();
    expect(analyzeAudio(new Float32Array(Math.floor(4 * SR)), SR).tempo).toBeNull();
  });

  it('trabaja igual a 48 kHz y en estéreo', () => {
    const signal = beat(120, 8);
    const stereo = analyzeStereo(signal, signal.slice(), SR);
    expect(stereo.tempo).not.toBeNull();
    expect(Math.abs(stereo.tempo!.bpm - 120)).toBeLessThanOrEqual(1.5);
    expect(stereo.key?.name).toBe(analyzeAudio(signal, SR).key?.name);

    const at48 = new Float32Array(Math.ceil((signal.length * 48000) / SR));
    for (let i = 0; i < at48.length; i++) {
      const pos = (i * SR) / 48000;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      at48[i] = (signal[i0] ?? 0) * (1 - frac) + (signal[i0 + 1] ?? 0) * frac;
    }
    const tempo48 = analyzeAudio(at48, 48000).tempo;
    expect(tempo48).not.toBeNull();
    expect(Math.abs(tempo48!.bpm - 120)).toBeLessThanOrEqual(1.5);
  });

  it('es determinista: la misma señal da el mismo resultado', () => {
    const signal = trap(128, 6);
    const a = analyzeAudio(signal, SR);
    const b = analyzeAudio(signal, SR);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const c = estimateTempo(signal, SR);
    expect(c?.bpm).toBe(a.tempo?.bpm);
  });
});

// ── Tonalidad ────────────────────────────────────────────────────────────────

describe('tonalidad', () => {
  it('acierta las 24 tonalidades en progresiones (I)', { timeout: 20_000 }, () => {
    for (let root = 0; root < 6; root++) {
      for (const mode of ['major', 'minor'] as const) {
        const key = analyzeAudio(progression(root, mode, 8), SR).key;
        const expected = `${NOTE_NAMES[root]} ${mode === 'major' ? 'mayor' : 'menor'}`;
        expect(key, `${expected} sin estimación`).not.toBeNull();
        expect(key!.name, `se esperaba ${expected}`).toBe(expected);
        expect(key!.confidence).toBeGreaterThan(0.4);
      }
    }
  });

  it('acierta las 24 tonalidades en progresiones (II)', { timeout: 20_000 }, () => {
    for (let root = 6; root < 12; root++) {
      for (const mode of ['major', 'minor'] as const) {
        const key = analyzeAudio(progression(root, mode, 8), SR).key;
        const expected = `${NOTE_NAMES[root]} ${mode === 'major' ? 'mayor' : 'menor'}`;
        expect(key, `${expected} sin estimación`).not.toBeNull();
        expect(key!.name, `se esperaba ${expected}`).toBe(expected);
        expect(key!.confidence).toBeGreaterThan(0.4);
      }
    }
  });

  it('calcula Camelot y alternativas coherentes', () => {
    const c = analyzeAudio(progression(0, 'major', 8), SR).key!;
    expect(c.camelot).toBe('8B');
    const am = analyzeAudio(progression(9, 'minor', 8), SR).key!;
    expect(am.camelot).toBe('8A');
    const fsm = analyzeAudio(progression(6, 'minor', 8), SR).key!;
    expect(fsm.camelot).toBe('11A');
    expect(c.alternatives.length).toBeGreaterThan(0);
    expect(c.alternatives.every((alt) => alt.name !== c.name)).toBe(true);
    expect(c.alternatives.every((alt) => alt.camelot.length >= 2)).toBe(true);
  });

  it('mide la afinación y no pierde la tonalidad con el tema corrido', () => {
    for (const cents of [-40, -18, 17, 35]) {
      const signal = mix([
        tone(hzOf('A', 2, cents), 4, 0.35),
        tone(hzOf('A', 3, cents), 4, 0.2),
        tone(hzOf('C', 4, cents), 4, 0.2),
        tone(hzOf('E', 4, cents), 4, 0.2),
      ]);
      const key = analyzeAudio(signal, SR).key!;
      expect(key.name, `a ${cents} cents`).toBe('A menor');
      expect(Math.abs(key.tuningCents - cents), `afinación a ${cents} cents: ${key.tuningCents.toFixed(1)}`).toBeLessThanOrEqual(3);
    }
  });

  it('lee la nota de un 808 por su fundamental', () => {
    const sub = tone(hzOf('D', 1), 2.5, 0.8);
    const key = analyzeAudio(sub, SR).key;
    expect(key).not.toBeNull();
    expect(NOTE_NAMES[key!.root]).toBe('D');
    expect(analyzeAudio(sub, SR).tempo).toBeNull();
    // Un solo 808 no tiene tercera: el MODO no puede tener la confianza de un
    // acorde completo.
    expect(key!.confidence).toBeLessThan(0.4);
  });

  it('no da una tonalidad con ruido ni con un one-shot sin altura clara', () => {
    const rnd = rng(99);
    const noise = new Float32Array(Math.floor(5 * SR));
    for (let i = 0; i < noise.length; i++) noise[i] = (rnd() * 2 - 1) * 0.25;
    const analysis = analyzeAudio(noise, SR, { minKeyConfidence: 0.34 });
    expect(analysis.key).toBeNull();
    expect(analysis.tempo).toBeNull();

    const click = beat(120, 6, 9);
    const clickKey = analyzeAudio(click, SR).key;
    // La percusión no debe producir una tonalidad con confianza alta.
    expect(clickKey === null || clickKey.confidence < 0.4).toBe(true);
  });

  it('devuelve la tonalidad y el tempo por separado cuando se piden', () => {
    const loop = mix([beat(96, 8), progression(9, 'minor', 8)]);
    const tempo = estimateTempo(loop, SR);
    const key = estimateKey(loop, SR);
    expect(tempo).not.toBeNull();
    expect(key).not.toBeNull();
    expect(metricalFamily(tempo!.bpm, 96)).toBe(true);
    expect(key!.root).toBe(9);
    expect(key!.mode).toBe('minor');
  });
});
