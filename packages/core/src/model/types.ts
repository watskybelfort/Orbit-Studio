/**
 * Modelo de proyecto de Orbit Studio.
 *
 * Reglas de diseño:
 * - Toda entidad tiene `id` estable (nanoid) → merge CRDT y undo inequívocos.
 * - Pools planos (Record<Id, T>) + arrays de orden / claves foráneas; nada de
 *   árboles profundos, para mapear 1:1 a Y.Map/Y.Array.
 * - Tiempos musicales en beats (float, negra = 1). El motor convierte a samples.
 * - Ganancias de usuario en lineal [0..2]; la UI las muestra en dB.
 */

export type Id = string;

// ── Notas ────────────────────────────────────────────────────────────────────

export interface Note {
  id: Id;
  /** Inicio en beats, relativo al patrón. */
  start: number;
  /** Duración en beats. */
  duration: number;
  /** Altura MIDI 0..127 (60 = C5 en convención FL). */
  key: number;
  /** 0..1 */
  velocity: number;
  /** -1..1 */
  pan: number;
  /** Nota slide: la voz activa hace glide hasta esta altura (808). */
  slide: boolean;
}

// ── Canales (instrumentos) ───────────────────────────────────────────────────

export type InstrumentKind =
  | 'sub808'
  | 'synth'
  | 'supersaw'
  | 'fm'
  | 'drums'
  | 'sampler';

export interface Channel {
  id: Id;
  name: string;
  color: string;
  kind: InstrumentKind;
  /** Parámetros del instrumento; claves según PARAM_SPECS[kind]. */
  params: Record<string, number>;
  /** Sample cargado (solo sampler). */
  sampleId?: Id;
  /** Ganancia lineal 0..2. */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** Índice de pista de mixer (0 = Master, 1..N = inserts). */
  mixerTrack: number;
}

// ── Patrones ─────────────────────────────────────────────────────────────────

export interface Pattern {
  id: Id;
  name: string;
  color: string;
  /** Longitud en beats (el step sequencer pinta length*4 pasos de 1/16). */
  length: number;
  /** Notas por canal. */
  notes: Record<Id, Note[]>;
}

// ── Playlist / arrangements ──────────────────────────────────────────────────

export interface Arrangement {
  id: Id;
  name: string;
}

export interface PlaylistTrack {
  id: Id;
  arrangementId: Id;
  name: string;
  color: string;
  /** Altura en px de la fila (UI). */
  height: number;
  muted: boolean;
  /** Posición vertical (0 arriba). */
  order: number;
}

export type ClipKind = 'pattern' | 'audio' | 'automation';

export interface AutomationPoint {
  id: Id;
  /** Beats relativos al inicio del clip. */
  time: number;
  /** Valor normalizado 0..1 (se desnormaliza con el spec del parámetro). */
  value: number;
  /** -1..1: curvatura hacia el siguiente punto (0 = lineal). */
  tension: number;
}

/** Referencia a un parámetro automatizable de cualquier parte del proyecto. */
export type ParamRef =
  | { kind: 'channel'; channelId: Id; param: string }
  | { kind: 'channelMix'; channelId: Id; param: 'volume' | 'pan' }
  | { kind: 'mixer'; trackIndex: number; param: 'volume' | 'pan' | 'stereoWidth' }
  | { kind: 'effect'; trackIndex: number; slotIndex: number; param: string }
  | { kind: 'transport'; param: 'tempo' | 'swing' };

export interface Clip {
  id: Id;
  kind: ClipKind;
  playlistTrackId: Id;
  /** Inicio en beats absolutos de la canción. */
  start: number;
  /** Longitud en beats. */
  length: number;
  muted: boolean;
  color?: string;

  /** kind === 'pattern' */
  patternId?: Id;
  /** Offset en beats dentro del patrón (clips recortados). */
  patternOffset?: number;

  /** kind === 'audio' */
  sampleId?: Id;
  /** Offset en segundos dentro del sample. */
  audioOffset?: number;
  /** Ganancia lineal del clip. */
  audioGain?: number;
  /** Time-stretch: el audio se estira (pitch intacto) para llenar el clip. */
  audioStretch?: boolean;

  /** kind === 'automation' */
  target?: ParamRef;
  points?: AutomationPoint[];
}

export interface Marker {
  id: Id;
  /** Beats absolutos. */
  time: number;
  name: string;
  color: string;
  /** Cambio de tempo a partir de este marcador (opcional). */
  tempo?: number;
}

// ── Mixer ────────────────────────────────────────────────────────────────────

export type EffectKind =
  | 'eq'
  | 'compressor'
  | 'limiter'
  | 'reverb'
  | 'delay'
  | 'chorus'
  | 'flanger'
  | 'phaser'
  | 'distortion'
  | 'bitcrush'
  | 'autofilter'
  | 'gate'
  | 'stereo'
  | 'analyzer'
  | 'plugin';

export interface EffectSlot {
  id: Id;
  kind: EffectKind;
  enabled: boolean;
  /** Dry/wet del slot, 0..1. */
  mix: number;
  params: Record<string, number>;
  /** Pista de mixer que alimenta el detector (compresor sidechain). */
  sidechainSource?: number;
  /** kind === 'plugin': id del plugin JS de usuario que ocupa el slot. */
  pluginId?: string;
}

export const MIXER_SLOTS = 10;

export interface Send {
  /** Índice de pista destino. */
  target: number;
  /** Ganancia lineal 0..2. */
  level: number;
}

export interface MixerTrack {
  id: Id;
  name: string;
  color: string;
  /** Ganancia lineal 0..2 (≈ +6 dB máx). */
  volume: number;
  /** -1..1 */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** 0 = mono, 1 = normal, 2 = extra ancho. */
  stereoWidth: number;
  /** Slots de efectos; longitud fija MIXER_SLOTS, huecos = null. */
  slots: (EffectSlot | null)[];
  /** Pista a la que desemboca (null solo en el master). */
  routeTo: number | null;
  sends: Send[];
}

// ── Samples ──────────────────────────────────────────────────────────────────

export interface SampleRef {
  id: Id;
  name: string;
  /** Ruta absoluta local o `factory:<relpath>` para contenido de fábrica. */
  path: string;
  /** sha1 del archivo — identidad para colaboración/caché. */
  hash: string;
  /** Duración en segundos (informativa). */
  duration: number;
}

// ── Proyecto ─────────────────────────────────────────────────────────────────

export interface TimeSig {
  num: number;
  den: number;
}

export interface ProjectMeta {
  title: string;
  author: string;
  comments: string;
}

export const FORMAT_VERSION = 1;
export const PPQ = 96;

export interface Project {
  formatVersion: typeof FORMAT_VERSION;
  id: Id;
  meta: ProjectMeta;

  tempo: number;
  timeSig: TimeSig;
  /** Swing global 0..1 (desplaza los 1/16 pares). */
  swing: number;

  channels: Record<Id, Channel>;
  channelOrder: Id[];

  patterns: Record<Id, Pattern>;
  patternOrder: Id[];

  arrangements: Record<Id, Arrangement>;
  arrangementOrder: Id[];
  activeArrangementId: Id;

  playlistTracks: Record<Id, PlaylistTrack>;
  clips: Record<Id, Clip>;
  markers: Record<Id, Marker>;

  mixer: MixerTrack[];

  samples: Record<Id, SampleRef>;
}
