/**
 * Detección de tempo y rejilla de pulsos.
 *
 * El método tiene tres pasos, y los tres existen por un error concreto:
 *
 * 1. **Autocorrelación + peine de armónicos** sobre la envolvente de onsets.
 *    Da los candidatos de periodo, pero por sí sola confunde 87 con 174: la
 *    autocorrelación de un pulso también tiene pico en el doble de su periodo.
 * 2. **Seguimiento de pulsos por programación dinámica** (estilo Ellis). Para
 *    cada candidato se busca la secuencia de pulsos que mejor encaja con los
 *    ataques, penalizando las desviaciones de periodo. Esto descarta un
 *    candidato que solo tiene un pico de autocorrelación pero no una rejilla
 *    real: un pad con un golpe cada dos compases no se convierte en 120 BPM.
 * 3. **Regresión sobre los pulsos encontrados**. El periodo se afina con todos
 *    los intervalos, no con un lag entero, y por eso el BPM sale con decimales
 *    estables en vez de saltar entre 127 y 128.
 *
 * La ambigüedad de octava que queda se resuelve con un prior log-normal
 * (centrado en `tempoPriorBpm`) y se muestra al usuario como alternativas, que
 * es más honesto que esconder que 87 y 174 son la misma rejilla.
 */

import { countAttacks, type OnsetEnvelope } from './onset';
import { clamp01 } from './signal';
import {
  MAX_GRID_BEATS,
  type BeatGrid,
  type TempoCandidate,
  type TempoEstimate,
} from './types';

export interface TempoOptions {
  minBpm?: number;
  maxBpm?: number;
  tempoPriorBpm?: number;
  tempoPriorOctaves?: number;
  barPrior?: boolean;
  /** Duración real del audio analizado (para el cuadre por compases). */
  durationSec?: number;
  /** `true` si se analizó el archivo entero (si se recortó, el cuadre no vale). */
  fullFile?: boolean;
}

/** Mínimo de ataques para hablar de pulso. */
const MIN_ATTACKS = 4;
/** Centro y anchura por defecto del prior de tempo. */
const DEFAULT_PRIOR_BPM = 118;
const DEFAULT_PRIOR_OCTAVES = 0.75;
/** Rigidez del seguimiento de pulsos: cuánto castiga salirse del periodo. */
const TRACK_TIGHTNESS = 55;
/** Compases de 4/4 que se consideran "loop" para el desempate. */
const LOOP_BARS = [1, 2, 4, 8, 16];
const LOOP_TOL_BARS = 0.02;
const LOOP_MAX_SEC = 32;
/** Separación mínima entre candidatos, en octavas (2 %). */
const CANDIDATE_SEPARATION = 0.025;

interface ACF {
  values: Float64Array;
  minLag: number;
  maxLag: number;
  rawEnergy: number;
}

function buildAcf(env: Float32Array, rate: number, minBpm: number, maxBpm: number): ACF | null {
  const n = env.length;
  if (n < 3) return null;
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * rate) - 1);
  const maxLag = Math.min(n - 2, Math.ceil((60 / minBpm) * rate) + 2);
  if (maxLag <= minLag + 1) return null;

  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i]! + env[i]! * env[i]!;
  if (cum[n]! <= 1e-12) return null;

  const values = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const len = n - lag;
    let dot = 0;
    for (let i = 0; i < len; i++) dot += env[i]! * env[i + lag]!;
    const ea = cum[len]!;
    const eb = cum[n]! - cum[lag]!;
    const den = Math.sqrt(ea * eb);
    values[lag] = den > 1e-12 ? dot / den : 0;
  }
  return { values, minLag, maxLag, rawEnergy: cum[n]! };
}

function acfAt(acf: ACF, lag: number): number {
  if (lag < acf.minLag || lag >= acf.maxLag) return 0;
  const i = Math.floor(lag);
  const t = lag - i;
  return acf.values[i]! * (1 - t) + acf.values[i + 1]! * t;
}

/** Peine: un periodo real también correlaciona en 2×, 3× y 4× su lag. */
function combAt(acf: ACF, lag: number): number {
  const r1 = acfAt(acf, lag);
  if (r1 <= 0) return 0;
  const r2 = Math.max(0, acfAt(acf, lag * 2));
  const r3 = Math.max(0, acfAt(acf, lag * 3));
  const r4 = Math.max(0, acfAt(acf, lag * 4));
  return r1 * (1 + 0.5 * r2 + 0.18 * r3 + 0.25 * r4);
}

function priorWeight(bpm: number, centre: number, octaves: number): number {
  const z = Math.log2(bpm / centre) / Math.max(0.05, octaves);
  return Math.exp(-0.5 * z * z);
}

/** Cuánto cuadra el archivo entero en un número entero de compases de 4/4. */
function loopBarFit(bpm: number, durationSec: number): number {
  if (!(durationSec > 0)) return 1;
  const bars = (durationSec * bpm) / 60 / 4;
  let best = 0;
  for (const b of LOOP_BARS) {
    const d = (bars - b) / LOOP_TOL_BARS;
    const fit = Math.exp(-0.5 * d * d);
    if (fit > best) best = fit;
  }
  return 1 + 0.5 * best;
}

interface BeatPath {
  /** Frames de los pulsos, ordenados. */
  frames: number[];
  /** Periodo refinado, en frames. */
  period: number;
  bpm: number;
  /** Fuerza media de onset en los pulsos (0..1). */
  strength: number;
  /** Fracción de pulsos con un ataque claro. */
  support: number;
  /** 0..1 — regularidad de los intervalos. */
  stability: number;
  /** 0..1 — fracción de la energía de ataques que la rejilla explica. */
  coverage: number;
  /** Calidad combinada 0..1. */
  quality: number;
}

/**
 * Sigue la rejilla de pulsos que mejor explica la envolvente para un periodo
 * dado. Devuelve `null` si no encuentra al menos cuatro pulsos encadenados.
 */
function trackBeats(env: Float32Array, rate: number, bpm: number): BeatPath | null {
  const n = env.length;
  const period = (60 / bpm) * rate;
  if (!(period >= 2) || n < period * 4) return null;

  let meanEnv = 0;
  for (let i = 0; i < n; i++) meanEnv += env[i]!;
  meanEnv /= n;
  if (meanEnv <= 1e-9) return null;

  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const loBase = Math.max(1, Math.floor(period * 0.5));
  const hiBase = Math.max(loBase + 1, Math.ceil(period * 2));

  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let bestTau = -1;
    const lo = Math.max(0, t - hiBase);
    const hi = t - loBase;
    for (let tau = lo; tau <= hi; tau++) {
      const ratio = (t - tau) / period;
      const deviation = Math.log(ratio);
      const value = score[tau]! - TRACK_TIGHTNESS * deviation * deviation;
      if (value > best) {
        best = value;
        bestTau = tau;
      }
    }
    score[t] = env[t]! + (bestTau >= 0 ? best : 0);
    back[t] = bestTau;
  }

  // El final se busca en el último par de periodos: una cadena que empieza
  // tarde y termina antes no es la rejilla del tema.
  let end = -1;
  let endScore = -Infinity;
  const from = Math.max(0, n - Math.ceil(period * 2));
  for (let t = from; t < n; t++) {
    if (score[t]! > endScore) {
      endScore = score[t]!;
      end = t;
    }
  }
  if (end < 0) return null;

  const frames: number[] = [];
  for (let t = end; t >= 0 && frames.length <= n; t = back[t]!) {
    frames.push(t);
    if (back[t]! < 0) break;
  }
  frames.reverse();
  if (frames.length < 4) return null;

  // Afina cada pulso al máximo local de la envolvente. El DP cuantiza a frame;
  // el ataque real cae entre dos frames y este ajuste recupera esa fracción.
  const radius = Math.max(1, Math.round(period * 0.07));
  const snapped: number[] = [];
  for (const frame of frames) {
    let bestFrame = frame;
    let bestValue = env[frame]!;
    for (let d = -radius; d <= radius; d++) {
      const i = frame + d;
      if (i < 0 || i >= n) continue;
      if (env[i]! > bestValue) {
        bestValue = env[i]!;
        bestFrame = i;
      }
    }
    // No se acepta un salto grande si el frame original ya tenía ataque: eso
    // sería engancharse al pulso vecino.
    if (bestFrame !== frame && bestValue > env[frame]! * 1.15) snapped.push(bestFrame);
    else snapped.push(frame);
  }
  // Orden y unicidad: dos pulsos no pueden caer en el mismo frame.
  snapped.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const f of snapped) {
    if (unique.length === 0 || f > unique[unique.length - 1]!) unique.push(f);
  }
  if (unique.length < 4) return null;

  // Regresión lineal frame ~ índice: el periodo sale de TODOS los intervalos.
  const count = unique.length;
  let meanI = 0;
  let meanT = 0;
  for (let i = 0; i < count; i++) {
    meanI += i;
    meanT += unique[i]!;
  }
  meanI /= count;
  meanT /= count;
  let cov = 0;
  let varI = 0;
  for (let i = 0; i < count; i++) {
    const di = i - meanI;
    cov += di * (unique[i]! - meanT);
    varI += di * di;
  }
  const fittedPeriod = varI > 0 ? cov / varI : period;
  if (!(fittedPeriod > period * 0.8 && fittedPeriod < period * 1.2)) return null;

  // Intervalos reales (no los del ajuste) para medir estabilidad.
  const intervals: number[] = [];
  for (let i = 1; i < count; i++) intervals.push(unique[i]! - unique[i - 1]!);
  let meanInterval = 0;
  for (const v of intervals) meanInterval += v;
  meanInterval /= Math.max(1, intervals.length);
  let variance = 0;
  for (const v of intervals) variance += (v - meanInterval) * (v - meanInterval);
  variance /= Math.max(1, intervals.length);
  const deviation = meanInterval > 0 ? Math.sqrt(variance) / meanInterval : 1;
  const stability = clamp01(1 - deviation / 0.22);

  let strength = 0;
  let supported = 0;
  for (const frame of unique) {
    strength += env[frame]!;
    if (env[frame]! > 0.12) supported++;
  }
  strength /= count;
  const support = supported / count;
  const clarity = clamp01(strength / (meanEnv * 3.5));
  const coverage = gridCoverage(env, unique);
  // `coverage` es el árbitro de la métrica: un candidato a 4/3 del pulso real
  // puede pasar por los bombos (3+3+2) pero deja la caja sin explicar, y esa
  // energía sin rejilla es exactamente lo que separa 85 de 113.
  const quality = clamp01(0.36 * clarity + 0.27 * support + 0.15 * stability + 0.22 * coverage);
  const refinedBpm = (60 * rate) / fittedPeriod;

  return {
    frames: unique,
    period: fittedPeriod,
    bpm: refinedBpm,
    strength,
    support,
    stability,
    coverage,
    quality,
  };
}

/**
 * Fracción de la energía de la envolvente que cae dentro de ±2 frames de un
 * pulso. Se pondera al cuadrado para que un bombo pese más que un hat: si la
 * rejilla solo explica las partes débiles, no es la rejilla del tema.
 */
function gridCoverage(env: Float32Array, frames: number[]): number {
  const n = env.length;
  if (n === 0 || frames.length === 0) return 0;
  const near = new Uint8Array(n);
  for (const f of frames) {
    const lo = Math.max(0, f - 2);
    const hi = Math.min(n - 1, f + 2);
    for (let i = lo; i <= hi; i++) near[i] = 1;
  }
  let total = 0;
  let covered = 0;
  for (let i = 0; i < n; i++) {
    const v = env[i]!;
    if (v <= 0.05) continue;
    const energy = v * v;
    total += energy;
    if (near[i]) covered += energy;
  }
  return total > 1e-12 ? clamp01(covered / total) : 0;
}

/** Deduplica candidatos por proximidad en octavas. */
function distinct(bpms: number[], separation = CANDIDATE_SEPARATION): number[] {
  const out: number[] = [];
  for (const bpm of bpms) {
    if (!(bpm > 0)) continue;
    if (out.every((b) => Math.abs(Math.log2(bpm / b)) > separation)) out.push(bpm);
  }
  return out;
}

/** ¿Dos tempos describen la misma rejilla (igual, mitad o doble)? */
function sameGrid(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  const ratio = a / b;
  return Math.abs(ratio - 1) <= 0.03 || Math.abs(ratio - 2) <= 0.06 || Math.abs(ratio - 0.5) <= 0.03;
}

/**
 * Estima tempo y rejilla a partir de la envolvente de onsets.
 */
export function detectTempo(onset: OnsetEnvelope, opts: TempoOptions = {}): TempoEstimate | null {
  const env = onset.values;
  const rate = onset.rate;
  if (env.length < rate * 1.5) return null;
  if (countAttacks(env, rate) < MIN_ATTACKS) return null;

  const minBpm = Math.max(20, opts.minBpm ?? 40);
  const maxBpm = Math.min(400, opts.maxBpm ?? 220);
  if (!(maxBpm > minBpm)) return null;
  const priorBpm = opts.tempoPriorBpm ?? DEFAULT_PRIOR_BPM;
  const priorOctaves = opts.tempoPriorOctaves ?? DEFAULT_PRIOR_OCTAVES;

  const acf = buildAcf(env, rate, minBpm, maxBpm);
  if (!acf) return null;

  const step = 0.05;
  const gridSize = Math.round((maxBpm - minBpm) / step) + 1;
  const score = new Float64Array(gridSize);
  for (let g = 0; g < gridSize; g++) {
    const bpm = minBpm + g * step;
    const lag = (60 / bpm) * rate;
    const base = combAt(acf, lag);
    if (base <= 0) continue;
    let value = base * priorWeight(bpm, priorBpm, priorOctaves);
    if (opts.barPrior !== false && opts.fullFile && (opts.durationSec ?? 0) <= LOOP_MAX_SEC) {
      value *= loopBarFit(bpm, opts.durationSec ?? 0);
    }
    score[g] = value;
  }

  // Crestas locales con supresión de vecinos: si dos picos están a menos de un
  // 2 %, el que vale es el más alto; el otro es la misma rejilla medida mal.
  const peaks: number[] = [];
  for (let g = 0; g < gridSize; g++) {
    const value = score[g]!;
    if (value <= 0) continue;
    if (g > 0 && score[g - 1]! > value) continue;
    if (g + 1 < gridSize && score[g + 1]! > value) continue;
    peaks.push(g);
  }
  peaks.sort((a, b) => score[b]! - score[a]!);
  const topBpms: number[] = [];
  for (const g of peaks) {
    if (topBpms.length >= 6) break;
    const bpm = minBpm + g * step;
    if (topBpms.every((b) => Math.abs(Math.log2(bpm / b)) > CANDIDATE_SEPARATION)) {
      topBpms.push(bpm);
    }
  }
  // La mitad y el doble también compiten: un tema a 70 con bombo en 1 y 3
  // puede leerse a 140, y queremos que el seguimiento de pulsos decida.
  const seed = topBpms.slice(0, 3);
  for (const bpm of seed) {
    if (bpm / 2 >= minBpm) topBpms.push(bpm / 2);
    if (bpm * 2 <= maxBpm) topBpms.push(bpm * 2);
  }
  const bpms = distinct(topBpms);
  if (bpms.length === 0) return null;

  interface Ranked {
    path: BeatPath;
    /** Calidad de la rejilla sola, sin prior de tempo. */
    base: number;
    periodicity: number;
    prior: number;
    /** Prior con el cuadre de compases: solo elige entre octavas. */
    levelScore: number;
  }

  const ranked: Ranked[] = [];
  for (const bpm of bpms) {
    const path = trackBeats(env, rate, bpm);
    if (!path) continue;
    const lag = (60 / path.bpm) * rate;
    const periodicity = clamp01(acfAt(acf, lag));
    const prior = priorWeight(path.bpm, priorBpm, priorOctaves);
    const base = path.quality;
    let levelScore = prior;
    if (opts.barPrior !== false && opts.fullFile && (opts.durationSec ?? 0) <= LOOP_MAX_SEC) {
      levelScore *= loopBarFit(path.bpm, opts.durationSec ?? 0);
    }
    if (base > 0) ranked.push({ path, base, periodicity, prior, levelScore });
  }
  if (ranked.length === 0) return null;

  // El prior NO elige entre ritmos distintos: un tresillo de la caja fuerte
  // puede parecer un tempo a 4/3 del real, y el prior (centrado en 118) lo
  // preferiría por estar más cerca. Primero manda la rejilla que más energía
  // explica; después, el prior solo desempata las lecturas que son la MISMA
  // rejilla a la mitad o al doble.
  ranked.sort((a, b) => b.base - a.base);
  const top = ranked[0]!;
  // Un tempo al doble que deja la mitad de sus pulsos sin ningún ataque no es
  // una lectura del mismo pulso: es un compás vacío. El prior solo puede
  // desempatar niveles que la señal sostiene parecido.
  const supportFloor = Math.max(0.3, top.path.support - 0.2);
  const equivalent = ranked.filter(
    (entry) => sameGrid(entry.path.bpm, top.path.bpm) && entry.path.support >= supportFloor,
  );
  if (equivalent.length === 0) equivalent.push(top);
  equivalent.sort((a, b) => b.levelScore - a.levelScore);
  const byPrior = equivalent[0]!;
  // Si la rejilla rápida explica MUCHA más energía (un bombo y caja por pulso
  // a 174 no es lo mismo que su mitad), la calidad manda sobre el prior; el
  // prior solo desempata lecturas que explican la señal casi igual de bien.
  const best = top.base >= byPrior.base * 1.3 ? top : byPrior;

  // Margen sobre la mejor lectura que NO sea la misma rejilla (ni su mitad ni
  // su doble): es lo que separa "claro" de "podría ser cualquiera de estos".
  let rival = 0;
  for (const other of ranked) {
    if (sameGrid(other.path.bpm, best.path.bpm)) continue;
    rival = other.base;
    break;
  }
  const margin = clamp01((best.base - rival) / Math.max(1e-9, best.base));

  const confidence = clamp01(
    0.34 * best.periodicity +
      0.26 * best.path.support +
      0.13 * best.path.stability +
      0.12 * best.path.coverage +
      0.15 * margin,
  );

  const grid = buildGrid(best.path, onset, rate);

  const candidates: TempoCandidate[] = [];
  const ordered = [best, ...ranked.filter((entry) => entry !== best)];
  for (const entry of ordered.slice(0, 8)) {
    const candidateBpm = entry.path.bpm;
    const ratio = candidateBpm / best.path.bpm;
    let octave: -1 | 0 | 1 = 0;
    if (ratio > 1.85 && ratio < 2.15) octave = 1;
    else if (ratio > 0.46 && ratio < 0.54) octave = -1;
    candidates.push({
      bpm: round2(candidateBpm),
      confidence: clamp01(0.45 * entry.periodicity + 0.35 * entry.path.support + 0.2 * entry.path.stability),
      octave,
      score: entry.base,
      periodicity: entry.periodicity,
    });
  }

  return {
    bpm: round2(best.path.bpm),
    confidence,
    grid,
    candidates,
  };
}

/**
 * Rejilla de pulsos y "1" del compás.
 *
 * El pulso fuerte se busca con la banda grave de la envolvente: en la música
 * que hace Orbit (trap, reggaetón, boom bap) el bombo cae en el 1. Cuando la
 * banda no da una rotación clara (un tema sin bombo, un pad), se queda la
 * primera y la rejilla sigue siendo válida.
 */
function buildGrid(path: BeatPath, onset: OnsetEnvelope, rate: number): BeatGrid {
  const frames = path.frames;
  const beatTimes: number[] = [];
  for (let i = 0; i < frames.length && i < MAX_GRID_BEATS; i++) {
    beatTimes.push(frames[i]! / rate);
  }

  let downbeatIndex = 0;
  const low = onset.bands[0];
  const mid = onset.bands[1];
  if (low && low.length > 0 && mid && mid.length > 0 && frames.length >= 4) {
    let bestRotation = 0;
    let bestScore = -Infinity;
    for (let r = 0; r < 4; r++) {
      let lowMean = 0;
      let midBack = 0;
      let nLow = 0;
      let nMid = 0;
      for (let i = r; i < frames.length; i += 4) {
        const f = Math.min(low.length - 1, frames[i]!);
        lowMean += low[f]!;
        nLow++;
        const back = Math.min(mid.length - 1, frames[(i + 2) % frames.length]!);
        midBack += mid[back]!;
        nMid++;
      }
      lowMean /= Math.max(1, nLow);
      midBack /= Math.max(1, nMid);
      // El 1 suele ser el bombo más fuerte; el 3 (dos pulsos después) suele
      // llevar la caja. Se premia la rotación que tiene las dos cosas.
      const value = lowMean + 0.3 * midBack;
      if (value > bestScore) {
        bestScore = value;
        bestRotation = r;
      }
    }
    downbeatIndex = bestRotation;
  }

  const beatPeriodSec = path.period / rate;
  return {
    offsetSec: beatTimes[0] ?? 0,
    downbeatSec: beatTimes[downbeatIndex] ?? 0,
    beatsPerBar: 4,
    beatPeriodSec,
    stability: path.stability,
    beatTimes,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
