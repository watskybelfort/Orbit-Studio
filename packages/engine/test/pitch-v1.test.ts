import { describe, expect, it } from 'vitest';
import { correctPitch, detectPitchTrack, scalePitchClasses } from '../src/render/pitch';

const SR = 44100;

/** Tono con armónicos (más parecido a una voz que un seno puro). */
function tone(freq: number, seconds: number, vibratoCents = 0): Float32Array {
  const n = Math.round(seconds * SR);
  const xs = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const cents = vibratoCents * Math.sin(2 * Math.PI * 5 * t);
    const f = freq * Math.pow(2, cents / 1200);
    phase += (2 * Math.PI * f) / SR;
    xs[i] = 0.6 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.1 * Math.sin(3 * phase);
  }
  return xs;
}

/** f0 mediana de la parte estable de la señal. */
function medianF0(xs: Float32Array): number {
  const track = detectPitchTrack(xs, SR);
  const values = Array.from(track.f0).filter((v) => v > 0).sort((a, b) => a - b);
  return values.length ? values[values.length >> 1]! : 0;
}

describe('detectPitchTrack', () => {
  it('clava la frecuencia de un tono estable', () => {
    expect(medianF0(tone(220, 0.6))).toBeCloseTo(220, 0);
    expect(medianF0(tone(440, 0.6))).toBeCloseTo(440, 0);
  });

  it('el silencio no inventa tono', () => {
    const track = detectPitchTrack(new Float32Array(SR), SR);
    expect(Array.from(track.f0).every((v) => v === 0)).toBe(true);
  });

  it('sigue un vibrato sin irse de octava', () => {
    const track = detectPitchTrack(tone(330, 1, 60), SR);
    const values = Array.from(track.f0).filter((v) => v > 0);
    expect(values.length).toBeGreaterThan(10);
    for (const v of values) {
      expect(v).toBeGreaterThan(300);
      expect(v).toBeLessThan(365);
    }
  });
});

describe('correctPitch', () => {
  it('lleva una nota desafinada a la nota más cercana', () => {
    // 448 Hz son 69.31 en MIDI: la nota más cercana es La (440), no La#.
    const xs = tone(448, 0.8);
    const out = correctPitch(xs, xs, SR, { strength: 1, glideSec: 0.005 });
    const corrected = medianF0(out.left);
    expect(Math.abs(corrected - 440)).toBeLessThan(Math.abs(448 - 440));
    expect(corrected).toBeGreaterThan(430);
    expect(corrected).toBeLessThan(446);
  });

  it('no cambia la duración', () => {
    const xs = tone(300, 0.5);
    const out = correctPitch(xs, xs, SR, { strength: 1 });
    expect(out.left.length).toBe(xs.length);
  });

  it('con strength 0 deja el tono como estaba', () => {
    const xs = tone(455, 0.6);
    const out = correctPitch(xs, xs, SR, { strength: 0 });
    expect(medianF0(out.left)).toBeCloseTo(455, -1);
  });

  it('respeta la escala: una nota fuera de ella se va a un grado de la escala', () => {
    // Escala de Do mayor: no tiene Do# (61). Un tono en Do# debe caer en Do o Re.
    const cSharp = 440 * Math.pow(2, (61 - 69) / 12);
    const xs = tone(cSharp, 0.8);
    const out = correctPitch(xs, xs, SR, {
      strength: 1,
      scale: scalePitchClasses(0, 'major'),
      glideSec: 0.005,
    });
    const midi = 69 + 12 * Math.log2(medianF0(out.left) / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    expect(scalePitchClasses(0, 'major')).toContain(pc);
  });

  it('es determinista', () => {
    const xs = tone(300, 0.4);
    const a = correctPitch(xs, xs, SR, { strength: 0.8 });
    const b = correctPitch(xs, xs, SR, { strength: 0.8 });
    expect(Array.from(a.left.subarray(0, 2000))).toEqual(Array.from(b.left.subarray(0, 2000)));
  });
});
