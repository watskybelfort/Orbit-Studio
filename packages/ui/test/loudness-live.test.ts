/**
 * El LUFS en vivo (`state/loudness-meter.ts`) tiene que coincidir con el
 * offline de `analyzeMix` (`engine/render/analysis.ts`) sobre el MISMO
 * material: es la prueba de que el gating de dos pasos, hecho a trozos según
 * llega el audio, no diverge del cálculo de una sola pasada que ya usa el
 * export para normalizar a -14 LUFS.
 *
 * Tolerancia: 0,1 LU. El algoritmo es el mismo bloque a bloque (mismos
 * coeficientes de K-weighting, mismo bloque de 400 ms / salto de 100 ms,
 * mismo gate -70 absoluto / -10 relativo); la única fuente de diferencia es
 * el orden de suma en coma flotante al trocear el material en chunks de
 * distinto tamaño, así que 0,1 LU es generoso de sobra — si algún día no
 * coincide dentro de esto, el problema es real, no ruido de redondeo.
 */

import { analyzeMix } from '@orbit/engine';
import { describe, expect, it } from 'vitest';
import { LiveLoudnessMeter } from '../src/state/loudness-meter';

const SR = 48000;
const TOLERANCE_LU = 0.1;

/**
 * Material "de mezcla": un bombo/808 grave con envolvente percusiva a 100 BPM
 * más una capa de agudos, con la mitad final bastante más floja para obligar
 * al gate relativo (-10 LU) a excluir bloques, que es donde más fácil
 * divergiría un gating hecho a trozos del de una sola pasada.
 */
function mixLikeSignal(seconds: number, quietFrom: number): { left: Float32Array; right: Float32Array } {
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const beatSec = 0.6;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const quiet = t >= quietFrom;
    const beatPhase = (t % beatSec) / beatSec;
    const env = Math.exp(-beatPhase * 9);
    const low = 0.75 * Math.sin(2 * Math.PI * 58 * t) * env;
    const hi = 0.2 * Math.sin(2 * Math.PI * 2400 * t) * env * 0.5;
    const amp = quiet ? 0.12 : 1;
    const s = (low + hi) * amp;
    left[i] = s;
    right[i] = s;
  }
  return { left, right };
}

/** Alimenta el medidor en vivo a trozos de `chunk` muestras (como llegaría del tap del kernel). */
function pushInChunks(meter: LiveLoudnessMeter, left: Float32Array, right: Float32Array, chunk: number): void {
  for (let off = 0; off < left.length; off += chunk) {
    const end = Math.min(left.length, off + chunk);
    meter.push(left.subarray(off, end), right.subarray(off, end));
  }
}

describe('LiveLoudnessMeter vs analyzeMix (mismo material)', () => {
  it('integrado en vivo, a trozos de 2048 (el tamaño real del tap), coincide con el offline', () => {
    const { left, right } = mixLikeSignal(6, 4);
    const offline = analyzeMix(left, right, SR);

    const meter = new LiveLoudnessMeter(SR);
    pushInChunks(meter, left, right, 2048);
    const live = meter.snapshot();

    expect(live.integrated).not.toBeNull();
    expect(Math.abs(live.integrated! - offline.lufsIntegrated)).toBeLessThan(TOLERANCE_LU);
  });

  it('el resultado no depende del tamaño del trozo (128, 512, 4096 muestras)', () => {
    const { left, right } = mixLikeSignal(5, 3);
    const offline = analyzeMix(left, right, SR).lufsIntegrated;

    for (const chunk of [128, 512, 4096]) {
      const meter = new LiveLoudnessMeter(SR);
      pushInChunks(meter, left, right, chunk);
      const live = meter.snapshot().integrated;
      expect(live).not.toBeNull();
      expect(Math.abs(live! - offline)).toBeLessThan(TOLERANCE_LU);
    }
  });

  it('pushMono (la vía real: el tap del kernel manda L+R/2) coincide igual con material centrado', () => {
    // El tap en vivo solo manda mono, así que la UI llama a pushMono(). Con
    // una fuente ya centrada (L === R, el caso de prueba de arriba) alimentar
    // dual-mono es MATEMÁTICAMENTE lo mismo que el estéreo real: es la
    // aproximación que documenta pushMono, y este es el caso en el que es
    // exacta, no solo razonable.
    const { left } = mixLikeSignal(5, 3);
    const offline = analyzeMix(left, left.slice(), SR).lufsIntegrated;

    const meter = new LiveLoudnessMeter(SR);
    for (let off = 0; off < left.length; off += 2048) {
      meter.pushMono(left.subarray(off, Math.min(left.length, off + 2048)));
    }
    const live = meter.snapshot().integrated;
    expect(live).not.toBeNull();
    expect(Math.abs(live! - offline)).toBeLessThan(TOLERANCE_LU);
  });

  it('short-term y true-peak salen finitos y con relación sensata con el pico simple', () => {
    const { left, right } = mixLikeSignal(4, 3);
    const offline = analyzeMix(left, right, SR);

    const meter = new LiveLoudnessMeter(SR);
    pushInChunks(meter, left, right, 2048);
    const live = meter.snapshot();

    expect(live.shortTerm).not.toBeNull();
    expect(Number.isFinite(live.shortTerm!)).toBe(true);
    expect(Number.isFinite(live.truePeak)).toBe(true);
    // El true-peak (con sobremuestreo) nunca puede quedar POR DEBAJO del pico
    // de muestra simple que ya mide analysis.ts: como mucho, lo iguala.
    expect(live.truePeak).toBeGreaterThanOrEqual(offline.peakDb - 1e-6);
  });

  it('silencio sigue siendo silencio (no inventa nivel) y no revienta con longitud 0', () => {
    const zeros = new Float32Array(SR);
    const meter = new LiveLoudnessMeter(SR);
    meter.push(zeros, zeros.slice());
    const live = meter.snapshot();
    expect(live.integrated).toBeLessThan(-60);

    const empty = new LiveLoudnessMeter(SR);
    expect(() => empty.push(new Float32Array(0), new Float32Array(0))).not.toThrow();
    expect(empty.snapshot().integrated).toBeNull();
  });

  it('reset() vuelve a un medidor limpio (mismo resultado que uno recién creado)', () => {
    const { left, right } = mixLikeSignal(3, 2);
    const meter = new LiveLoudnessMeter(SR);
    pushInChunks(meter, left, right, 2048);
    meter.reset();
    pushInChunks(meter, left, right, 2048);
    const afterReset = meter.snapshot().integrated;

    const fresh = new LiveLoudnessMeter(SR);
    pushInChunks(fresh, left, right, 2048);
    const cleanRun = fresh.snapshot().integrated;

    expect(afterReset).not.toBeNull();
    expect(Math.abs(afterReset! - cleanRun!)).toBeLessThan(1e-9);
  });
});
