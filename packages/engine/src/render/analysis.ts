/**
 * Análisis de mezcla: LUFS integrado (ITU-R BS.1770 simplificado con gating),
 * true peak aproximado y balance espectral por bandas. Lo usan el export
 * (normalizar a -14 LUFS) y la tool MCP `analyze_mix`.
 */

import { Biquad } from '../dsp/filters';

export interface MixAnalysis {
  lufsIntegrated: number;
  peakDb: number;
  /** Energía relativa por banda (dB respecto al total). */
  bands: { low: number; lowMid: number; highMid: number; high: number };
  /** Correlación estéreo -1..1 (≈1 = mono, ≈0 = ancho, <0 = problemas de fase). */
  stereoCorrelation: number;
}

/**
 * Ganancia (dB) que hay que aplicar para llegar al LUFS objetivo, sin pasarse
 * del techo: normalizar no puede ser una forma de clipear el archivo. Si llegar
 * al objetivo exige más de lo que cabe, manda el pico.
 */
export function gainToTarget(analysis: MixAnalysis, targetLufs: number): number {
  return Math.min(targetLufs - analysis.lufsIntegrated, -analysis.peakDb);
}

function kWeight(sr: number): [Biquad, Biquad] {
  // Etapa 1: shelf de +4 dB en agudos; etapa 2: highpass ~38 Hz.
  const shelf = new Biquad().highShelf(1681, 4, sr);
  const hp = new Biquad().highpass(38, 0.5, sr);
  return [shelf, hp];
}

export function analyzeMix(left: Float32Array, right: Float32Array, sr: number): MixAnalysis {
  // Los dos canales pueden no medir lo mismo: esto es API pública y leer
  // `right[i]` fuera de rango propaga NaN a la correlación y a las bandas.
  const n = Math.min(left.length, right.length);
  const [shL, hpL] = kWeight(sr);
  const [shR, hpR] = kWeight(sr);

  // Bloques de 400 ms con 75% de solape (paso 100 ms), gating absoluto -70 LUFS.
  const blockLen = Math.floor(0.4 * sr);
  const hop = Math.floor(0.1 * sr);
  const blockLoudness: number[] = [];
  let sumSq = 0;
  /** Energía K de TODO el material, para cuando no cabe ni un bloque de 400 ms. */
  let totalSq = 0;
  const ring = new Float32Array(Math.max(1, blockLen));
  let ringIdx = 0;
  let filled = 0;
  let sinceHop = 0;

  let peak = 0;
  let corrLR = 0;
  let corrLL = 1e-12;
  let corrRR = 1e-12;

  // Bandas
  const bLow = new Biquad().lowpass(120, 0.707, sr);
  const bLowR = new Biquad().lowpass(120, 0.707, sr);
  const bHigh = new Biquad().highpass(6000, 0.707, sr);
  const bHighR = new Biquad().highpass(6000, 0.707, sr);
  const bLm1 = new Biquad().highpass(120, 0.707, sr);
  const bLm2 = new Biquad().lowpass(900, 0.707, sr);
  const bLm1R = new Biquad().highpass(120, 0.707, sr);
  const bLm2R = new Biquad().lowpass(900, 0.707, sr);
  const bHm1 = new Biquad().highpass(900, 0.707, sr);
  const bHm2 = new Biquad().lowpass(6000, 0.707, sr);
  const bHm1R = new Biquad().highpass(900, 0.707, sr);
  const bHm2R = new Biquad().lowpass(6000, 0.707, sr);
  let eLow = 0, eLowMid = 0, eHighMid = 0, eHigh = 0, eTotal = 0;

  for (let i = 0; i < n; i++) {
    const l = left[i]!;
    const r = right[i]!;
    const al = Math.abs(l);
    const ar = Math.abs(r);
    if (al > peak) peak = al;
    if (ar > peak) peak = ar;
    corrLR += l * r;
    corrLL += l * l;
    corrRR += r * r;

    // K-weighting para loudness
    const kl = hpL.tick(shL.tick(l));
    const kr = hpR.tick(shR.tick(r));
    const ms = kl * kl + kr * kr;
    totalSq += ms;
    sumSq += ms - ring[ringIdx]!;
    ring[ringIdx] = ms;
    ringIdx = (ringIdx + 1) % blockLen;
    if (filled < blockLen) filled++;
    if (filled === blockLen && ++sinceHop >= hop) {
      sinceHop = 0;
      const mean = sumSq / blockLen;
      const lufs = -0.691 + 10 * Math.log10(Math.max(1e-12, mean));
      if (lufs > -70) blockLoudness.push(lufs);
    }

    // Bandas (energía sobre L+R)
    const lo = bLow.tick(l) + bLowR.tick(r);
    const hi = bHigh.tick(l) + bHighR.tick(r);
    const lm = bLm2.tick(bLm1.tick(l)) + bLm2R.tick(bLm1R.tick(r));
    const hm = bHm2.tick(bHm1.tick(l)) + bHm2R.tick(bHm1R.tick(r));
    eLow += lo * lo;
    eLowMid += lm * lm;
    eHighMid += hm * hm;
    eHigh += hi * hi;
    eTotal += (l + r) * (l + r);
  }

  // Gating relativo: -10 LU respecto a la media de los bloques que pasan el absoluto.
  let integrated = -70;
  if (blockLoudness.length > 0) {
    const mean1 =
      blockLoudness.reduce((a, b) => a + Math.pow(10, b / 10), 0) / blockLoudness.length;
    const gate = 10 * Math.log10(mean1) - 10;
    const passed = blockLoudness.filter((b) => b > gate);
    if (passed.length > 0) {
      // Cada bloque ya lleva el offset -0.691, así que el promedio en energía basta.
      const mean2 = passed.reduce((a, b) => a + Math.pow(10, b / 10), 0) / passed.length;
      integrated = 10 * Math.log10(mean2);
    }
  } else if (n > 0) {
    // Material más corto que un bloque de 400 ms: no hay gating posible, así
    // que se mide entero. Devolver el centinela -70 hacía que `gainToTarget`
    // pidiera +56 dB — y exportar con "Normalizar" una selección de menos de
    // medio segundo multiplicaba la señal por 631.
    integrated = -0.691 + 10 * Math.log10(Math.max(1e-12, totalSq / n));
  }

  const rel = (e: number) => 10 * Math.log10(Math.max(1e-12, e) / Math.max(1e-12, eTotal));

  return {
    lufsIntegrated: integrated,
    peakDb: 20 * Math.log10(Math.max(1e-12, peak)),
    bands: {
      low: rel(eLow),
      lowMid: rel(eLowMid),
      highMid: rel(eHighMid),
      high: rel(eHigh),
    },
    stereoCorrelation: corrLR / Math.sqrt(corrLL * corrRR),
  };
}
