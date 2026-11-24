/**
 * Presets de género del compositor.
 *
 * Un preset no es un beat: es el ADN de un género — qué tempos le caben, en qué
 * escalas vive, dónde suelen caer bombo, caja y hats, cómo se mueve el bajo,
 * qué acordes lo sostienen y con qué sonidos de Orbit se viste. El compositor
 * tira los dados DENTRO de ese ADN; un perfil de estilo aprendido de audio
 * (ver `profile.ts`) lo empuja hacia lo que suena en los temas del usuario.
 *
 * Los patrones de batería se escriben como un compás de 16 semicorcheas, un
 * carácter por paso, y cada carácter es una PROBABILIDAD con su fuerza:
 *
 *   `X` siempre, fuerte · `x` siempre · `o` a menudo (65 %) · `?` a veces (30 %)
 *   `g` nota fantasma (45 %, floja) · `.` nunca
 *
 * Así un mismo preset da grooves distintos con cada semilla sin salirse del
 * género: el dembow sigue siendo dembow, pero no es el mismo dembow siempre.
 */

import type { InstrumentKind } from '@orbit/core';

export const COMPOSER_GENRES = ['trap', 'reggaeton', 'neoperreo', 'boombap', 'techno', 'rave'] as const;
export type ComposerGenre = (typeof COMPOSER_GENRES)[number];

export function isComposerGenre(value: unknown): value is ComposerGenre {
  return typeof value === 'string' && (COMPOSER_GENRES as readonly string[]).includes(value);
}

/** Las partes del beat. Cada una acaba en su propio canal, patrón y pista. */
export const COMPOSER_ROLES = ['kick', 'snare', 'hats', 'perc', 'bass', 'chords', 'melody', 'fx'] as const;
export type ComposerRole = (typeof COMPOSER_ROLES)[number];

export function isComposerRole(value: unknown): value is ComposerRole {
  return typeof value === 'string' && (COMPOSER_ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<ComposerRole, string> = {
  kick: 'Bombo',
  snare: 'Caja',
  hats: 'Hats',
  perc: 'Percusión',
  bass: 'Bajo',
  chords: 'Acordes',
  melody: 'Melodía',
  fx: 'FX',
};

/** Un paso del compás: probabilidad de sonar y fuerza cuando suena. */
export interface StepProb {
  p: number;
  vel: number;
}

/** Un carril de batería: 16 pasos y la pieza del kit que toca (DRUM_MAP). */
export interface DrumLane {
  key: number;
  steps: StepProb[];
}

/** Con qué se viste una parte: un instrumento de Orbit ya configurado. */
export interface SoundChoice {
  kind: InstrumentKind;
  /** Nombre del preset (Prisma o Nova, según `kind`). */
  preset?: string;
  params?: Record<string, number>;
  volume?: number;
}

/** Inserto de mezcla de una parte (o del master). */
export interface FxChoice {
  kind: 'eq' | 'compressor' | 'limiter' | 'reverb' | 'delay' | 'distortion' | 'bitcrush' | 'chorus' | 'vinyl' | 'stereo' | 'autofilter';
  params: Record<string, number>;
}

export type BassStyle =
  /** 808 largo que sigue la raíz, con glide entre notas. */
  | '808'
  /** Sub corto pegado al bombo (reggaetón). */
  | 'sub'
  /** Bajo tocado: notas cortas, saltos de quinta y octava (boom bap). */
  | 'walk'
  /** Bajo a contratiempo, en corcheas (techno). */
  | 'offbeat'
  /** Semicorcheas rodando entre bombos (rave / hardtek). */
  | 'rolling';

export type ChordStyle =
  /** Acordes largos, uno por compás. */
  | 'pad'
  /** Golpes cortos a contratiempo. */
  | 'stabs'
  /** El rasgueo sincopado del perreo (3-3-2). */
  | 'perreo'
  /** Acordes de séptima/novena en la parte débil, como un sample troceado. */
  | 'chops';

export type MelodyStyle =
  /** Motivo corto y oscuro que se repite (campanas, flauta, piano). */
  | 'motif'
  /** Arpegio sobre el acorde. */
  | 'arp'
  /** Frase cantable, con huecos para la voz. */
  | 'hook'
  /** Riff hipnótico de una o dos notas (techno). */
  | 'riff';

export interface GenrePreset {
  id: ComposerGenre;
  name: string;
  description: string;
  bpm: { min: number; max: number; default: number };
  /** Swing del proyecto 0..1. */
  swing: number;
  /** Escalas (nombres de `SCALES`) con su peso. */
  scales: { name: string; weight: number }[];
  /** Grados de la escala (0 = tónica) por compás, uno por acorde. */
  progressions: number[][];
  /** Tónica preferida (0 = C) con su peso; vacío = cualquiera. */
  roots?: { root: number; weight: number }[];
  drums: {
    kick: string[];
    snare: string[];
    hats: string[];
    perc: string[];
    /** Pieza del kit de cada carril. */
    keys: { kick: number; snare: number; hats: number; perc: number; openhat?: number };
    /** Probabilidad de un redoble de hats (1/32 o tresillo) por compás. */
    hatRolls: number;
    /** Probabilidad de hat abierto en el contratiempo de un compás. */
    openHats: number;
    /** Pieza de caja que dobla con palmas en el drop (si hay). */
    clapLayer?: number;
  };
  bass: { style: BassStyle; glide: number; octave: number };
  chords: { style: ChordStyle; sevenths: number; octave: number };
  melody: { style: MelodyStyle; density: number; octave: number };
  sounds: Record<Exclude<ComposerRole, 'kick' | 'snare' | 'hats' | 'perc'> | 'drums', SoundChoice[]>;
  /** Parámetros del canal de batería (kit, tone, decay, punch). */
  kit: Record<string, number>;
  /** Insertos por parte, además de la cadena del master. */
  fx: Partial<Record<ComposerRole, FxChoice[]>>;
  master: FxChoice[];
  /** Índice de forma en `planSections` que mejor le sienta (se rota con la semilla). */
  shapes: number[];
}

// ── Notación de pasos ─────────────────────────────────────────────────────────

const STEP_CODES: Record<string, StepProb> = {
  X: { p: 1, vel: 1 },
  x: { p: 1, vel: 0.85 },
  o: { p: 0.65, vel: 0.78 },
  '?': { p: 0.3, vel: 0.7 },
  g: { p: 0.45, vel: 0.38 },
  '.': { p: 0, vel: 0 },
};

/** `'x...x...'` → 16 pasos. Lanza si la cadena no mide 16 o trae un código raro. */
export function parseSteps(pattern: string): StepProb[] {
  const clean = pattern.replace(/\s+/g, '');
  if (clean.length !== 16) throw new Error(`patrón de ${clean.length} pasos (deben ser 16): "${pattern}"`);
  return [...clean].map((c) => {
    const code = STEP_CODES[c];
    if (!code) throw new Error(`código de paso desconocido "${c}" en "${pattern}"`);
    return { ...code };
  });
}

// Piezas del kit (DRUM_MAP de core/params.ts).
const KICK = 36;
const RIM = 37;
const SNARE = 38;
const CLAP = 39;
const HAT = 42;
const OPENHAT = 46;
const CONGA = 48;
const SHAKER = 70;

/** Low-end en mono por debajo de 110 Hz (regla 3 del repo), antes del limitador. */
const MONO_LOW: FxChoice = { kind: 'stereo', params: { width: 1, gain: 1, monoBelow: 110 } };
const LIMITER = (gain: number): FxChoice => ({ kind: 'limiter', params: { gain, ceiling: -1 } });

// ── Los géneros ───────────────────────────────────────────────────────────────

export const GENRE_PRESETS: Record<ComposerGenre, GenrePreset> = {
  trap: {
    id: 'trap',
    name: 'Trap',
    description: 'Half-time a 140, 808 largo con glide, hats con redobles y melodía oscura.',
    bpm: { min: 130, max: 160, default: 142 },
    swing: 0,
    scales: [
      { name: 'Menor natural', weight: 4 },
      { name: 'Menor armónica', weight: 3 },
      { name: 'Frigio', weight: 2 },
    ],
    progressions: [
      [0, 5, 3, 4],
      [0, 0, 5, 6],
      [0, 3, 5, 4],
      [0, 6, 5, 4],
      [0, 5, 0, 6],
    ],
    drums: {
      kick: ['X.....x...x.....', 'X......x..x...o.', 'X.....x.?.x...?.', 'X..x......x..?..'],
      snare: ['........X.......', '........X.....g.', '........X...g...'],
      hats: ['x.x.x.x.x.x.x.x.', 'xoxoxoxoxoxoxoxo', 'x.xox.x.x.xox.x.'],
      perc: ['......?.......?.', '...?.......?....'],
      keys: { kick: KICK, snare: SNARE, hats: HAT, perc: RIM, openhat: OPENHAT },
      hatRolls: 0.55,
      openHats: 0.15,
      clapLayer: CLAP,
    },
    bass: { style: '808', glide: 0.45, octave: 2 },
    chords: { style: 'pad', sevenths: 0.2, octave: 4 },
    melody: { style: 'motif', density: 5, octave: 6 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'sub808', params: { decay: 1.6, drive: 0.45, glide: 0.08, punch: 0.6, tone: 900 } },
        { kind: 'prisma', preset: 'bass/808-carbon' },
      ],
      chords: [
        { kind: 'prisma', preset: 'pads/pad-cine-oscuro', volume: 0.5 },
        { kind: 'prisma', preset: 'strings/cuerdas-cine', volume: 0.5 },
        { kind: 'nova', preset: 'pads/pad-oscuro', volume: 0.5 },
      ],
      melody: [
        { kind: 'prisma', preset: 'bells/campana-lejana', volume: 0.6 },
        { kind: 'prisma', preset: 'keys/piano-drill', volume: 0.62 },
        { kind: 'nova', preset: 'leads/flauta-trap', volume: 0.6 },
        { kind: 'prisma', preset: 'plucks/pluck-metal-drill', volume: 0.6 },
      ],
      fx: [{ kind: 'prisma', preset: 'fx/riser-cinta', volume: 0.45 }],
    },
    kit: { kit: 0, tone: 0.55, decay: 1, punch: 0.65 },
    fx: {
      melody: [{ kind: 'reverb', params: { size: 0.7, damp: 0.45, width: 1, predelay: 0.02 } }],
      chords: [{ kind: 'eq', params: { hpFreq: 180 } }],
    },
    master: [MONO_LOW, LIMITER(1.8)],
    shapes: [0, 1, 2],
  },

  reggaeton: {
    id: 'reggaeton',
    name: 'Reggaetón',
    description: 'Dembow a 94, sub pegado al bombo, plucks y acordes con rasgueo de perreo.',
    bpm: { min: 88, max: 100, default: 94 },
    swing: 0,
    scales: [
      { name: 'Menor natural', weight: 5 },
      { name: 'Dórico', weight: 2 },
      { name: 'Mayor', weight: 1 },
    ],
    progressions: [
      [0, 5, 2, 6],
      [0, 6, 5, 6],
      [0, 3, 6, 2],
      [5, 6, 0, 0],
    ],
    drums: {
      kick: ['X...x...X...x...', 'X...x...X...x..?'],
      snare: ['...x..x....x..x.', '...x..x....x..xo'],
      hats: ['x.x.x.x.x.x.x.x.', 'x?x.x?x.x?x.x?x.'],
      perc: ['..o...o...o...o.', '.?..o..?..?.o...'],
      keys: { kick: KICK, snare: SNARE, hats: SHAKER, perc: RIM, openhat: OPENHAT },
      hatRolls: 0.05,
      openHats: 0.1,
      clapLayer: CLAP,
    },
    bass: { style: 'sub', glide: 0.1, octave: 2 },
    chords: { style: 'perreo', sevenths: 0.15, octave: 4 },
    melody: { style: 'hook', density: 4, octave: 5 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'prisma', preset: 'bass/dembow-goma' },
        { kind: 'sub808', params: { decay: 0.9, drive: 0.25, glide: 0.03, punch: 0.55, tone: 700 } },
      ],
      chords: [
        { kind: 'nova', preset: 'organs/organo-perreo', volume: 0.55 },
        { kind: 'prisma', preset: 'plucks/pluck-dembow', volume: 0.55 },
        { kind: 'prisma', preset: 'guitars/requinto-latino', volume: 0.55 },
      ],
      melody: [
        { kind: 'prisma', preset: 'leads/talkbox-latino', volume: 0.55 },
        { kind: 'prisma', preset: 'plucks/pluck-dembow', volume: 0.55 },
        { kind: 'prisma', preset: 'leads/melodica-caribe', volume: 0.55 },
      ],
      fx: [{ kind: 'prisma', preset: 'fx/barrido-inverso', volume: 0.4 }],
    },
    kit: { kit: 2, tone: 0.55, decay: 0.9, punch: 0.6 },
    fx: {
      chords: [{ kind: 'delay', params: { time: 3, feedback: 0.28, filter: 3500 } }],
      melody: [{ kind: 'reverb', params: { size: 0.5, damp: 0.5, width: 1, predelay: 0.02 } }],
    },
    master: [MONO_LOW, LIMITER(2)],
    shapes: [0, 2],
  },

  neoperreo: {
    id: 'neoperreo',
    name: 'Neo perreo',
    description:
      'Dembow roto y sucio: bajo distorsionado, sintes oscuros con aire Y2K, batería lo-fi y huecos raros.',
    bpm: { min: 90, max: 106, default: 98 },
    swing: 0.04,
    scales: [
      { name: 'Frigio', weight: 4 },
      { name: 'Menor natural', weight: 3 },
      { name: 'Menor armónica', weight: 2 },
    ],
    progressions: [
      [0, 1, 0, 6],
      [0, 0, 5, 1],
      [0, 6, 5, 1],
      [0, 3, 1, 0],
    ],
    drums: {
      // El dembow se rompe: el bombo se salta un pulso, la caja se trocea.
      kick: ['X...x...X...?...', 'X.......X...x...', 'X...x..?X.....x.', 'X..?....X...x...'],
      snare: ['...x..x....x..x.', '...x..xo...x..x.', '...x.......x..xg', '...x..x.g..x..x.'],
      hats: ['x...x...x...x...', 'x.?.x.?.x.?.x.?.', '..x...x...x...x.'],
      perc: ['..?...o...?...o.', '.o..?..o.?..o...', 'o..?..o...o..?..'],
      keys: { kick: KICK, snare: RIM, hats: HAT, perc: CONGA, openhat: OPENHAT },
      hatRolls: 0.2,
      openHats: 0.2,
      clapLayer: SNARE,
    },
    bass: { style: 'sub', glide: 0.35, octave: 2 },
    chords: { style: 'stabs', sevenths: 0.1, octave: 4 },
    melody: { style: 'riff', density: 4, octave: 5 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'sub808', params: { decay: 1.2, drive: 0.75, glide: 0.07, punch: 0.7, tone: 1600 } },
        { kind: 'prisma', preset: 'bass/reese-partido' },
        { kind: 'prisma', preset: 'bass/808-carbon' },
      ],
      chords: [
        { kind: 'prisma', preset: 'pads/pad-vapor', volume: 0.5 },
        { kind: 'prisma', preset: 'pads/pad-neon-house', volume: 0.5 },
        { kind: 'prisma', preset: 'keys/juguete-metalico', volume: 0.5 },
      ],
      melody: [
        { kind: 'prisma', preset: 'leads/sync-neon', volume: 0.5 },
        { kind: 'prisma', preset: 'leads/chicle-neon', volume: 0.52 },
        { kind: 'nova', preset: 'leads/square-8bit', volume: 0.5 },
        { kind: 'prisma', preset: 'arps/arp-neon', volume: 0.5 },
      ],
      fx: [{ kind: 'prisma', preset: 'fx/laser', volume: 0.4 }],
    },
    kit: { kit: 2, tone: 0.4, decay: 0.8, punch: 0.75 },
    fx: {
      kick: [{ kind: 'distortion', params: { drive: 0.25, tone: 5000, output: 0.9 } }],
      snare: [{ kind: 'bitcrush', params: { bits: 10, downsample: 2 } }],
      bass: [{ kind: 'distortion', params: { drive: 0.35, tone: 3500, output: 0.85 } }],
      melody: [
        { kind: 'chorus', params: {} },
        { kind: 'reverb', params: { size: 0.6, damp: 0.6, width: 1, predelay: 0.03 } },
      ],
      chords: [{ kind: 'eq', params: { hpFreq: 220, highGain: -2 } }],
    },
    master: [MONO_LOW, LIMITER(1.8)],
    shapes: [0, 1, 2],
  },

  boombap: {
    id: 'boombap',
    name: 'Boom bap',
    description: 'A 90 con swing, caja seca en 2 y 4, bajo tocado y acordes de séptima troceados.',
    bpm: { min: 82, max: 96, default: 90 },
    swing: 0.55,
    scales: [
      { name: 'Dórico', weight: 4 },
      { name: 'Menor natural', weight: 3 },
      { name: 'Blues', weight: 1 },
    ],
    progressions: [
      [0, 3, 0, 4],
      [1, 4, 0, 0],
      [0, 5, 3, 4],
      [0, 0, 3, 3],
    ],
    drums: {
      kick: ['X......x..x.....', 'X.?....x..x..?..', 'X......x.x......', 'X.x....x..x...?.'],
      snare: ['....X.......X...', '....X......gX...', '....X..g....X..g'],
      hats: ['x.x.x.x.x.x.x.x.', 'x.o.x.o.x.o.x.o.', 'x?x?x?x?x?x?x?x?'],
      perc: ['..............?.', '......?.......?.'],
      keys: { kick: KICK, snare: SNARE, hats: HAT, perc: RIM, openhat: OPENHAT },
      hatRolls: 0,
      openHats: 0.25,
    },
    bass: { style: 'walk', glide: 0, octave: 2 },
    chords: { style: 'chops', sevenths: 0.85, octave: 4 },
    melody: { style: 'hook', density: 3, octave: 5 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'prisma', preset: 'bass/upright-humo' },
        { kind: 'prisma', preset: 'bass/slap-dedo' },
      ],
      chords: [
        { kind: 'prisma', preset: 'keys/ep-cremoso', volume: 0.6 },
        { kind: 'prisma', preset: 'keys/piano-cinta', volume: 0.6 },
        { kind: 'nova', preset: 'keys/rhodes-calido', volume: 0.6 },
      ],
      melody: [
        { kind: 'prisma', preset: 'brass/saxo-noche', volume: 0.5 },
        { kind: 'prisma', preset: 'leads/flauta-humo', volume: 0.5 },
        { kind: 'prisma', preset: 'guitars/electrica-limpia', volume: 0.5 },
      ],
      fx: [{ kind: 'prisma', preset: 'atmos/cinta-polvo', volume: 0.35 }],
    },
    kit: { kit: 1, tone: 0.45, decay: 1, punch: 0.55 },
    fx: {
      chords: [
        { kind: 'eq', params: { hpFreq: 160, highGain: -3, lpFreq: 9000 } },
        { kind: 'vinyl', params: {} },
      ],
      snare: [{ kind: 'reverb', params: { size: 0.35, damp: 0.6, width: 0.8, predelay: 0.01 } }],
    },
    master: [MONO_LOW, LIMITER(1.4)],
    shapes: [1, 0],
  },

  techno: {
    id: 'techno',
    name: 'Techno',
    description: 'Cuatro en el suelo a 134, bajo a contratiempo, hats en semicorcheas y un riff hipnótico.',
    bpm: { min: 126, max: 140, default: 134 },
    swing: 0.08,
    scales: [
      { name: 'Menor natural', weight: 3 },
      { name: 'Frigio', weight: 3 },
      { name: 'Dórico', weight: 2 },
    ],
    progressions: [
      [0, 0, 0, 0],
      [0, 0, 5, 0],
      [0, 6, 0, 6],
    ],
    roots: [
      { root: 9, weight: 2 },
      { root: 5, weight: 2 },
      { root: 7, weight: 1 },
      { root: 2, weight: 1 },
    ],
    drums: {
      kick: ['X...X...X...X...'],
      snare: ['....x.......x...', '....x.......x..?'],
      hats: ['xoxoxoxoxoxoxoxo', 'x?x?x?x?x?x?x?x?', '.x.x.x.x.x.x.x.x'],
      perc: ['...?..o....?..o.', '..o..?...o...?..', '.?...o.?...o....'],
      keys: { kick: KICK, snare: CLAP, hats: HAT, perc: RIM, openhat: OPENHAT },
      hatRolls: 0.05,
      openHats: 0.9,
    },
    bass: { style: 'offbeat', glide: 0, octave: 2 },
    chords: { style: 'stabs', sevenths: 0.3, octave: 4 },
    melody: { style: 'riff', density: 6, octave: 5 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'prisma', preset: 'bass/acido-303' },
        { kind: 'prisma', preset: 'bass/house-redondo' },
      ],
      chords: [
        { kind: 'prisma', preset: 'plucks/pluck-house', volume: 0.45 },
        { kind: 'prisma', preset: 'pads/pad-analogico', volume: 0.45 },
      ],
      melody: [
        { kind: 'prisma', preset: 'arps/arp-sombrio', volume: 0.45 },
        { kind: 'prisma', preset: 'leads/sync-neon', volume: 0.45 },
        { kind: 'prisma', preset: 'arps/arp-trance', volume: 0.45 },
      ],
      fx: [{ kind: 'prisma', preset: 'atmos/motor-lejano', volume: 0.35 }],
    },
    kit: { kit: 0, tone: 0.5, decay: 0.7, punch: 0.8 },
    fx: {
      melody: [{ kind: 'delay', params: { time: 3, feedback: 0.4, filter: 2500 } }],
      chords: [{ kind: 'reverb', params: { size: 0.6, damp: 0.5, width: 1, predelay: 0.02 } }],
      perc: [{ kind: 'eq', params: { hpFreq: 300 } }],
    },
    master: [MONO_LOW, LIMITER(1.6)],
    shapes: [0, 1],
  },

  rave: {
    id: 'rave',
    name: 'Rave',
    description: 'A 156 y sin frenos: bombo saturado, bajo rodando en semicorcheas y lead de sierra.',
    bpm: { min: 145, max: 165, default: 156 },
    swing: 0,
    scales: [
      { name: 'Menor natural', weight: 3 },
      { name: 'Frigio', weight: 2 },
      { name: 'Menor armónica', weight: 2 },
    ],
    progressions: [
      [0, 0, 5, 6],
      [0, 5, 6, 4],
      [0, 0, 0, 6],
    ],
    drums: {
      kick: ['X...X...X...X...'],
      snare: ['....x.......x...', '....x.......x.x.'],
      hats: ['..x...x...x...x.', 'x.x.x.x.x.x.x.x.'],
      perc: ['x?x?x?x?x?x?x?x?', '.x.x.x.x.x.x.x.x'],
      keys: { kick: KICK, snare: CLAP, hats: OPENHAT, perc: HAT },
      hatRolls: 0.15,
      openHats: 0,
    },
    bass: { style: 'rolling', glide: 0, octave: 2 },
    chords: { style: 'pad', sevenths: 0, octave: 4 },
    melody: { style: 'riff', density: 8, octave: 5 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'prisma', preset: 'bass/hardtek-motor' },
        { kind: 'prisma', preset: 'bass/reese-partido' },
      ],
      chords: [
        { kind: 'prisma', preset: 'pads/pad-catedral', volume: 0.42 },
        { kind: 'nova', preset: 'pads/coro-aire', volume: 0.42 },
      ],
      melody: [
        { kind: 'prisma', preset: 'leads/sierra-hardtek', volume: 0.45 },
        { kind: 'nova', preset: 'leads/hard-lead', volume: 0.45 },
      ],
      fx: [{ kind: 'prisma', preset: 'fx/sirena-drill', volume: 0.35 }],
    },
    kit: { kit: 0, tone: 0.6, decay: 0.6, punch: 0.9 },
    fx: {
      kick: [{ kind: 'distortion', params: { drive: 0.4, tone: 6000, output: 0.8 } }],
      melody: [{ kind: 'reverb', params: { size: 0.75, damp: 0.4, width: 1, predelay: 0.02 } }],
      chords: [{ kind: 'eq', params: { hpFreq: 250 } }],
    },
    master: [MONO_LOW, LIMITER(1.6)],
    shapes: [0, 1],
  },
};

export function genrePreset(genre: ComposerGenre): GenrePreset {
  return GENRE_PRESETS[genre];
}

/** Carriles de batería de un género ya parseados (los usa el compositor y los tests). */
export function genreDrumLanes(
  genre: ComposerGenre,
): Record<'kick' | 'snare' | 'hats' | 'perc', { key: number; variants: StepProb[][] }> {
  const d = GENRE_PRESETS[genre].drums;
  return {
    kick: { key: d.keys.kick, variants: d.kick.map(parseSteps) },
    snare: { key: d.keys.snare, variants: d.snare.map(parseSteps) },
    hats: { key: d.keys.hats, variants: d.hats.map(parseSteps) },
    perc: { key: d.keys.perc, variants: d.perc.map(parseSteps) },
  };
}
