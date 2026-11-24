/**
 * Medir una pista para el perfil de estilo: de PCM mono a `TrackFeatures`.
 *
 * Es lo que hace el «entrenamiento»: cada beat del usuario pasa por aquí y
 * deja su huella de groove y de sonido. Usa el analizador de tempo y
 * tonalidad del motor (la misma rejilla de pulsos con la que Orbit encaja un
 * audio en la playlist) y encima mide, por bandas, en qué semicorchea del
 * compás caen los golpes.
 *
 * Por qué por bandas y no «bombo/caja/hat»: separar las fuentes de un audio
 * mezclado no es posible limpiamente, y fingirlo daría números con más
 * aplomo que verdad. Grave, medio y agudo sí se miden bien, y en un beat se
 * corresponden de sobra con bombo/808, caja/palmas y hats — que es justo lo
 * que necesita el compositor para mover sus probabilidades.
 *
 * Puro y determinista, sin DOM: corre igual en un worker del renderer, en Node
 * para un script o en un test.
 */

import { analyzeAudio, onsetEnvelope } from '@orbit/engine';
import { Fft } from '../fft';
import type { TrackFeatures } from './profile';

/** Segundos de audio que se miden como mucho (el centro del tema). */
export const MAX_FEATURE_SECONDS = 150;
const MIN_SECONDS = 6;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Nombre visible de un archivo: sin ruta ni extensión, acotado. */
export function trackDisplayName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[a-z0-9]{1,5}$/i, '').slice(0, 120);
}

/** Picos locales de una envolvente por encima de un umbral adaptativo. */
function peaks(values: Float32Array, radius = 3): { frame: number; strength: number }[] {
  let sum = 0;
  let sq = 0;
  for (const v of values) {
    sum += v;
    sq += v * v;
  }
  const n = values.length || 1;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  const thr = Math.max(0.08, mean + 0.9 * std);
  const out: { frame: number; strength: number }[] = [];
  for (let f = 0; f < values.length; f++) {
    const v = values[f]!;
    if (v < thr) continue;
    let isMax = true;
    for (let d = -radius; d <= radius && isMax; d++) {
      if (d === 0) continue;
      const w = values[f + d];
      if (w !== undefined && (w > v || (w === v && d < 0))) isMax = false;
    }
    if (isMax) out.push({ frame: f, strength: v });
  }
  return out;
}

/** Índice del último pulso <= t (búsqueda binaria), o -1. */
function beatIndexAt(beats: readonly number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  if (hi < 0 || t < beats[0]!) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Centroide espectral medio (Hz) de unos cuantos frames repartidos. */
function spectralCentroid(pcm: Float32Array, sampleRate: number): number {
  const size = 2048;
  if (pcm.length < size) return 0;
  const fft = new Fft(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const frames = 96;
  const stride = Math.max(1, Math.floor((pcm.length - size) / frames));
  let num = 0;
  let den = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * stride;
    if (off + size > pcm.length) break;
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      re[i] = pcm[off + i]! * w;
      im[i] = 0;
    }
    fft.transform(re, im);
    for (let k = 1; k < size / 2; k++) {
      const mag = Math.hypot(re[k]!, im[k]!);
      num += mag * ((k * sampleRate) / size);
      den += mag;
    }
  }
  return den > 0 ? num / den : 0;
}

/**
 * Mide una pista. Devuelve `null` si el audio es demasiado corto o es silencio
 * (no hay nada honesto que aprender de ahí).
 */
export function extractTrackFeatures(mono: Float32Array, sampleRate: number, name: string): TrackFeatures | null {
  if (!(sampleRate > 0)) return null;
  const durationSec = mono.length / sampleRate;
  if (durationSec < MIN_SECONDS) return null;

  // El centro del tema: ni la intro ni el final, que suelen ir sin batería.
  const maxLen = Math.floor(MAX_FEATURE_SECONDS * sampleRate);
  const start = mono.length > maxLen ? Math.floor((mono.length - maxLen) / 2) : 0;
  const pcm = mono.length > maxLen ? mono.subarray(start, start + maxLen) : mono;

  let peak = 0;
  let energy = 0;
  for (const v of pcm) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    energy += v * v;
  }
  const rms = Math.sqrt(energy / pcm.length);
  if (peak < 1e-3 || rms < 1e-4) return null;

  const analysis = analyzeAudio(pcm, sampleRate);
  const tempo = analysis.tempo;
  const key = analysis.key;

  const lanes = { low: new Array(16).fill(0), mid: new Array(16).fill(0), high: new Array(16).fill(0) };
  const density = { low: 0, mid: 0, high: 0 };
  let swing = 0;

  const beats = tempo?.grid.beatTimes ?? [];
  if (tempo && beats.length >= 8) {
    // ~11 ms por frame a cualquier frecuencia (potencia de dos: la FFT lo pide),
    // de sobra para semicorcheas a 160.
    const hop = Math.max(64, 2 ** Math.round(Math.log2(sampleRate / 86)));
    const fftSize = hop * 4;
    const env = onsetEnvelope(pcm, sampleRate, { hop, fftSize });
    const latency = fftSize / 2 / sampleRate;
    const downIdx = Math.max(0, beatIndexAt(beats, tempo.grid.downbeatSec + 1e-3));
    const bars = Math.max(1, (beats.length - 1) / 4);
    // Banda del motor → carril: 0 grave · 1+2 medio (caja/palmas) · 3 agudo.
    const laneOf = ['low', 'mid', 'mid', 'high'] as const;
    const offbeatFracs: number[] = [];
    const counts = { low: new Array(16).fill(0), mid: new Array(16).fill(0), high: new Array(16).fill(0) };
    env.bands.forEach((band, b) => {
      const lane = laneOf[b]!;
      for (const p of peaks(band)) {
        const t = (p.frame * hop) / sampleRate + latency;
        const i = beatIndexAt(beats, t);
        if (i < 0 || i >= beats.length - 1) continue;
        const period = beats[i + 1]! - beats[i]!;
        if (!(period > 0)) continue;
        const frac = (t - beats[i]!) / period;
        let sub = Math.round(frac * 4);
        let beatInBar = (((i - downIdx) % 4) + 4) % 4;
        if (sub === 4) {
          sub = 0;
          beatInBar = (beatInBar + 1) % 4;
        }
        const step = beatInBar * 4 + sub;
        // Dos bandas medias suman al mismo carril: se reparte el peso.
        const w = Math.min(1, p.strength * 1.4) * (lane === 'mid' ? 0.5 : 1);
        counts[lane][step] += w;
        density[lane] += lane === 'mid' ? 0.5 : 1;
        if (lane === 'high' && frac > 0.38 && frac < 0.8) offbeatFracs.push(frac);
      }
    });
    for (const lane of ['low', 'mid', 'high'] as const) {
      lanes[lane] = counts[lane].map((c) => round3(clamp01(c / bars)));
      density[lane] = round3(density[lane] / bars);
    }
    if (offbeatFracs.length >= 8) {
      const mean = offbeatFracs.reduce((s, x) => s + x, 0) / offbeatFracs.length;
      swing = round3(clamp01((mean - 0.5) / 0.17));
    }
  }

  const centroid = spectralCentroid(pcm, sampleRate);
  const brightness = centroid > 0 ? clamp01((Math.log2(centroid) - Math.log2(500)) / (Math.log2(5000) - Math.log2(500))) : 0.5;
  const crestDb = 20 * Math.log10(peak / rms);
  const grit = clamp01((16 - crestDb) / 10);

  return {
    name: trackDisplayName(name),
    durationSec: round3(durationSec),
    bpm: tempo ? round3(tempo.bpm) : null,
    bpmConfidence: round3(tempo?.confidence ?? 0),
    bpmCandidates: (tempo?.candidates ?? [])
      .map((c) => round3(c.bpm))
      .filter((b) => tempo && Math.abs(b - tempo.bpm) > 0.5)
      .slice(0, 6),
    keyRoot: key ? key.root : null,
    keyMode: key ? key.mode : null,
    keyConfidence: round3(key?.confidence ?? 0),
    swing,
    lanes,
    density,
    brightness: round3(brightness),
    grit: round3(grit),
  };
}
