/**
 * Perfil de estilo: lo que el compositor «aprende» de un audio.
 *
 * No es una red neuronal ni guarda el audio: son medidas de cómo está hecho un
 * tema — a qué tempo va, en qué tonalidad, en qué semicorcheas del compás caen
 * los golpes graves, medios y agudos, cuánto swing lleva, qué brillo y qué
 * suciedad tiene. Con varias pistas, el perfil las guarda todas y el
 * compositor usa las que encajan con el género pedido (un boom bap a 90 no
 * tiene nada que enseñarle a un rave a 156).
 *
 * Es deliberadamente pequeño y legible: cabe en settings.json, se puede
 * mandar por el MCP y no contiene nada que permita reconstruir el tema — ni
 * notas ni melodías, solo estadística del groove y del sonido. Eso es lo que
 * deja «sacar beats con esa temática» sin copiar el original.
 */

import { GENRE_PRESETS, type ComposerGenre } from './genres';

export const PROFILE_VERSION = 1;
/** Pistas que guarda un perfil como mucho (los perfiles viven en settings.json). */
export const MAX_PROFILE_TRACKS = 64;
export const STEPS_PER_BAR = 16;

/** Lo medido de UNA pista. */
export interface TrackFeatures {
  /** Nombre visible (el del archivo, sin ruta). */
  name: string;
  durationSec: number;
  bpm: number | null;
  bpmConfidence: number;
  /** Tónica 0..11 (0 = C). */
  keyRoot: number | null;
  keyMode: 'major' | 'minor' | null;
  keyConfidence: number;
  /** 0..1 — cuánto se retrasan las corcheas débiles (0 = recto). */
  swing: number;
  /**
   * Probabilidad de golpe en cada semicorchea del compás (16 valores 0..1),
   * por banda: grave ≈ bombo/808, media ≈ caja/palmas, aguda ≈ hats.
   */
  lanes: { low: number[]; mid: number[]; high: number[] };
  /** Golpes por compás de cada banda. */
  density: { low: number; mid: number; high: number };
  /** 0..1 — centroide espectral relativo (0 = oscuro, 1 = brillante). */
  brightness: number;
  /** 0..1 — cuánto está apretado/saturado (1 = muy poco rango dinámico). */
  grit: number;
}

export interface StyleProfile {
  version: number;
  /** Id estable (lo pone quien lo crea). */
  id: string;
  name: string;
  /** Cuándo se creó (ms epoch). */
  createdAt: number;
  tracks: TrackFeatures[];
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Perfil nuevo a partir de pistas ya medidas (se queda con las válidas, hasta el tope). */
export function createProfile(id: string, name: string, tracks: TrackFeatures[], createdAt = 0): StyleProfile {
  return {
    version: PROFILE_VERSION,
    id,
    name: name.trim().slice(0, 80) || 'Mi estilo',
    createdAt,
    tracks: tracks.filter(isValidTrack).slice(0, MAX_PROFILE_TRACKS),
  };
}

/** Añade pistas a un perfil existente (no muta el original). */
export function extendProfile(profile: StyleProfile, tracks: TrackFeatures[]): StyleProfile {
  return {
    ...profile,
    tracks: [...profile.tracks, ...tracks.filter(isValidTrack)].slice(-MAX_PROFILE_TRACKS),
  };
}

function isLane(x: unknown): x is number[] {
  return Array.isArray(x) && x.length === STEPS_PER_BAR && x.every((v) => finite(v) && v >= 0 && v <= 1);
}

function isValidTrack(t: unknown): t is TrackFeatures {
  if (!t || typeof t !== 'object') return false;
  const r = t as Record<string, unknown>;
  const lanes = r['lanes'] as Record<string, unknown> | undefined;
  const density = r['density'] as Record<string, unknown> | undefined;
  return (
    typeof r['name'] === 'string' &&
    finite(r['durationSec']) &&
    (r['bpm'] === null || (finite(r['bpm']) && (r['bpm'] as number) > 0)) &&
    (r['keyRoot'] === null || (Number.isInteger(r['keyRoot']) && (r['keyRoot'] as number) >= 0 && (r['keyRoot'] as number) < 12)) &&
    (r['keyMode'] === null || r['keyMode'] === 'major' || r['keyMode'] === 'minor') &&
    finite(r['swing']) && finite(r['brightness']) && finite(r['grit']) &&
    finite(r['bpmConfidence']) && finite(r['keyConfidence']) &&
    !!lanes && isLane(lanes['low']) && isLane(lanes['mid']) && isLane(lanes['high']) &&
    !!density && finite(density['low']) && finite(density['mid']) && finite(density['high'])
  );
}

/**
 * Valida un perfil que llega de fuera (settings.json, MCP). Devuelve `null` si
 * no tiene la forma: un perfil corrupto no puede tumbar el compositor.
 */
export function parseProfile(raw: unknown): StyleProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== PROFILE_VERSION) return null;
  if (typeof r['id'] !== 'string' || typeof r['name'] !== 'string') return null;
  if (!Array.isArray(r['tracks'])) return null;
  const tracks = (r['tracks'] as unknown[]).filter(isValidTrack).slice(0, MAX_PROFILE_TRACKS);
  if (tracks.length === 0) return null;
  return {
    version: PROFILE_VERSION,
    id: r['id'].slice(0, 120),
    name: r['name'].slice(0, 80),
    createdAt: finite(r['createdAt']) ? r['createdAt'] : 0,
    tracks: tracks.map((t) => ({ ...t, name: t.name.slice(0, 200) })),
  };
}

// ── Qué le enseña un perfil a un género ───────────────────────────────────────

/** Lo que el compositor usa de un perfil para un género concreto. */
export interface StyleHint {
  /** Pistas que encajaron con el género (por tempo). */
  matched: number;
  bpm: number | null;
  keyRoot: number | null;
  keyMode: 'major' | 'minor' | null;
  swing: number;
  /** Carriles normalizados (máximo = 1) para mezclar con los del género. */
  lanes: { low: number[]; mid: number[]; high: number[] } | null;
  brightness: number;
  grit: number;
}

/**
 * El tempo de una pista llevado al rango del género: un trap a 70 «es» un
 * trap a 140 (half-time), y un dembow medido a 188 es uno a 94. Devuelve
 * `null` si ni doblando ni partiendo cae dentro.
 */
export function fitTempo(bpm: number, genre: ComposerGenre): number | null {
  const { min, max } = GENRE_PRESETS[genre].bpm;
  for (const factor of [1, 2, 0.5, 4, 0.25]) {
    const t = bpm * factor;
    if (t >= min - 2 && t <= max + 2) return t;
  }
  return null;
}

/**
 * Resume las pistas de un perfil que encajan con el género. Si ninguna encaja
 * por tempo, se usan todas para el SONIDO (brillo, suciedad, tonalidad) pero
 * no para el groove — el groove de otro género sería ruido.
 */
export function styleHint(profile: StyleProfile, genre: ComposerGenre): StyleHint {
  const fitted = profile.tracks
    .map((t) => ({ t, bpm: t.bpm === null ? null : fitTempo(t.bpm, genre) }))
    .filter((x): x is { t: TrackFeatures; bpm: number } => x.bpm !== null);
  const pool = fitted.length > 0 ? fitted.map((x) => x.t) : profile.tracks;
  const weightOf = (t: TrackFeatures): number => Math.max(1, t.durationSec);
  let wsum = 0;
  let swing = 0;
  let brightness = 0;
  let grit = 0;
  for (const t of pool) {
    const w = weightOf(t);
    wsum += w;
    swing += t.swing * w;
    brightness += t.brightness * w;
    grit += t.grit * w;
  }
  wsum = wsum || 1;

  let lanes: StyleHint['lanes'] = null;
  if (fitted.length > 0) {
    const acc = { low: new Array(16).fill(0), mid: new Array(16).fill(0), high: new Array(16).fill(0) };
    let lw = 0;
    for (const { t } of fitted) {
      const w = weightOf(t) * (0.5 + t.bpmConfidence);
      lw += w;
      for (const band of ['low', 'mid', 'high'] as const) {
        for (let i = 0; i < 16; i++) acc[band][i] += t.lanes[band][i]! * w;
      }
    }
    const norm = (lane: number[]): number[] => {
      const avg = lane.map((v) => v / (lw || 1));
      const peak = Math.max(...avg);
      return peak > 0 ? avg.map((v) => clamp01(v / peak)) : avg;
    };
    lanes = { low: norm(acc.low), mid: norm(acc.mid), high: norm(acc.high) };
  }

  // Tonalidad: la de la pista con más confianza del grupo.
  const keyed = pool.filter((t) => t.keyRoot !== null).sort((a, b) => b.keyConfidence - a.keyConfidence);
  const bpms = fitted.map((x) => x.bpm).sort((a, b) => a - b);
  return {
    matched: fitted.length,
    bpm: bpms.length > 0 ? bpms[Math.floor(bpms.length / 2)]! : null,
    keyRoot: keyed[0]?.keyRoot ?? null,
    keyMode: keyed[0]?.keyMode ?? null,
    swing: clamp01(swing / wsum),
    lanes,
    brightness: clamp01(brightness / wsum),
    grit: clamp01(grit / wsum),
  };
}

/**
 * El género que mejor le va a una pista: por tempo y por cómo cae el grave
 * (cuatro en el suelo, dembow o sincopado). Es una pista, no un veredicto —
 * sirve para proponer el preset al soltar una referencia.
 */
export function guessGenre(track: TrackFeatures): ComposerGenre {
  const low = track.lanes.low;
  const fourFloor = (low[0]! + low[4]! + low[8]! + low[12]!) / 4;
  const offFloor = (low[2]! + low[6]! + low[10]! + low[14]!) / 4;
  const mid = track.lanes.mid;
  const dembow = (mid[3]! + mid[6]! + mid[11]! + mid[14]!) / 4;
  const bpm = track.bpm ?? 0;
  const candidates: { genre: ComposerGenre; score: number }[] = (Object.keys(GENRE_PRESETS) as ComposerGenre[]).map(
    (genre) => {
      const fitted = bpm > 0 ? fitTempo(bpm, genre) : null;
      let score = fitted === null ? 0 : 1 - Math.abs(fitted - GENRE_PRESETS[genre].bpm.default) / 40;
      if (fitted !== null && Math.abs(fitted - bpm) < 1) score += 0.25; // sin doblar: más creíble
      if (genre === 'techno' || genre === 'rave') score += (fourFloor - offFloor) * 0.8;
      if (genre === 'reggaeton' || genre === 'neoperreo') score += dembow * 0.6 + fourFloor * 0.2;
      if (genre === 'neoperreo') score += (track.grit - 0.5) * 0.4;
      if (genre === 'boombap') score += track.swing * 0.6 - fourFloor * 0.3;
      if (genre === 'trap') score += (track.density.high > 6 ? 0.2 : 0) - fourFloor * 0.2;
      return { genre, score };
    },
  );
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]!.genre;
}
