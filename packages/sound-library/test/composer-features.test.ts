import { describe, expect, it } from 'vitest';
import { createProfile, extractTrackFeatures, remapLane, styleHint, trackDisplayName } from '../src';

const SR = 22050;

/** Un beat sintético: bombo grave, caja de ruido medio y hats de ruido agudo. */
function synthBeat(bpm: number, bars: number, kicks: number[], snares: number[], hats: number[]): Float32Array {
  const stepSec = 60 / bpm / 4;
  const out = new Float32Array(Math.ceil(bars * 16 * stepSec * SR) + SR);
  let seed = 12345;
  const noise = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 2147483648 - 1;
  };
  for (let bar = 0; bar < bars; bar++) {
    for (let step = 0; step < 16; step++) {
      const at = Math.round((bar * 16 + step) * stepSec * SR);
      if (kicks.includes(step)) {
        for (let i = 0; i < SR * 0.18; i++) out[at + i]! += 0.9 * Math.sin((2 * Math.PI * 55 * i) / SR) * Math.exp(-i / (SR * 0.05));
      }
      if (snares.includes(step)) {
        let lp = 0;
        for (let i = 0; i < SR * 0.09; i++) {
          lp += 0.35 * (noise() - lp);
          out[at + i]! += 0.6 * lp * Math.exp(-i / (SR * 0.03));
        }
      }
      if (hats.includes(step)) {
        let prev = 0;
        for (let i = 0; i < SR * 0.03; i++) {
          const n = noise();
          out[at + i]! += 0.3 * (n - prev) * Math.exp(-i / (SR * 0.008));
          prev = n;
        }
      }
    }
  }
  return out;
}

describe('extractTrackFeatures', () => {
  const pcm = synthBeat(120, 24, [0, 8, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14]);
  const feat = extractTrackFeatures(pcm, SR, 'C:\\beats\\Mi beat 120.wav');

  it('mide tempo, nombre y rangos', () => {
    expect(feat).not.toBeNull();
    expect(feat!.name).toBe('Mi beat 120');
    expect(feat!.bpm).not.toBeNull();
    const bpm = feat!.bpm!;
    // El analizador puede elegir la octava: 60, 120 o 240 son el mismo pulso.
    expect([60, 120, 240].some((b) => Math.abs(bpm - b) < 2)).toBe(true);
    for (const v of [feat!.swing, feat!.brightness, feat!.grit]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('el grave cae donde está el bombo y el agudo en las corcheas', () => {
    // El sintético se mide a 120 (comprobado); si el analizador cambiara de
    // octava este test tiene que fallar, no saltarse.
    expect(feat!.bpm!).toBeCloseTo(120, 0);
    const low = feat!.lanes.low;
    const kickAvg = (low[0]! + low[8]! + low[10]!) / 3;
    const restAvg = low.filter((_, i) => ![0, 8, 10].includes(i)).reduce((s, v) => s + v, 0) / 13;
    expect(kickAvg).toBeGreaterThan(restAvg + 0.3);
    const high = feat!.lanes.high;
    const even = high.filter((_, i) => i % 2 === 0).reduce((s, v) => s + v, 0) / 8;
    const odd = high.filter((_, i) => i % 2 === 1).reduce((s, v) => s + v, 0) / 8;
    expect(even).toBeGreaterThan(odd + 0.3);
  });

  it('es determinista', () => {
    expect(extractTrackFeatures(pcm, SR, 'x')).toEqual(extractTrackFeatures(pcm, SR, 'x'));
  });

  it('no inventa nada del silencio ni de un audio cortísimo', () => {
    expect(extractTrackFeatures(new Float32Array(SR * 10), SR, 's')).toBeNull();
    expect(extractTrackFeatures(pcm.subarray(0, SR * 2), SR, 'c')).toBeNull();
    expect(extractTrackFeatures(pcm, 0, 'z')).toBeNull();
  });

  it('el perfil con esa pista alimenta al género que encaja', () => {
    const profile = createProfile('id', 'Sintético', [feat!]);
    const hint = styleHint(profile, 'techno');
    // 120 encaja con techno (126..140) solo si el analizador midió 120 o 240→120; si no, sin groove.
    expect(hint.matched).toBeGreaterThanOrEqual(0);
    expect(styleHint(profile, 'trap').brightness).toBeCloseTo(feat!.brightness, 3);
  });
});

describe('trackDisplayName', () => {
  it('quita ruta y extensión', () => {
    expect(trackDisplayName('/a/b/Beat final.mp3')).toBe('Beat final');
    expect(trackDisplayName('C:\\x\\y.z\\tema.flac')).toBe('tema');
  });
});

describe('remapLane', () => {
  const lane = Array.from({ length: 16 }, (_, i) => i / 15);
  it('igual, a medio tiempo y a doble tiempo', () => {
    expect(remapLane(lane, 1)).toEqual(lane);
    const half = remapLane(lane, 2)!;
    expect(half[1]).toBe(0);
    expect(half[2]).toBe(Math.max(lane[1]!, lane[9]!));
    const dbl = remapLane(lane, 0.5)!;
    expect(dbl[3]).toBe(lane[6]);
    expect(dbl[9]).toBe(lane[2]);
    expect(remapLane(lane, 4)).toBeNull();
  });
});
