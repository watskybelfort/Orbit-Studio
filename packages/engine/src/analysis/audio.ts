/**
 * Fachada del analizador de audio: una sola llamada que devuelve tempo y
 * tonalidad de cualquier archivo, con la ventana de escucha ya elegida.
 *
 * Un tema de cinco minutos no se analiza entero para el tempo: se busca el
 * tramo de `maxTempoSeconds` con más actividad rítmica (el drop, el cuerpo del
 * tema) y se mide ahí. Esa decisión es la diferencia entre acertar y medir una
 * intro ambient. Para la tonalidad sí se reparten varias ventanas por el tema,
 * porque la armonía de una canción vive en el conjunto, no en un compás.
 */

import { onsetEnvelope, type OnsetEnvelope } from './onset';
import { detectKey, keyFromProfile, tonalProfile } from './key';
import {
  analysisWindows,
  clamp01,
  mixToMono,
  peakOf,
  resampleMono,
  sliceWindow,
} from './signal';
import { detectTempo } from './tempo';
import type { AudioAnalysis, AudioAnalysisOptions, KeyEstimate, TempoEstimate } from './types';

/** Por debajo de esto no hay nada que analizar. */
const SILENCE_PEAK = 1e-5;

/**
 * Analiza un PCM mono.
 *
 * `opts` controla los topes y los umbrales, pero el resultado SIEMPRE trae la
 * confianza: filtrar es decisión de quien llama (la UI muestra "poco claro" en
 * vez de esconder el dato). Los campos `null` significan "no hay nada honesto
 * que decir", no "no me dio tiempo".
 */
export function analyzeAudio(
  mono: Float32Array,
  sampleRate: number,
  opts: AudioAnalysisOptions = {},
): AudioAnalysis {
  const durationSec = sampleRate > 0 ? mono.length / sampleRate : 0;
  const empty: AudioAnalysis = { durationSec, analyzedSec: 0, tempo: null, key: null };
  if (!(sampleRate > 0) || mono.length === 0) return empty;

  const prepared = resampleMono(mono, sampleRate);
  const pcm = prepared.pcm;
  const sr = prepared.sampleRate;
  if (peakOf(pcm) < SILENCE_PEAK) return { ...empty, analyzedSec: pcm.length / sr };

  const maxTempoSec = Math.max(8, opts.maxTempoSeconds ?? 120);
  const maxKeySec = Math.max(4, opts.maxKeySeconds ?? 120);

  // ── Tempo ────────────────────────────────────────────────────────────────
  let tempo: TempoEstimate | null = null;
  let tempoWindowStart = 0;
  let tempoWindowSec = 0;
  const wholeEnvelope = onsetEnvelope(pcm, sr, { hop: 256, fftSize: 1024 });
  if (wholeEnvelope.values.length > 0) {
    const picked = pickTempoWindow(wholeEnvelope, maxTempoSec, sr);
    tempoWindowStart = picked.startSec;
    tempoWindowSec = picked.envelope.values.length / picked.envelope.rate;
    tempo = detectTempo(picked.envelope, {
      minBpm: opts.minBpm,
      maxBpm: opts.maxBpm,
      tempoPriorBpm: opts.tempoPriorBpm,
      tempoPriorOctaves: opts.tempoPriorOctaves,
      barPrior: opts.barPrior,
      durationSec: pcm.length / sr,
      fullFile: picked.wholeFile,
    });
    if (tempo && tempoWindowStart > 0) {
      tempo = shiftTempo(tempo, tempoWindowStart);
    }
  }

  // ── Tonalidad ────────────────────────────────────────────────────────────
  let key: KeyEstimate | null = null;
  let keyWindowSec = 0;
  const keyWindows = analysisWindows(pcm.length / sr, maxKeySec, 3);
  if (keyWindows.length > 0) {
    const chunks: Float32Array[] = [];
    let total = 0;
    for (const win of keyWindows) {
      const chunk = sliceWindow(pcm, sr, win.startSec, win.endSec);
      if (chunk.length === 0) continue;
      chunks.push(chunk);
      total += chunk.length;
      keyWindowSec += chunk.length / sr;
    }
    if (total > 0 && chunks.length > 0) {
      const combined = new Float32Array(total);
      let at = 0;
      for (const chunk of chunks) {
        combined.set(chunk, at);
        at += chunk.length;
      }
      const profile = tonalProfile(combined, sr);
      if (profile) key = keyFromProfile(profile);
    }
  }

  return {
    durationSec,
    analyzedSec: Math.max(tempoWindowSec, keyWindowSec),
    tempo: tempo && tempo.confidence >= (opts.minTempoConfidence ?? 0) ? tempo : null,
    key: key && key.confidence >= (opts.minKeyConfidence ?? 0) ? key : null,
  };
}

/** Analiza estéreo mezclando a mono. */
export function analyzeStereo(
  left: Float32Array,
  right: Float32Array | undefined,
  sampleRate: number,
  opts: AudioAnalysisOptions = {},
): AudioAnalysis {
  return analyzeAudio(mixToMono(left, right), sampleRate, opts);
}

/**
 * Tempo de un PCM cualquiera, sin ventana de tema: útil para un loop o para
 * tests. La fachada `analyzeAudio` es la que elige el tramo de una canción.
 */
export function estimateTempo(
  mono: Float32Array,
  sampleRate: number,
  opts: AudioAnalysisOptions = {},
): TempoEstimate | null {
  if (!(sampleRate > 0) || mono.length === 0 || peakOf(mono) < SILENCE_PEAK) return null;
  const prepared = resampleMono(mono, sampleRate);
  const env = onsetEnvelope(prepared.pcm, prepared.sampleRate, { hop: 256, fftSize: 1024 });
  if (env.values.length === 0) return null;
  return detectTempo(env, {
    minBpm: opts.minBpm,
    maxBpm: opts.maxBpm,
    tempoPriorBpm: opts.tempoPriorBpm,
    tempoPriorOctaves: opts.tempoPriorOctaves,
    barPrior: opts.barPrior,
    durationSec: prepared.pcm.length / prepared.sampleRate,
    fullFile: true,
  });
}

/** Tonalidad de un PCM cualquiera. */
export function estimateKey(
  mono: Float32Array,
  sampleRate: number,
  opts: AudioAnalysisOptions = {},
): KeyEstimate | null {
  if (!(sampleRate > 0) || mono.length === 0 || peakOf(mono) < SILENCE_PEAK) return null;
  const prepared = resampleMono(mono, sampleRate);
  const sec = Math.min(opts.maxKeySeconds ?? 120, prepared.pcm.length / prepared.sampleRate);
  const windows = analysisWindows(prepared.pcm.length / prepared.sampleRate, sec, 3);
  const chunks: Float32Array[] = [];
  for (const win of windows) {
    const chunk = sliceWindow(prepared.pcm, prepared.sampleRate, win.startSec, win.endSec);
    if (chunk.length > 0) chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const combined = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    combined.set(chunk, at);
    at += chunk.length;
  }
  return detectKey(combined, prepared.sampleRate);
}

/**
 * El tramo continuo de `maxSeconds` con más envolvente media: en una canción
 * es el cuerpo, no la intro. Devuelve el inicio en segundos (para desplazar la
 * rejilla) y si se usó el archivo entero.
 */
function pickTempoWindow(
  env: OnsetEnvelope,
  maxSeconds: number,
  sampleRate: number,
): { envelope: OnsetEnvelope; startSec: number; wholeFile: boolean } {
  const rate = env.rate;
  const maxFrames = Math.max(4, Math.floor(maxSeconds * rate));
  const n = env.values.length;
  if (n <= maxFrames) return { envelope: env, startSec: 0, wholeFile: true };

  // Sumas acumuladas: la ventana con más ataques, no la de más volumen.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + env.values[i]!;
  let bestStart = 0;
  let bestEnergy = -1;
  const stride = Math.max(1, Math.round(rate)); // 1 s
  for (let start = 0; start + maxFrames <= n; start += stride) {
    const energy = prefix[start + maxFrames]! - prefix[start]!;
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }

  const values = env.values.slice(bestStart, bestStart + maxFrames);
  const bands = env.bands.map((band) => band.slice(bestStart, bestStart + maxFrames));
  return {
    envelope: {
      values,
      rate: env.rate,
      hop: env.hop,
      fftSize: env.fftSize,
      bands,
    },
    startSec: bestStart / rate,
    wholeFile: false,
  };
}

/** Desplaza una rejilla medida en una ventana al tiempo absoluto del archivo. */
function shiftTempo(tempo: TempoEstimate, offsetSec: number): TempoEstimate {
  return {
    ...tempo,
    grid: {
      ...tempo.grid,
      offsetSec: tempo.grid.offsetSec + offsetSec,
      downbeatSec: tempo.grid.downbeatSec + offsetSec,
      beatTimes: tempo.grid.beatTimes.map((t) => t + offsetSec),
    },
  };
}

/** Normaliza una confianza para la UI (0..1, tres decimales). */
export function displayConfidence(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}
