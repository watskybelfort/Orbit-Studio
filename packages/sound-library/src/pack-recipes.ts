/**
 * Recetas de packs a medida: "dame 12 hats de drill".
 *
 * Cada sonido es un proyecto compilado mínimo —un canal del motor de la app,
 * una nota y, si hace falta, un par de efectos en el master— listo para
 * `renderProject`. Es el mismo camino con el que se generó el pack de fábrica
 * (packages/sound-library/generate), pero aquí vive en `src/` porque lo usa la
 * app en caliente: Claude pide un pack por su tool y esto decide QUÉ hay que
 * renderizar; quien lo renderiza y lo escribe es el runner de la UI.
 *
 * Determinista de punta a punta: las variaciones salen de un hash del índice
 * (más la semilla que se pida), nunca de Math.random. Dos veces el mismo
 * encargo dan exactamente el mismo pack, que es lo que permite rehacerlo si se
 * borra y que un test lo compare.
 */

import type {
  CompiledAutomationEvent,
  CompiledChannel,
  CompiledEffect,
  CompiledMixerTrack,
  CompiledNoteEvent,
  CompiledProject,
} from '@orbit/engine/protocol';
import type { SoundCategory } from './types';

// ── Encargo ──────────────────────────────────────────────────────────────────

export const PACK_FAMILIES = [
  'kicks',
  'snares',
  'claps',
  'hats',
  'openhats',
  'percs',
  '808s',
  'impacts',
  'risers',
  'downlifters',
] as const;
export type PackFamily = (typeof PACK_FAMILIES)[number];

export const PACK_STYLES = ['trap', 'drill', 'boombap', 'latin', 'house', 'techno', 'lofi'] as const;
export type PackStyle = (typeof PACK_STYLES)[number];

export const MAX_PACK_SOUNDS = 32;
const DEFAULT_COUNT = 8;

export interface PackRequest {
  family: PackFamily;
  /** Carácter del pack; por defecto 'trap'. */
  style?: PackStyle;
  /** Cuántos sonidos (1..32, por defecto 8). */
  count?: number;
  /** Nombre visible del pack; por defecto sale de familia + estilo. */
  name?: string;
  /** Nota raíz de los 808s ('C', 'D#', 'F'…); por defecto 'C'. */
  key?: string;
  /** Desplaza TODAS las variaciones sin cambiar nada más. */
  seed?: number;
}

export interface PackSoundSpec {
  /** Id estable dentro del pack, ej. "hats/hat-03". */
  id: string;
  name: string;
  category: SoundCategory;
  subcategory?: string;
  /** Ruta del WAV relativa a la raíz del pack. */
  file: string;
  tags: string[];
  keyRoot?: string;
  gainSuggestion: number;
  /** Qué hay que renderizar. */
  project: CompiledProject;
  /** Cola a renderizar después del final del timeline, en segundos. */
  tail: number;
  /** Tope duro de duración del archivo. */
  maxSec: number;
}

export interface PackPlan {
  /** Nombre visible ("Hats de drill"). */
  name: string;
  /** Carpeta del pack, en minúsculas y sin acentos. */
  slug: string;
  family: PackFamily;
  style: PackStyle;
  sounds: PackSoundSpec[];
}

// ── Variación determinista ───────────────────────────────────────────────────

/** Hash FNV-1a de una cadena (misma idea que el generador de fábrica). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Valor 0..1 estable para (índice, semilla, campo). */
function unit(index: number, seed: number, field: string): number {
  return hash(`${field}:${index}:${seed}`) / 0x100000000;
}

/**
 * Reparte `count` valores por el rango [min, max]: el primero abajo, el último
 * arriba y el resto escalonado con un empujón propio de cada uno. Así un pack
 * de 12 hats recorre TODO el carácter de la familia en vez de amontonar doce
 * variaciones parecidas alrededor del centro.
 */
function spread(
  index: number,
  count: number,
  seed: number,
  field: string,
  min: number,
  max: number,
): number {
  const step = count <= 1 ? 0.5 : index / (count - 1);
  const jitter = (unit(index, seed, field) - 0.5) * ((max - min) / Math.max(2, count));
  return Math.min(max, Math.max(min, min + step * (max - min) + jitter));
}

// ── Constructores de proyecto ────────────────────────────────────────────────

/** Piezas del kit de drums (DRUM_MAP de core/model/params.ts). */
const DRUM = {
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  hat: 42,
  tom: 45,
  openhat: 46,
  conga: 48,
  crash: 49,
  shaker: 70,
} as const;

/** Semitonos de cada nota respecto a C (para la raíz de los 808s). */
const NOTE_OFFSETS: Record<string, number> = {
  C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11,
};

function channel(kind: string, params: Record<string, number>, volume = 0.85): CompiledChannel {
  return {
    id: 'ch-0',
    kind: kind as CompiledChannel['kind'],
    params,
    volume,
    pan: 0,
    audible: true,
    mixerTrack: 0,
  };
}

function effect(kind: string, params: Record<string, number>, mix = 1): CompiledEffect {
  return { id: `fx-${kind}`, kind: kind as CompiledEffect['kind'], enabled: true, mix, params };
}

function note(start: number, duration: number, key: number, velocity = 1): CompiledNoteEvent {
  return { start, duration, key, velocity, pan: 0, slide: false, channelIndex: 0 };
}

function project(o: {
  lengthBeats: number;
  channels: CompiledChannel[];
  events: CompiledNoteEvent[];
  masterSlots?: CompiledEffect[];
  automation?: CompiledAutomationEvent[];
}): CompiledProject {
  const master: CompiledMixerTrack = {
    id: 'master',
    volume: 1,
    pan: 0,
    stereoWidth: 1,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    audible: true,
    slots: o.masterSlots ?? [],
    routeTo: null,
    sends: [],
  };
  return {
    tempo: 120,
    lengthBeats: o.lengthBeats,
    channels: o.channels,
    events: o.events,
    audioClips: [],
    automation: o.automation ?? [],
    lfos: [],
    mixer: [master],
    mixerOrder: [0],
  };
}

/** Rampa exponencial muestreada (para los barridos de filtro). */
function expRamp(from: number, to: number, beats: number, step = 0.25): number[] {
  const n = Math.max(1, Math.ceil(beats / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(from * Math.pow(to / from, i / n));
  return out;
}

// ── Carácter de cada estilo ──────────────────────────────────────────────────

interface StyleTraits {
  /** Kit de drums: 0 trap · 1 boom bap · 2 latin. */
  kit: number;
  /** Multiplicador del decay (lo corto o largo que suena el estilo). */
  decay: number;
  /** Pegada. */
  punch: number;
  /** Suciedad del master (0 = limpio). */
  dirt: number;
}

const STYLES: Record<PackStyle, StyleTraits> = {
  trap: { kit: 0, decay: 1, punch: 0.7, dirt: 0 },
  drill: { kit: 0, decay: 0.8, punch: 0.85, dirt: 0.15 },
  boombap: { kit: 1, decay: 1.05, punch: 0.55, dirt: 0.25 },
  latin: { kit: 2, decay: 1, punch: 0.6, dirt: 0 },
  house: { kit: 0, decay: 0.7, punch: 0.85, dirt: 0.1 },
  techno: { kit: 0, decay: 0.75, punch: 0.95, dirt: 0.35 },
  lofi: { kit: 1, decay: 1.1, punch: 0.45, dirt: 0.5 },
};

/** Efectos de master que le dan al estilo su suciedad (vacío si va limpio). */
function dirtSlots(style: PackStyle, index: number, seed: number): CompiledEffect[] {
  const { dirt } = STYLES[style];
  if (dirt <= 0) return [];
  const slots: CompiledEffect[] = [
    effect(
      'distortion',
      { drive: 0.2 + dirt * 0.6, tone: 4000, mode: 0, output: 1 },
      Math.min(0.9, dirt + 0.2),
    ),
  ];
  if (style === 'lofi') {
    slots.push(effect('vinyl', { crackle: 0.3, noise: 0.25, wow: 0.2, flutter: 0.25, tone: 8000 }, 0.5));
    slots.push(
      effect(
        'bitcrush',
        { bits: 9 + Math.round(unit(index, seed, 'bits') * 3), downsample: 4 },
        0.35,
      ),
    );
  }
  return slots;
}

// ── Familias ─────────────────────────────────────────────────────────────────

interface FamilyTraits {
  /** Cómo se llama en singular (para nombres y ficheros). */
  singular: string;
  category: SoundCategory;
  gain: number;
}

const FAMILIES: Record<PackFamily, FamilyTraits> = {
  kicks: { singular: 'kick', category: 'drums', gain: 0.9 },
  snares: { singular: 'snare', category: 'drums', gain: 0.85 },
  claps: { singular: 'clap', category: 'drums', gain: 0.85 },
  hats: { singular: 'hat', category: 'drums', gain: 0.55 },
  openhats: { singular: 'openhat', category: 'drums', gain: 0.6 },
  percs: { singular: 'perc', category: 'percusion-latina', gain: 0.7 },
  '808s': { singular: '808', category: '808s', gain: 0.9 },
  impacts: { singular: 'impact', category: 'fx', gain: 0.8 },
  risers: { singular: 'riser', category: 'fx', gain: 0.8 },
  downlifters: { singular: 'downlifter', category: 'fx', gain: 0.8 },
};

/** Golpe de batería: canal 'drums' con su kit y su pieza. */
function drumHit(
  style: PackStyle,
  key: number,
  index: number,
  count: number,
  seed: number,
  range: { tone: [number, number]; decay: [number, number]; punch: [number, number] },
  tail = 0.6,
): Pick<PackSoundSpec, 'project' | 'tail' | 'maxSec'> {
  const traits = STYLES[style];
  const tone = spread(index, count, seed, 'tone', range.tone[0], range.tone[1]);
  const decay = spread(index, count, seed, 'decay', range.decay[0], range.decay[1]) * traits.decay;
  const punch = spread(index, count, seed, 'punch', range.punch[0], range.punch[1]) * traits.punch;
  const slots = dirtSlots(style, index, seed);
  return {
    project: project({
      lengthBeats: 8,
      channels: [channel('drums', { kit: traits.kit, tone, decay, punch })],
      events: [note(0, 8, key, 1)],
      ...(slots.length > 0 ? { masterSlots: slots } : {}),
    }),
    tail,
    maxSec: 4,
  };
}

/** Percusión: rota entre las piezas del kit latino. */
const PERC_PIECES = [DRUM.conga, DRUM.shaker, DRUM.rim, DRUM.tom] as const;
const PERC_NAMES = ['Conga', 'Shaker', 'Clave', 'Timbal'] as const;

/** 808: nota sostenida del sub808 con su drive. */
function sub808(
  index: number,
  count: number,
  seed: number,
  rootKey: number,
): Pick<PackSoundSpec, 'project' | 'tail' | 'maxSec'> {
  const decay = spread(index, count, seed, 'decay', 0.6, 1.9);
  const drive = spread(index, count, seed, 'drive', 0.25, 0.95);
  const tone = spread(index, count, seed, 'tone', 600, 1800);
  const hold = 2 + decay * 2;
  return {
    project: project({
      lengthBeats: Math.ceil(hold) + 2,
      channels: [channel('sub808', { tune: 0, decay, drive, glide: 0.05, punch: 0.35, tone })],
      events: [note(0, hold, rootKey, 1)],
    }),
    tail: 1,
    maxSec: 4,
  };
}

/** Barrido de supersaw: hacia arriba (riser) o hacia abajo (downlifter). */
function sweep(
  index: number,
  count: number,
  seed: number,
  up: boolean,
): Pick<PackSoundSpec, 'project' | 'tail' | 'maxSec'> {
  const beats = spread(index, count, seed, 'beats', 4, 8);
  const key = 40 + Math.round(spread(index, count, seed, 'key', 0, 7));
  const low = 220 + spread(index, count, seed, 'low', 0, 180);
  const high = 6000 + spread(index, count, seed, 'high', 0, 5000);
  return {
    project: project({
      lengthBeats: beats,
      channels: [
        channel(
          'supersaw',
          {
            detune: spread(index, count, seed, 'detune', 0.35, 0.85),
            blend: 0.85,
            cutoff: 14000,
            attack: up ? 1.2 : 0.05,
            release: 0.35,
            width: 0.9,
            octave: 0,
          },
          0.85,
        ),
      ],
      events: [note(0, beats - 0.2, key, 1), note(0, beats - 0.2, key + 12, 0.8)],
      masterSlots: [
        effect(
          'autofilter',
          {
            type: 0,
            cutoff: up ? low : high,
            resonance: 0.55,
            lfoRate: 0.05,
            lfoAmount: 0,
            envAmount: 0,
          },
          1,
        ),
        effect('reverb', { size: 0.8, damp: 0.3, width: 1, predelay: 0 }, 0.35),
      ],
      automation: [
        {
          startBeat: 0,
          step: 0.25,
          values: up ? expRamp(low, high, beats) : expRamp(high, low, beats),
          target: { scope: 'effect', trackIndex: 0, slotIndex: 0, key: 'cutoff' },
        },
      ],
    }),
    tail: 1.5,
    maxSec: beats / 2 + 1.6,
  };
}

// ── Encargo → plan ───────────────────────────────────────────────────────────

export function isPackFamily(value: unknown): value is PackFamily {
  return typeof value === 'string' && (PACK_FAMILIES as readonly string[]).includes(value);
}

export function isPackStyle(value: unknown): value is PackStyle {
  return typeof value === 'string' && (PACK_STYLES as readonly string[]).includes(value);
}

/** Texto a slug: minúsculas, sin acentos y solo con letras, números y guiones. */
export function slugifyName(text: string): string {
  // \p{Diacritic} en vez de un rango de combinantes: el rango se escribe con
  // caracteres invisibles y en el código fuente no hay quien lo lea.
  const plain = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return plain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';
}

const STYLE_LABELS: Record<PackStyle, string> = {
  trap: 'trap',
  drill: 'drill',
  boombap: 'boom bap',
  latin: 'latinos',
  house: 'house',
  techno: 'techno',
  lofi: 'lo-fi',
};

const FAMILY_LABELS: Record<PackFamily, string> = {
  kicks: 'Kicks',
  snares: 'Snares',
  claps: 'Claps',
  hats: 'Hats',
  openhats: 'Open hats',
  percs: 'Percusión',
  '808s': '808s',
  impacts: 'Impactos',
  risers: 'Risers',
  downlifters: 'Downlifters',
};

/**
 * Traduce el encargo en la lista exacta de sonidos a renderizar. No toca disco
 * ni suena: solo dice qué hay que hacer.
 */
export function planPack(request: PackRequest): PackPlan {
  const family = request.family;
  if (!isPackFamily(family)) throw new Error(`Familia desconocida: ${String(family)}`);
  const style: PackStyle = isPackStyle(request.style) ? request.style : 'trap';
  const count = Math.max(1, Math.min(MAX_PACK_SOUNDS, Math.round(request.count ?? DEFAULT_COUNT)));
  const seed = Number.isFinite(request.seed) ? Math.round(request.seed as number) : 0;
  const traits = FAMILIES[family];

  const keyName = request.key && NOTE_OFFSETS[request.key] !== undefined ? request.key : 'C';
  const rootKey = 24 + (NOTE_OFFSETS[keyName] ?? 0); // C1 = 24

  const name = request.name?.trim() || `${FAMILY_LABELS[family]} de ${STYLE_LABELS[style]}`;
  const sounds: PackSoundSpec[] = [];

  for (let i = 0; i < count; i++) {
    const num = String(i + 1).padStart(2, '0');
    const id = `${family}/${traits.singular}-${num}`;
    const base = {
      id,
      file: `${id}.wav`,
      category: traits.category,
      gainSuggestion: traits.gain,
      tags: [style, traits.singular],
    };

    switch (family) {
      case 'kicks':
        sounds.push({
          ...base,
          name: `Kick ${STYLE_LABELS[style]} ${num}`,
          subcategory: style,
          ...drumHit(style, DRUM.kick, i, count, seed, {
            tone: [0.15, 0.75],
            decay: [0.5, 1.6],
            punch: [0.45, 1],
          }),
        });
        break;
      case 'snares':
        sounds.push({
          ...base,
          name: `Snare ${STYLE_LABELS[style]} ${num}`,
          subcategory: style,
          ...drumHit(style, DRUM.snare, i, count, seed, {
            tone: [0.25, 0.9],
            decay: [0.6, 1.5],
            punch: [0.4, 0.9],
          }),
        });
        break;
      case 'claps':
        sounds.push({
          ...base,
          name: `Clap ${STYLE_LABELS[style]} ${num}`,
          subcategory: style,
          ...drumHit(style, DRUM.clap, i, count, seed, {
            tone: [0.3, 0.85],
            decay: [0.7, 1.6],
            punch: [0.4, 0.85],
          }),
        });
        break;
      case 'hats':
        sounds.push({
          ...base,
          name: `Hat ${STYLE_LABELS[style]} ${num}`,
          subcategory: style,
          ...drumHit(
            style,
            DRUM.hat,
            i,
            count,
            seed,
            { tone: [0.1, 0.95], decay: [0.45, 1.3], punch: [0.3, 0.7] },
            0.4,
          ),
        });
        break;
      case 'openhats':
        sounds.push({
          ...base,
          name: `Open hat ${STYLE_LABELS[style]} ${num}`,
          subcategory: style,
          ...drumHit(style, DRUM.openhat, i, count, seed, {
            tone: [0.2, 0.9],
            decay: [0.8, 1.8],
            punch: [0.3, 0.7],
          }),
        });
        break;
      case 'percs': {
        const piece = PERC_PIECES[i % PERC_PIECES.length]!;
        sounds.push({
          ...base,
          name: `${PERC_NAMES[i % PERC_NAMES.length]} ${num}`,
          subcategory: style === 'latin' ? undefined : style,
          tags: [style, 'perc', PERC_NAMES[i % PERC_NAMES.length]!.toLowerCase()],
          ...drumHit(
            style,
            piece,
            i,
            count,
            seed,
            { tone: [0.15, 0.95], decay: [0.5, 1.5], punch: [0.35, 0.8] },
            0.5,
          ),
        });
        break;
      }
      case '808s':
        sounds.push({
          ...base,
          name: `808 ${keyName} ${num}`,
          keyRoot: keyName,
          tags: [style, '808', 'sub'],
          ...sub808(i, count, seed, rootKey),
        });
        break;
      case 'impacts':
        sounds.push({
          ...base,
          name: `Impacto ${num}`,
          tags: [style, 'fx', 'impact'],
          ...(() => {
            const hit = drumHit(
              style,
              DRUM.kick,
              i,
              count,
              seed,
              { tone: [0.1, 0.5], decay: [1.2, 1.9], punch: [0.7, 1] },
              3,
            );
            hit.project.mixer[0]!.slots = [
              ...hit.project.mixer[0]!.slots,
              effect(
                'reverb',
                {
                  size: spread(i, count, seed, 'size', 0.6, 0.95),
                  damp: 0.35,
                  width: 1,
                  predelay: 0,
                },
                1,
              ),
            ];
            hit.maxSec = 3.5;
            return hit;
          })(),
        });
        break;
      case 'risers':
        sounds.push({
          ...base,
          name: `Riser ${num}`,
          tags: [style, 'fx', 'riser', 'up'],
          ...sweep(i, count, seed, true),
        });
        break;
      case 'downlifters':
        sounds.push({
          ...base,
          name: `Downlifter ${num}`,
          tags: [style, 'fx', 'down'],
          ...sweep(i, count, seed, false),
        });
        break;
    }
  }

  return { name, slug: slugifyName(name), family, style, sounds };
}
