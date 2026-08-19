/**
 * Las medidas no pueden mentir cuando el material es raro.
 *
 * `analyzeMix` mide en bloques de 400 ms con gating. Si no cabe ni un bloque
 * devolvía el centinela -70 LUFS, y `gainToTarget` lo traducía en un
 * tranquilísimo "+56 dB" que se aplica SIN limitador: exportar con "Normalizar"
 * una selección de menos de medio segundo multiplicaba la señal por 631.
 */

import { describe, expect, it } from 'vitest';
import { analyzeMix, gainToTarget } from '../src/render/analysis';
import { detectPitchTrack } from '../src/render/pitch';

const SR = 44100;

/** Seno de 997 Hz a la amplitud que se pida. */
function tone(seconds: number, amp = 1): { left: Float32Array; right: Float32Array } {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  for (let i = 0; i < n; i++) left[i] = amp * Math.sin((2 * Math.PI * 997 * i) / SR);
  return { left, right: left.slice() };
}

describe('analyzeMix con material corto', () => {
  it('media negra a 120 BPM: la ganancia de normalizado es sensata, no +56 dB', () => {
    const { left, right } = tone(0.25);
    const analysis = analyzeMix(left, right, SR);
    expect(analysis.lufsIntegrated).toBeGreaterThan(-10);
    const gain = gainToTarget(analysis, -14);
    expect(gain).toBeLessThan(0);
    expect(gain).toBeGreaterThan(-20);
  });

  it('la medida no da un salto entre 0,45 s y 0,50 s', () => {
    const corto = analyzeMix(...bothOf(tone(0.45)), SR).lufsIntegrated;
    const largo = analyzeMix(...bothOf(tone(0.5)), SR).lufsIntegrated;
    expect(Math.abs(corto - largo)).toBeLessThan(1.5);
  });

  it('normalizar nunca pide más ganancia de la que cabe antes de clipear', () => {
    const { left, right } = tone(2, 0.9);
    const analysis = analyzeMix(left, right, SR);
    const gain = gainToTarget(analysis, 0);
    expect(gain).toBeLessThanOrEqual(-analysis.peakDb + 1e-9);
  });

  it('silencio absoluto sigue siendo silencio (no se le inventa nivel)', () => {
    const n = SR;
    const zeros = new Float32Array(n);
    const analysis = analyzeMix(zeros, zeros.slice(), SR);
    expect(analysis.lufsIntegrated).toBeLessThan(-60);
  });

  it('canales de distinto tamaño no propagan NaN', () => {
    const { left } = tone(1);
    const right = new Float32Array(SR / 2);
    const analysis = analyzeMix(left, right, SR);
    expect(Number.isFinite(analysis.stereoCorrelation)).toBe(true);
    expect(Number.isFinite(analysis.bands.low)).toBe(true);
    expect(Number.isFinite(analysis.lufsIntegrated)).toBe(true);
  });
});

describe('detectPitchTrack en rangos y frecuencias de muestreo raras', () => {
  it('96 kHz con un rango grave no revienta', () => {
    const mono = new Float32Array(96000);
    for (let i = 0; i < mono.length; i++) mono[i] = Math.sin((2 * Math.PI * 35 * i) / 96000);
    expect(() => detectPitchTrack(mono, 96000, { minHz: 30, maxHz: 40 })).not.toThrow();
  });

  it('48 kHz con un rango muy grave tampoco', () => {
    const mono = new Float32Array(48000);
    expect(() => detectPitchTrack(mono, 48000, { minHz: 20, maxHz: 22 })).not.toThrow();
  });

  it('el caso de siempre (44,1 kHz, 70-1000 Hz) sigue encontrando el tono', () => {
    const mono = new Float32Array(SR);
    for (let i = 0; i < mono.length; i++) mono[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
    const track = detectPitchTrack(mono, SR);
    const sonoros = [...track.f0].filter((f) => f > 0);
    expect(sonoros.length).toBeGreaterThan(0);
    const media = sonoros.reduce((a, b) => a + b, 0) / sonoros.length;
    expect(media).toBeGreaterThan(210);
    expect(media).toBeLessThan(230);
  });
});

function bothOf(t: { left: Float32Array; right: Float32Array }): [Float32Array, Float32Array] {
  return [t.left, t.right];
}
