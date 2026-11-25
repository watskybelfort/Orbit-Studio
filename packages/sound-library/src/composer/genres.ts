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

import { CHANNEL_SLOTS, type InstrumentKind } from '@orbit/core';

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
  /**
   * Solo `kind: 'sampler'`: instrumento multisampleado de la librería de
   * fábrica (`instrumentos/piano-suave`). Suena a instrumento grabado —con sus
   * tomas por registro y por fuerza— en vez de a sinte.
   */
  instrument?: string;
  params?: Record<string, number>;
  volume?: number;
}

/** Inserto de mezcla de una parte (o del master). */
export interface FxChoice {
  kind: 'eq' | 'compressor' | 'limiter' | 'reverb' | 'delay' | 'distortion' | 'bitcrush' | 'chorus' | 'vinyl' | 'stereo' | 'autofilter';
  params: Record<string, number>;
  /**
   * Solo compresor: la parte cuya pista de mixer alimenta el detector (el
   * sidechain). Al montar el beat se resuelve a la pista que le tocó a esa
   * parte; si el beat no la tiene, el compresor escucha su propia señal.
   */
  sidechainFrom?: ComposerRole;
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
  /** Si el género tiene variantes: cómo se llama la de siempre en el selector («Melódico», «2000»). */
  variantName?: string;
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
    /** Microtiming fijo por carril, en ms (+ = tarde). El boom bap lo lleva; el resto, a la rejilla. */
    feelMs?: Partial<Record<'kick' | 'snare' | 'hats' | 'perc', number>>;
    /** Afina el bombo sampleado a la tónica o la quinta (su altura medida en `DRUM_PITCH`). */
    tuneKick?: boolean;
    /** Capa que suena con el bombo en su misma tecla (el click que el 808 no tapa). */
    kickLayer?: string;
    /** Remate de caja al cerrar cada frase de 4 compases en verso y hook. */
    snareFills?: boolean;
    /**
     * Redobles de timbal (reggaetón de los 2000): en la percusión, al cerrar
     * cada frase de 8, el último compás del hook y —más largo— el compás que
     * entra al hook. Teclas de los dos timbales (sus samples, en `drumKit`).
     */
    timbales?: { hi: number; lo: number };
  };
  /** `hits`: pasos fijos del bajo (si no, sigue al bombo). */
  /** `hits`: pasos fijos del bajo (si no, sigue al bombo). `maxLen`: tope de duración de la nota del bajo `sub`, en tiempos. */
  /** `inIntro`: el bajo ya suena en la intro (por defecto la intro va sin bajo). */
  /** `lowKey`: tecla más grave del bajo (por defecto 27, Re#1); el registro es `lowKey`..`lowKey + 11`. */
  /** `inIntro` numérico (0..1): el bajo entra en esa fracción final de la intro, para que suba hacia el hook. */
  bass: { style: BassStyle; glide: number; octave: number; hits?: number[]; maxLen?: number; inIntro?: boolean | number; lowKey?: number };
  /** `center`: nota MIDI alrededor de la que se colocan los acordes (si no, sale de la octava). */
  /** `openVoicing`: evita dos notas a un semitono en el voicing (barro en el grave). */
  /** `sparseVerse`: en el verso, el rasgueo `perreo` deja huecos para la voz. */
  chords: { style: ChordStyle; sevenths: number; octave: number; center?: number; openVoicing?: boolean; sparseVerse?: boolean };
  /** `range`: tesitura MIDI de la melodía [grave, agudo]; lo que se sale se dobla por octavas. */
  /** `tune`: quita las b9 contra la raíz del acorde y deja respirar la fuerza de las notas. */
  melody: { style: MelodyStyle; density: number; octave: number; range?: [number, number]; tune?: boolean };
  sounds: Record<Exclude<ComposerRole, 'kick' | 'snare' | 'hats' | 'perc'> | 'drums', SoundChoice[]>;
  /** Parámetros del canal de batería (kit, tone, decay, punch). */
  kit: Record<string, number>;
  /**
   * Volumen relativo de cada pieza de batería (1 = el del canal). Medido
   * renderizando cada parte sola: sin esto la percusión se perdía y la caja
   * del boom bap quedaba por debajo del bombo.
   */
  drumMix: Record<'kick' | 'snare' | 'hats' | 'perc', number>;
  /**
   * Batería SAMPLEADA del género: por pieza del kit (tecla de DRUM_MAP), los
   * sonidos de la librería de fábrica que le van (`drums/trap/…`,
   * `drums/boombap/…`, `percusion-latina/…`), uno por semilla. Sin esto, la
   * batería es el kit sintético de Orbit, que es lo que pide el techno y el
   * rave pero no un trap ni un dembow.
   */
  drumKit?: Partial<Record<number, string[]>>;
  /** FX de la librería de fábrica: barrido en la subida e impacto al caer el drop (y, con `hookImpact`, al entrar cada hook). */
  fxKit?: { riser: string; impact: string; hookImpact?: boolean };
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
  /** Golpe seguro pero suave (el par flojo del shaker del dembow). */
  v: { p: 1, vel: 0.55 },
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
/** Los timbales del reggaetón de los 2000 (teclas libres del sampler; no son del DRUM_MAP). */
const TIMBAL_HI = 65;
const TIMBAL_LO = 64;

/** Low-end en mono por debajo de 110 Hz (regla 3 del repo), antes del limitador. */
const MONO_LOW: FxChoice = { kind: 'stereo', params: { width: 1, gain: 1, monoBelow: 110 } };
/**
 * Limitador del master. El techo es de pico de MUESTRA: entre muestras el
 * audio sube más (true peak medido de +0,5 a +1,8 dBTP con techo -1), y eso
 * distorsiona al pasarlo a MP3. Los géneros urbanos llevan -2 de techo, que
 * deja el true peak por debajo de -1 dBTP. `gain` va en dB (entrada al
 * limitador): con él se igualan los géneros urbanos en ~-10 LUFS (boom bap,
 * más dinámico, ~-11,5).
 */
const LIMITER = (gain: number, ceiling = -1): FxChoice => ({ kind: 'limiter', params: { gain, ceiling } });
/**
 * Limitador de los géneros urbanos: detector de true peak y techo -1,2 dBTP
 * (-1 es el estándar de streaming; 0,2 de margen para el codificador MP3/AAC).
 */
const LIMITER_TP = (gain: number): FxChoice => ({ kind: 'limiter', params: { gain, ceiling: -1.2, truePeak: 1 } });

/**
 * Techo de agudos de hats, shakers y cajas: dos pasos bajos seguidos (24 dB/oct).
 * El hat de fábrica tenía el 40 % de su energía por encima de 16 kHz y un pico
 * en 21,7 kHz: era el «agudo raro» y, de paso, lo que hacía subir el true peak
 * del master entre 0,8 y 1,6 dB por encima del pico de muestra.
 */
/**
 * El bajo/808 se agacha cuando pega el bombo: sidechain clásico (4-6 dB, ataque
 * rápido, suelta en ~70 ms). Sin él el 808 tapaba al bombo +6,9 dB en 30-160 Hz.
 */
const DUCK_FROM_KICK: FxChoice = {
  kind: 'compressor',
  params: { threshold: -26, ratio: 6, attack: 0.002, release: 0.07, knee: 3, makeup: 0 },
  sidechainFrom: 'kick',
};

/** Ducking suave para el 808 largo del trap: 4-6 dB, que el cuerpo del 808 no desaparezca. */
const DUCK_SOFT: FxChoice = {
  kind: 'compressor',
  params: { threshold: -18, ratio: 3, attack: 0.002, release: 0.07, knee: 3, makeup: 0 },
  sidechainFrom: 'kick',
};

/**
 * Muesca para después de la reverb del motor, que suena con modos propios en
 * ~3,85-3,95 kHz y ~13,4 kHz (los midió el crítico por stems: eran las dos
 * resonancias fijas del reggaetón de los 2000). Una sola EQ: un canal tiene
 * 4 insertos (`MAX_PART_FX`) y lo que pasa de ahí no suena.
 */
const REVERB_NOTCH: FxChoice = { kind: 'eq', params: { midGain: -10, midFreq: 3900, midQ: 6, highGain: -6, highFreq: 12000, lpFreq: 12000 } };

/**
 * Insertos por parte como mucho: los slots de un canal. Lo que pasa de ahí no
 * llega al canal (se perdían muescas y hasta el sidechain del 808); lo vigila
 * un test.
 */
export const MAX_PART_FX = CHANNEL_SLOTS;

const AIR_CAP = (hz: number): FxChoice[] => [
  { kind: 'eq', params: { lpFreq: hz } },
  { kind: 'eq', params: { lpFreq: hz } },
];

// ── Los géneros ───────────────────────────────────────────────────────────────

/** El reggaetón actual (la variante «moderno»): el que el compositor hacía hasta la v3.18. */
const REGGAETON_MODERNO: GenrePreset = {
  id: 'reggaeton',
  name: 'Reggaetón',
  description: 'Dembow a 94: bombo en las cuatro negras, caja boxy en el tresillo, shaker en semicorcheas, sub corto, guitarra nylon y piano.',
  bpm: { min: 88, max: 100, default: 94 },
  swing: 0,
  scales: [
    { name: 'Menor natural', weight: 6 },
    { name: 'Dórico', weight: 1 },
    { name: 'Mayor', weight: 1 },
  ],
  // i-VI-III-VII, i-iv-VII-III, iv-i-VI-VII, vamp i-VII, VI-VII-i-i.
  progressions: [
    [0, 5, 2, 6],
    [0, 3, 6, 2],
    [3, 0, 5, 6],
    [0, 6, 0, 6],
    [5, 6, 0, 0],
  ],
  drums: {
    kick: ['X...x...X...x...', 'X...x...X...x..?'],
    // La variedad del reggaetón está en la caja: fantasma en el 10 o el 14.
    snare: ['...x..x....x..x.', '...x..x..g.x..x.', '...x..x....x.gx.'],
    // Shaker en las 16 semicorcheas con el acento en el tresillo 3+3+2 del dembow.
    hats: ['xvvxvvxvxvvxvvxv', 'xvvxvvxvxvvxvvx?'],
    // La clave en los huecos de la caja (3, 11, 14), no encima de ella.
    perc: ['..x.......x..x..', '..x.......x..x.o'],
    keys: { kick: KICK, snare: SNARE, hats: SHAKER, perc: RIM },
    hatRolls: 0,
    openHats: 0,
    tuneKick: true,
    snareFills: true,
    clapLayer: CLAP,
  },
  drumKit: {
    [KICK]: ['drums/reggaeton/kick-01', 'drums/reggaeton/kick-02'],
    [SNARE]: ['drums/reggaeton/snare-01', 'drums/reggaeton/snare-02'],
    [CLAP]: ['drums/reggaeton/clap-01'],
    [SHAKER]: ['percusion-latina/shaker-01', 'percusion-latina/shaker-02'],
    [RIM]: ['percusion-latina/rim-01'],
  },
  fxKit: { riser: 'fx/sweep-up-01', impact: 'fx/impact-02' },
  // Bajo corto (0,4 tiempos): con notas largas tapaba al bombo +7 dB.
  bass: { style: 'sub', glide: 0.05, octave: 2, maxLen: 0.4 },
  chords: { style: 'perreo', sevenths: 0.1, octave: 4, center: 62, openVoicing: true, sparseVerse: true },
  melody: { style: 'hook', density: 4, octave: 5, range: [60, 79], tune: true },
  sounds: {
    drums: [{ kind: 'drums' }],
    bass: [
      { kind: 'prisma', preset: 'bass/dembow-goma' },
      { kind: 'sub808', params: { decay: 0.7, drive: 0.2, glide: 0.03, punch: 0.6, tone: 650 } },
    ],
    chords: [
      // Los instrumentos grabados salían 10-19 dB por debajo del pluck (medido):
      // el sampler lleva su ganancia al doble y el pluck baja.
      { kind: 'sampler', instrument: 'instrumentos/guitarra-nylon', params: { gain: 2 }, volume: 1.1 },
      { kind: 'sampler', instrument: 'instrumentos/piano-suave', params: { gain: 2 }, volume: 0.9 },
      { kind: 'prisma', preset: 'plucks/pluck-dembow', volume: 0.42 },
    ],
    melody: [
      { kind: 'sampler', instrument: 'instrumentos/piano-suave', params: { gain: 2 }, volume: 0.85 },
      { kind: 'sampler', instrument: 'instrumentos/guitarra-nylon', params: { gain: 2 }, volume: 0.95 },
      { kind: 'sampler', instrument: 'instrumentos/vibrafono', params: { gain: 2 }, volume: 0.75 },
    ],
    fx: [{ kind: 'sampler', volume: 0.4 }],
  },
  kit: { kit: 2, tone: 0.55, decay: 0.9, punch: 0.6 },
  // La caja del dembow tiene que mandar en medios: estaba 9,4 dB por debajo del bombo.
  drumMix: { kick: 0.95, snare: 1.6, hats: 0.4, perc: 0.9 },
  fx: {
    // Las cuerdas de la nylon resuenan en 4,7 kHz y el piano en 2,2-2,6: valle y techo.
    // La nylon grabada es casi toda lateral (correlación 0,13): se estrecha para que no se pierda en mono.
    chords: [
      { kind: 'eq', params: { hpFreq: 260, lowGain: -3, lowFreq: 320, midGain: -3, midFreq: 2400, midQ: 1.2, highGain: -4, highFreq: 4500, lpFreq: 7500 } },
      { kind: 'stereo', params: { width: 0.3, gain: 1, monoBelow: 0 } },
    ],
    bass: [DUCK_FROM_KICK],
    melody: [
      // Valle en 3 kHz: ahí quedaba la última resonancia medida (+11 dB, 3079 Hz).
      { kind: 'eq', params: { hpFreq: 220, lowGain: -2, lowFreq: 350, midGain: -5, midFreq: 3000, midQ: 1.1, highGain: -3, highFreq: 4500, lpFreq: 8000 } },
      // La nylon grabada es casi toda lateral también cuando toca la melodía (correlación 0,12).
      { kind: 'stereo', params: { width: 0.4, gain: 1, monoBelow: 0 } },
      { kind: 'reverb', params: { size: 0.45, damp: 0.6, width: 0.7, predelay: 0.02 } },
    ],
    snare: [{ kind: 'eq', params: { midGain: 2, midFreq: 250, midQ: 1 } }, ...AIR_CAP(12000)],
    hats: AIR_CAP(11000),
    // El rim de la clave llegaba a 20,8 kHz y subía el true peak 1,1 dB.
    perc: AIR_CAP(12000),
  },
  master: [MONO_LOW, LIMITER_TP(6)],
  shapes: [3, 4],
};

/**
 * El perreo oscuro y despojado (la variante «oscuro»): el neo perreo que hacía
 * el compositor hasta la v3.18. Al usuario le gustó, pero suena a otro
 * género: queda como variante y el neo perreo de siempre pasa a ser el de club.
 */
const NEOPERREO_OSCURO: GenrePreset = {
  id: 'neoperreo',
  name: 'Neo perreo',
  description:
    'Dembow despojado y sucio a 94: bombo clipeado, caja rota en el tresillo, 808 distorsionado, bucle de uno o dos acordes oscuros y un lead de ringtone.',
  bpm: { min: 88, max: 100, default: 94 },
  swing: 0.04,
  scales: [
    { name: 'Frigio', weight: 4 },
    { name: 'Menor natural', weight: 4 },
    { name: 'Menor armónica', weight: 2 },
  ],
  // Uno o dos acordes en bucle: i, i-bVI, i-bII, i-iv.
  progressions: [
    [0, 0, 0, 0],
    [0, 0, 5, 5],
    [0, 1, 0, 1],
    [0, 0, 3, 3],
  ],
  drums: {
    // Bombo en las cuatro negras: con solo el 1 y el 9 era medio tiempo de trap bajo una caja dembow.
    kick: ['X...x...X...x...', 'X...x...X...x...', 'X...x...X...x..?'],
    snare: ['...x..x....x..x.', '...x..x....x..x.', '...x..x....x..xg'],
    // Hats ausentes o a contratiempo.
    hats: ['..x...x...x...x.', '..x.......x.....', '..x...x...x...xo'],
    // Sin conga suelta: dos golpes cada 8 compases sonaban a error.
    perc: [],
    keys: { kick: KICK, snare: RIM, hats: HAT, perc: CONGA, openhat: OPENHAT },
    hatRolls: 0.1,
    openHats: 0.1,
    clapLayer: SNARE,
    tuneKick: true,
    snareFills: true,
  },
  drumKit: {
    [KICK]: ['drums/neoperreo/kick-01', 'drums/neoperreo/kick-02'],
    [RIM]: ['drums/neoperreo/snare-01', 'drums/neoperreo/rim-01'],
    [SNARE]: ['drums/reggaeton/clap-01'],
    [HAT]: ['drums/trap/hat-03'],
    [OPENHAT]: ['drums/trap/openhat-01'],
  },
  fxKit: { riser: 'fx/sweep-up-01', impact: 'fx/subdrop-01' },
  // El 808 largo sobre el 1 y el 9, no en negras pegadas al bombo.
  // `inIntro`: el 808 ya suena en la intro (sin él la intro quedaba 10 dB por debajo del hook).
  bass: { style: '808', glide: 0.3, octave: 2, hits: [0, 8], inIntro: true },
  chords: { style: 'stabs', sevenths: 0.05, octave: 4, center: 60, openVoicing: true },
  melody: { style: 'riff', density: 4, octave: 5, range: [57, 79], tune: true },
  sounds: {
    drums: [{ kind: 'drums' }],
    bass: [
      { kind: 'sub808', params: { decay: 1.1, drive: 0.6, glide: 0.07, punch: 0.7, tone: 1400 }, volume: 0.59 },
      { kind: 'prisma', preset: 'bass/808-carbon', volume: 0.59 },
    ],
    chords: [
      // Los acordes quedaban enterrados (-25 LUFS en solitario): +5 dB.
      { kind: 'prisma', preset: 'pads/pad-vapor', volume: 0.9 },
      { kind: 'nova', preset: 'keys/ep-oscuro', volume: 0.9 },
      { kind: 'sampler', instrument: 'instrumentos/pad-calido', params: { gain: 1.8 }, volume: 0.8 },
    ],
    melody: [
      { kind: 'sampler', instrument: 'instrumentos/lead-cuadrada', params: { gain: 1.8 }, volume: 0.8 },
      { kind: 'prisma', preset: 'arps/arp-sombrio', volume: 0.78 },
      { kind: 'nova', preset: 'keys/ep-oscuro', volume: 0.5 },
    ],
    fx: [{ kind: 'sampler', volume: 0.45 }],
  },
  kit: { kit: 2, tone: 0.4, decay: 0.8, punch: 0.75 },
  // El dembow tiene que cortar: la caja estaba 12 dB por debajo del bombo.
  drumMix: { kick: 0.76, snare: 1.45, hats: 0.78, perc: 0.6 },
  fx: {
    bass: [{ kind: 'distortion', params: { drive: 0.2, tone: 3000, output: 0.9 } }],
    melody: [
      // Oscuro pero no apagado: con techo en 5 kHz el beat entero quedaba 7 dB por debajo de tus beats en agudos.
      { kind: 'eq', params: { hpFreq: 180, midGain: -3, midFreq: 4800, midQ: 1.5, lpFreq: 9500 } },
      { kind: 'reverb', params: { size: 0.6, damp: 0.75, width: 1, predelay: 0.03 } },
    ],
    // Paso alto doble (24 dB/oct): con uno solo seguía habiendo 90 Hz en los acordes.
    chords: [
      { kind: 'eq', params: { hpFreq: 250, midGain: -2, midFreq: 400, midQ: 1, lpFreq: 9000 } },
      { kind: 'eq', params: { hpFreq: 250 } },
    ],
    // La caja rota sube en presencia: es la que corta en un dembow despojado.
    snare: [{ kind: 'eq', params: { hpFreq: 180, midGain: 5, midFreq: 3000, midQ: 0.8 } }, ...AIR_CAP(13000)],
    hats: AIR_CAP(12000),
  },
  master: [MONO_LOW, LIMITER_TP(0)],
  shapes: [3, 4],
};


export const GENRE_PRESETS: Record<ComposerGenre, GenrePreset> = {
  // Las reglas de los cuatro géneros urbanos salen de la investigación de
  // producción (NI, MusicRadar, Attack, Output, Linn, Wayne Marshall…): la caja
  // y el tempo son restricciones duras; la variedad vive en los hats en trap y
  // en la caja en reggaetón; el glide del 808 es firma del trap y va al cerrar
  // la frase. Los timbres son instrumentos grabados de la librería de fábrica
  // y kits propios de cada género, elegidos midiendo su espectro.
  trap: {
    id: 'trap',
    name: 'Trap',
    variantName: 'Melódico',
    description: 'Half-time a 142: caja sola en el 3, hats con redobles, 808 afinado que desliza al cerrar la frase, piano y cuerdas oscuras.',
    bpm: { min: 130, max: 160, default: 142 },
    swing: 0,
    scales: [
      { name: 'Menor natural', weight: 5 },
      { name: 'Menor armónica', weight: 3 },
      { name: 'Frigio', weight: 2 },
    ],
    // Bucles de 2-4 acordes menores: i-VI, i-iv, i-v, i-VI-v-i.
    progressions: [
      [0, 0, 5, 5],
      [0, 3, 0, 3],
      [0, 5, 4, 0],
      [0, 0, 4, 3],
      [0, 5, 0, 6],
    ],
    drums: {
      // Bombo: 1 + 1-3 síncopas, nunca en el 9 (el 3 es de la caja), anacrusa en 15-16.
      kick: ['X.....x...x.....', 'X......x..x...o.', 'X..x......x..?..', 'X.....x....x..o.'],
      snare: ['........X.......', '........X.....g.', '........X......g'],
      hats: ['x.x.x.x.x.x.x.x.', 'xoxoxoxoxoxoxoxo', 'x.xox.x.x.xox.x.'],
      perc: [],
      keys: { kick: KICK, snare: SNARE, hats: HAT, perc: RIM, openhat: OPENHAT },
      hatRolls: 0.55,
      openHats: 0.08,
      clapLayer: CLAP,
      tuneKick: true,
      kickLayer: 'drums/trap/kick-click-01',
      snareFills: true,
    },
    drumKit: {
      [KICK]: ['drums/trap/kick-01', 'drums/trap/kick-03'],
      [SNARE]: ['drums/trap/snare-01'],
      [CLAP]: ['drums/trap/clap-01'],
      [HAT]: ['drums/trap/hat-01', 'drums/trap/hat-03'],
      [OPENHAT]: ['drums/trap/openhat-01'],
    },
    fxKit: { riser: 'fx/sweep-up-01', impact: 'fx/impact-01' },
    bass: { style: '808', glide: 0.5, octave: 2 },
    chords: { style: 'pad', sevenths: 0.1, octave: 4, center: 58, openVoicing: true },
    melody: { style: 'motif', density: 4, octave: 5, range: [60, 81], tune: true },
    sounds: {
      drums: [{ kind: 'drums' }],
      // El 808 lleva más saturación (armónicos que se oyen en un móvil) y va
      // 2 dB por debajo: tapaba al bombo +6,8 dB en 30-160 Hz.
      bass: [
        { kind: 'sub808', params: { decay: 1.6, drive: 0.62, glide: 0.08, punch: 0.6, tone: 1300 }, volume: 0.56 },
        { kind: 'prisma', preset: 'bass/808-carbon', volume: 0.56 },
      ],
      chords: [
        { kind: 'prisma', preset: 'pads/pad-cine-oscuro', volume: 0.4 },
        { kind: 'sampler', instrument: 'instrumentos/strings-ensemble', volume: 0.33 },
        { kind: 'nova', preset: 'pads/pad-oscuro', volume: 0.36 },
      ],
      melody: [
        { kind: 'sampler', instrument: 'instrumentos/piano-suave', volume: 0.6 },
        { kind: 'prisma', preset: 'keys/piano-drill', volume: 0.55 },
        { kind: 'sampler', instrument: 'instrumentos/ep-sucio', volume: 0.6 },
      ],
      fx: [{ kind: 'sampler', volume: 0.45 }],
    },
    kit: { kit: 0, tone: 0.55, decay: 1, punch: 0.65 },
    drumMix: { kick: 1.2, snare: 0.9, hats: 0.7, perc: 0.6 },
    fx: {
      melody: [
        // Un valle ancho en 2,6-2,8 kHz: ahí se apilaba un armónico del piano (+14 dB medido).
        { kind: 'eq', params: { hpFreq: 200, midGain: -4, midFreq: 2700, midQ: 0.9, highGain: -3, highFreq: 5000, lpFreq: 7000 } },
        // Reverb a media anchura: a todo lo ancho la melodía quedaba en 0,30 de correlación.
        { kind: 'reverb', params: { size: 0.6, damp: 0.65, width: 0.5, predelay: 0.02 } },
      ],
      chords: [{ kind: 'eq', params: { hpFreq: 220, midGain: -2, midFreq: 400, midQ: 1, lpFreq: 6500 } }],
      // El click del bombo (+5 dB en 3 kHz): sin él, el 808 se lo comía.
      // Los hats filtrados dejaban el trap apagado (-6 dB en 2-16 kHz frente a tus
      // beats): brillo en 7 kHz y el techo más arriba, sin volver al pico de 21,7 kHz.
      // A 15 kHz el true peak volvía a subir 1 dB: 13,5 con el brillo en 7 kHz.
      hats: [
        { kind: 'eq', params: { highGain: 3, highFreq: 7000, lpFreq: 13500 } },
        { kind: 'eq', params: { lpFreq: 13500 } },
      ],
      // Ducking suave: con el del reggaetón el 808 caía -15 dB a los 60 ms y perdía cuerpo.
      bass: [DUCK_SOFT],
      // +2 dB en 3 kHz: el trap quedaba 3,7 dB por debajo de tus beats en 2-4 kHz.
      snare: [{ kind: 'eq', params: { midGain: 2, midFreq: 3000, midQ: 1, highGain: 2, highFreq: 6000, lpFreq: 14000 } }, { kind: 'eq', params: { lpFreq: 14000 } }],
    },
    master: [MONO_LOW, LIMITER_TP(3.4)],
    // Forma de canción de rap (intro, hooks de 8, versos de 16): no de club.
    shapes: [3, 4],
  },

  // Reggaetón de los 2000 (Luny Tunes, DJ Nelson, Noriega; y el underground
  // que hoy lo revive, como La Obsesión Factory en México): dembow seco y
  // rápido, caja que restalla, timbales en cada cierre de frase, platillo al
  // entrar el coro, cuerdas en staccato y piano o sinte de preset de los
  // 2000. Menor armónica para el V mayor que tensa la vuelta (i-VI-iv-V).
  reggaeton: {
    id: 'reggaeton',
    name: 'Reggaetón',
    variantName: '2000',
    description:
      'Reggaetón de los 2000 a 96: dembow seco, caja que restalla, redobles de timbal, platillo al entrar el coro, cuerdas en staccato y piano o sinte de la época.',
    bpm: { min: 90, max: 102, default: 96 },
    swing: 0,
    scales: [
      { name: 'Menor armónica', weight: 5 },
      { name: 'Menor natural', weight: 4 },
      { name: 'Frigio', weight: 1 },
    ],
    // Solo grados i, iv, V y VI: en menor armónica el III sale aumentado y el VII disminuido.
    progressions: [
      [0, 5, 3, 4],
      [0, 3, 4, 0],
      [0, 0, 5, 4],
      [0, 5, 0, 4],
      [3, 4, 0, 0],
    ],
    drums: {
      kick: ['X...x...X...x...', 'X...x...X...x...', 'X...x...X...x..?'],
      // El dembow de siempre; la variación la ponen los timbales, no la caja.
      snare: ['...x..x....x..x.', '...x..x....x..x.', '...x..x..g.x..x.'],
      // Hat cerrado en corcheas (lo de los 2000), no shaker en semicorcheas.
      hats: ['x.x.x.x.x.x.x.x.', 'x.x.x.x.x.x.x.xo', 'x.xox.x.x.x.x.x.'],
      // La percusión es de timbales: casi solo los redobles (ver `timbales`).
      perc: ['................', '..............?.'],
      keys: { kick: KICK, snare: SNARE, hats: HAT, perc: TIMBAL_HI },
      hatRolls: 0,
      openHats: 0,
      tuneKick: true,
      clapLayer: CLAP,
      timbales: { hi: TIMBAL_HI, lo: TIMBAL_LO },
    },
    drumKit: {
      [KICK]: ['drums/reggaeton/kick-2000'],
      [SNARE]: ['drums/reggaeton/snare-2000'],
      [CLAP]: ['drums/reggaeton/clap-01'],
      [HAT]: ['drums/trap/hat-01', 'drums/boombap/hat-02'],
      [TIMBAL_HI]: ['percusion-latina/timbal-alto-01'],
      [TIMBAL_LO]: ['percusion-latina/timbal-bajo-01'],
    },
    // Platillo con cola al entrar cada coro: la marca de la época.
    fxKit: { riser: 'fx/sweep-up-01', impact: 'fx/crash-reverb-01', hookImpact: true },
    bass: { style: 'sub', glide: 0, octave: 2, maxLen: 0.7 },
    chords: { style: 'perreo', sevenths: 0, octave: 4, center: 64, openVoicing: true, sparseVerse: true },
    melody: { style: 'hook', density: 4, octave: 5, range: [62, 84], tune: true },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        // A 0,62 el sub quedaba en -27 LUFS solo, 19 dB bajo el bombo: no se oía.
        { kind: 'sub808', params: { decay: 0.6, drive: 0.3, glide: 0.02, punch: 0.7, tone: 900 }, volume: 1.5 },
        { kind: 'prisma', preset: 'bass/sub-lienzo', volume: 0.22 },
      ],
      chords: [
        { kind: 'prisma', preset: 'strings/cuerdas-staccato', volume: 0.42 },
        { kind: 'prisma', preset: 'plucks/pizzicato-cuerdas', volume: 0.45 },
        // Sin los metales: tenían formantes fijos en 3.079 y 6.568 Hz (+14 dB en el beat).
        { kind: 'prisma', preset: 'strings/cuerdas-cine', volume: 0.65 },
      ],
      melody: [
        // El piano suave grabado: el brillante tenía parciales fijos en 2.649 y 5.243 Hz (+17 dB).
        // Con ganancia 2 iba a -7 LUFS, casi el nivel del beat entero: -8 dB.
        { kind: 'sampler', instrument: 'instrumentos/piano-suave', params: { gain: 1 }, volume: 0.6 },
        // Sin el supersaw: su centroide en 4 kHz era justo el agudo raro que ya vetaste.
        { kind: 'prisma', preset: 'strings/violin-solo', volume: 0.45 },
        { kind: 'prisma', preset: 'leads/flauta-humo', volume: 0.45 },
      ],
      fx: [{ kind: 'sampler', volume: 0.3 }],
    },
    kit: { kit: 2, tone: 0.6, decay: 0.9, punch: 0.7 },
    // El bombo de los 2000 pega mucho (a 1 iba a -8 LUFS solo, por encima de todo el beat).
    // Los timbales a 0,85 iban a -8 LUFS solos (en los redobles): eran lo más fuerte del beat.
    drumMix: { kick: 0.5, snare: 1.3, hats: 1.1, perc: 0.17 },
    fx: {
      bass: [DUCK_FROM_KICK],
      // Las cuerdas en staccato llevan el ritmo: medios presentes, sin barro ni chillido.
      // Los parciales del pluck de acordes (+34-37 dB en 2.210, 3.079 y 3.941 Hz)
      // eran el 58 % de la resonancia de 3,9 kHz del beat (lo midió el crítico por stems).
      chords: [
        // Las cuerdas de cine abultaban 500 Hz-1 kHz (+10,7 dB sobre las referencias): valle en 700.
        { kind: 'eq', params: { hpFreq: 220, lowGain: -2, lowFreq: 320, midGain: -4, midFreq: 700, midQ: 1, highGain: -3, highFreq: 6000, lpFreq: 9000 } },
        // Más estrecho: en el render 3 la correlación en medios bajaba a 0,22 (-3 dB en mono).
        { kind: 'stereo', params: { width: 0.5, gain: 1, monoBelow: 0 } },
        { kind: 'reverb', params: { size: 0.4, damp: 0.6, width: 0.5, predelay: 0.01 } },
        // La muesca, DESPUÉS de la reverb: la del motor tiene modos propios en ~3,9 kHz y
        // volvía a meter la resonancia que se quitaba antes de ella.
        REVERB_NOTCH,
      ],
      melody: [
        { kind: 'eq', params: { hpFreq: 220, lowGain: -2, lowFreq: 350, midGain: -3, midFreq: 2800, midQ: 1, highGain: -2, highFreq: 6000, lpFreq: 9500 } },
        { kind: 'stereo', params: { width: 0.35, gain: 1, monoBelow: 0 } },
        { kind: 'reverb', params: { size: 0.5, damp: 0.55, width: 0.5, predelay: 0.02 } },
        REVERB_NOTCH,
      ],
      // La caja de los 2000 llevaba su placa (~0,8 s).
      // La caja tiene parciales fijos en 13.364 Hz (+27 dB) y 15.429 Hz (+28): el 80 %
      // de la resonancia de 13,4 kHz del beat. Y su anillo de 3.844 Hz, el 31 % de la de 3,9.
      snare: [
        // Techo a 12 kHz, 24 dB/oct (dos pasos bajos): el clap brillaba en 14,8-15,4 kHz
        // (+10-11 dB) y la caja tenía parciales en 13.364 y 15.429 Hz.
        { kind: 'eq', params: { midGain: -6, midFreq: 3844, midQ: 6, highGain: 2, highFreq: 6000, lpFreq: 12000 } },
        // El crack de la caja: presencia en 2,4 kHz (el beat iba 5 dB bajo el moderno en 2-6 kHz).
        { kind: 'eq', params: { midGain: 4, midFreq: 2400, midQ: 0.8, lpFreq: 12000 } },
        // El clap resuena en 4.735 Hz (+10-11 dB). Esta muesca era la QUINTA EQ de la caja y no
        // sonaba: un canal tiene 4 insertos. Por eso «volvía» el pico.
        { kind: 'eq', params: { midGain: -10, midFreq: 4735, midQ: 5 } },
        // Brillo metálico de la caja en 13,6 kHz (+10-11 dB).
        { kind: 'eq', params: { midGain: -6, midFreq: 13601, midQ: 8 } },
        // Sin reverb (la del motor pitaba en 8,1 kHz, como en el boom bap) y sin delay: el
        // ping-pong de 1/16 retrasaba el canal derecho una semicorchea y cada golpe del dembow sonaba dos veces.
      ],
      // El platillo y el barrido llevaban el 74 % de la resonancia de 13,4 kHz.
      fx: [{ kind: 'eq', params: { midGain: -10, midFreq: 13367, midQ: 8, lpFreq: 12000 } }],
      // Brillo de vuelta: sin los metales ni el piano brillante el beat quedaba 6 dB apagado en 2-6 kHz.
      // Muescas en la huella metálica del hat de fábrica (9,7 / 13,6 / 14,15 kHz: el 100 % de esos picos).
      hats: [
        { kind: 'eq', params: { highGain: 3, highFreq: 7000, midGain: -8, midFreq: 9700, midQ: 8, lpFreq: 13000 } },
        { kind: 'eq', params: { midGain: -8, midFreq: 13600, midQ: 8, lpFreq: 13000 } },
        { kind: 'eq', params: { midGain: -8, midFreq: 14150, midQ: 8, lpFreq: 11000 } },
        // Quedaban picos en 11,96 y 15,85 kHz: techo a 11 kHz, 24 dB/oct.
        { kind: 'eq', params: { lpFreq: 11000 } },
      ],
      // El bombo daba el 53 % de 250 Hz-1 kHz.
      kick: [{ kind: 'eq', params: { midGain: -4, midFreq: 350, midQ: 1 } }],
      perc: AIR_CAP(12000),
    },
    master: [MONO_LOW, LIMITER_TP(8)],
    shapes: [3, 4],
  },

  // Neo perreo (Tomasa del Real, Ms Nina, Chico Sonido, Deltatron): el
  // reggaetón desarmado y pasado por el club. El dembow sigue mandando —es
  // perreo—, pero vestido de rave y de internet de los 2000: bombo
  // saturado, palmas, stabs de supersaw, arpegio de trance o lead de
  // ringtone, láser al entrar el coro y un sub que rebota con el bombo.
  neoperreo: {
    id: 'neoperreo',
    name: 'Neo perreo',
    variantName: 'Club',
    description:
      'Neo perreo de club a 98: dembow con bombo saturado y palmas, sub que rebota, stabs de supersaw, arpegio de trance o lead de ringtone y láser al entrar el coro.',
    bpm: { min: 92, max: 106, default: 98 },
    swing: 0,
    scales: [
      { name: 'Menor natural', weight: 5 },
      { name: 'Frigio', weight: 2 },
      { name: 'Dórico', weight: 2 },
    ],
    // Bucles de dos a cuatro acordes: i-VI, i-VII-VI-VII, i-iv, i-VI-III-VII.
    progressions: [
      [0, 0, 5, 5],
      [0, 6, 5, 6],
      [0, 0, 3, 3],
      [0, 5, 2, 6],
    ],
    drums: {
      kick: ['X...x...X...x...', 'X...x...X...x...', 'X...x...X...x.x.'],
      snare: ['...x..x....x..x.', '...x..x....x..x.', '...x..x....x.xx.'],
      hats: ['x.x.x.x.x.x.x.x.', 'x.xox.x.x.xox.x.', 'xoxoxoxoxoxoxoxo'],
      perc: ['..x.......x..x..', '..x.......x..x.o'],
      keys: { kick: KICK, snare: SNARE, hats: HAT, perc: RIM, openhat: OPENHAT },
      hatRolls: 0.25,
      openHats: 0.3,
      clapLayer: CLAP,
      tuneKick: true,
      snareFills: true,
    },
    drumKit: {
      [KICK]: ['drums/neoperreo/kick-01', 'drums/reggaeton/kick-2000'],
      [SNARE]: ['drums/reggaeton/snare-02', 'drums/reggaeton/snare-2000'],
      [CLAP]: ['drums/trap/clap-01', 'drums/reggaeton/clap-01'],
      [HAT]: ['drums/trap/hat-01'],
      [OPENHAT]: ['drums/trap/openhat-01'],
      [RIM]: ['drums/neoperreo/rim-01'],
    },
    fxKit: { riser: 'fx/sweep-up-01', impact: 'fx/zap-01', hookImpact: true },
    // Sin bajo en la intro: con él la intro era lo más fuerte del beat (-7,5 a -9 LUFS frente a -10).
    bass: { style: 'sub', glide: 0.05, octave: 2, maxLen: 0.5 },
    chords: { style: 'stabs', sevenths: 0, octave: 4, center: 62, openVoicing: true },
    melody: { style: 'arp', density: 4, octave: 5, range: [60, 84], tune: true },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        // A 0,6 el sub iba a -29 LUFS solo: 20 dB bajo el bombo.
        { kind: 'sub808', params: { decay: 0.55, drive: 0.7, glide: 0.04, punch: 0.75, tone: 1600 }, volume: 1.4 },
        { kind: 'prisma', preset: 'bass/dembow-goma', volume: 0.9 },
      ],
      // La capa rave / Y2K: supersaw ancho siempre (10-16 kHz iba 3-5 dB bajo las
      // referencias); el pluck de house no es del género.
      chords: [
        // +5 dB: el supersaw quedaba enterrado (stem de acordes 13 dB bajo la suma).
        { kind: 'prisma', preset: 'leads/saw-ancho', volume: 0.6 },
        { kind: 'prisma', preset: 'pads/pad-neon-house', volume: 2 },
      ],
      melody: [
        { kind: 'prisma', preset: 'arps/arp-trance', volume: 0.85 },
        { kind: 'prisma', preset: 'leads/chicle-neon', volume: 0.4 },
        // El lead de ringtone, el grabado (el que ya pasó el crítico), no el 8 bits.
        { kind: 'sampler', instrument: 'instrumentos/lead-cuadrada', params: { gain: 1 }, volume: 0.42 },
      ],
      fx: [{ kind: 'sampler', volume: 0.4 }],
    },
    kit: { kit: 0, tone: 0.5, decay: 0.8, punch: 0.8 },
    drumMix: { kick: 0.6, snare: 1.2, hats: 0.8, perc: 0.7 },
    fx: {
      bass: [{ kind: 'distortion', params: { drive: 0.25, tone: 3200, output: 0.9 } }, DUCK_FROM_KICK],
      chords: [
        // El supersaw sumaba medios (+6 dB en 500 Hz-1 kHz) y no brillo: valle en 500, aire en 9 kHz.
        { kind: 'eq', params: { hpFreq: 250, lowGain: -2, lowFreq: 350, midGain: -3, midFreq: 500, midQ: 1, highGain: 3, highFreq: 9000, lpFreq: 13000 } },
        { kind: 'reverb', params: { size: 0.55, damp: 0.6, width: 0.8, predelay: 0.02 } },
        // Los +5 dB de verdad: el volumen de un instrumento tiene tope 1,2 en el compositor y no
        // llegaba. La ganancia va por el inserto estéreo (x1,8).
        { kind: 'stereo', params: { width: 1, gain: 1.8, monoBelow: 0 } },
        // El aire en 9 kHz levantaba un pico propio del supersaw en 4.549 Hz (+11,5 dB).
        { kind: 'eq', params: { midGain: -5, midFreq: 4549, midQ: 6 } },
      ],
      melody: [
        { kind: 'eq', params: { hpFreq: 300, midGain: -3, midFreq: 3200, midQ: 1, highGain: -3, highFreq: 7000, lpFreq: 11000 } },
        { kind: 'delay', params: { time: 4, feedback: 0.3, pingpong: 1, filter: 3500 } },
        { kind: 'reverb', params: { size: 0.6, damp: 0.6, width: 0.9, predelay: 0.02 } },
      ],
      // El clap resuena en 4.735 Hz (era él, no el rim).
      snare: [
        { kind: 'eq', params: { hpFreq: 160, midGain: 2, midFreq: 2500, midQ: 1, lpFreq: 13000 } },
        { kind: 'eq', params: { midGain: -6, midFreq: 4735, midQ: 6, lpFreq: 13000 } },
        { kind: 'eq', params: { midGain: -6, midFreq: 3844, midQ: 6 } },
      ],
      hats: AIR_CAP(12000),
      // El rim resonaba en 4.735 y 6.853 Hz.
      perc: [{ kind: 'eq', params: { midGain: -6, midFreq: 4735, midQ: 6, lpFreq: 12000 } }, { kind: 'eq', params: { midGain: -6, midFreq: 6853, midQ: 6, lpFreq: 12000 } }],
      // El silbido de 14,5 kHz era de los FX (el 97 % del pico).
      fx: [{ kind: 'eq', params: { midGain: -12, midFreq: 14500, midQ: 8, lpFreq: 15000 } }],
    },
    master: [MONO_LOW, LIMITER_TP(2.5)],
    shapes: [3, 4],
  },

  boombap: {
    id: 'boombap',
    name: 'Boom bap',
    description: 'A 90 con swing MPC (~59 %): kit polvoriento de 12 bits, caja en 2 y 4 adelantada, hats tarde, bajo grave y Rhodes, piano o vibráfono de séptimas.',
    bpm: { min: 84, max: 96, default: 90 },
    // 0.36 en la escala del motor = ~59 % de Linn: suelto sin ser tresillo (54-62 %).
    swing: 0.36,
    scales: [
      { name: 'Menor natural', weight: 4 },
      { name: 'Dórico', weight: 4 },
      { name: 'Blues', weight: 1 },
    ],
    // Uno o dos acordes por loop casi siempre: i7-iv7, i9-bVImaj7, ii7-V7-i.
    progressions: [
      [0, 0, 3, 3],
      [0, 3, 0, 3],
      [0, 0, 5, 5],
      [1, 4, 0, 0],
    ],
    drums: {
      // Bombo: 1 + 11 (casi siempre), 7-8 (a menudo), 3 (a veces, suave).
      kick: ['X......x..x.....', 'X.?....x..x.....', 'X......x..x...?.', 'X.g.......x..o..'],
      snare: ['....X.......X...', '....X......gX...', '....X..g....X..g'],
      // Semicorcheas con la par suave: el swing del motor solo mueve las
      // semicorcheas pares, y en corcheas rectas no había swing que oír.
      hats: ['xvxvxvxvxvxvxvxv', 'xvxvxvxvxvxvxvxg', 'xvxvxvxgxvxvxvxv'],
      perc: [],
      keys: { kick: KICK, snare: SNARE, hats: HAT, perc: RIM, openhat: OPENHAT },
      hatRolls: 0,
      openHats: 0.15,
      // Todo tarde, la caja también: adelantada contra un bombo y unos hats que
      // arrastran sonaba apurada. Desfase fijo, igual en cada compás.
      feelMs: { kick: 8, snare: 6, hats: 10 },
      tuneKick: true,
      snareFills: true,
    },
    drumKit: {
      [KICK]: ['drums/boombap/kick-03', 'drums/boombap/kick-01'],
      [SNARE]: ['drums/boombap/snare-03'],
      [HAT]: ['drums/boombap/hat-03'],
      [OPENHAT]: ['drums/boombap/openhat-01'],
    },
    bass: { style: 'walk', glide: 0, octave: 2 },
    chords: { style: 'chops', sevenths: 0.9, octave: 4, center: 64, openVoicing: true },
    melody: { style: 'hook', density: 3, octave: 5, range: [55, 77], tune: true },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'sampler', instrument: 'instrumentos/bajo-fingered', volume: 0.85 },
        { kind: 'prisma', preset: 'bass/upright-humo' },
        { kind: 'sampler', instrument: 'instrumentos/bajo-redondo', volume: 0.85 },
      ],
      chords: [
        { kind: 'sampler', instrument: 'instrumentos/ep-rhodes', volume: 0.5 },
        { kind: 'sampler', instrument: 'instrumentos/piano-suave', volume: 0.5 },
        { kind: 'prisma', preset: 'keys/piano-cinta', volume: 0.45 },
      ],
      melody: [
        { kind: 'sampler', instrument: 'instrumentos/vibrafono', volume: 0.5 },
        { kind: 'sampler', instrument: 'instrumentos/piano-suave', volume: 0.6 },
        // Las cuerdas eran lo más fuerte de la mezcla (medios +6-10 dB sobre la referencia).
        { kind: 'prisma', preset: 'strings/cuerdas-cinta', volume: 0.3 },
      ],
      fx: [],
    },
    kit: { kit: 1, tone: 0.45, decay: 1, punch: 0.55 },
    drumMix: { kick: 1.2, snare: 1.5, hats: 0.5, perc: 0.6 },
    fx: {
      // El contrabajo era lo que llenaba 1-2 kHz (más que el piano): techo a 900 Hz.
      bass: [{ kind: 'eq', params: { hpFreq: 30, lowGain: 6, lowFreq: 60, lpFreq: 900 } }],
      // El bombo polvoriento de 12 bits pierde sub; se le devuelve en 55 Hz (Attack: +60 / -150).
      kick: [{ kind: 'eq', params: { hpFreq: 32, lowGain: 6, lowFreq: 55, midGain: -3, midFreq: 160, midQ: 1.2 } }],
      hats: AIR_CAP(11000),
      // Los Rhodes de séptimas apilaban 200-400 Hz (barro de -1 dB medido en solitario).
      // Medios +4 dB en 250-500 y +7,6 en 1-2 kHz frente a tu boom bap: valle en 1,5 kHz.
      chords: [
        { kind: 'eq', params: { hpFreq: 280, midGain: -5, midFreq: 330, midQ: 0.9, highGain: -3, lpFreq: 8000 } },
        { kind: 'eq', params: { lowGain: -2, lowFreq: 400, midGain: -5, midFreq: 1500, midQ: 0.8 } },
        { kind: 'vinyl', params: {} },
      ],
      melody: [{ kind: 'eq', params: { hpFreq: 250, lowGain: -2, lowFreq: 400, midGain: -3, midFreq: 1500, midQ: 0.8, highGain: -2, lpFreq: 7000 } }],
      // Sin reverb en la caja: la del motor sonaba a pitido en 4,6 y 13,4 kHz sobre una caja seca limpia.
      // Y fuera la caja de cartón (300 Hz): el crack va arriba, en 1,8 kHz.
      snare: [{ kind: 'eq', params: { hpFreq: 160, lowGain: -4, lowFreq: 320, midGain: -2, midFreq: 1200, midQ: 0.9 } }, ...AIR_CAP(12000)],
    },
    master: [MONO_LOW, LIMITER_TP(6)],
    shapes: [3, 4],
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
    chords: { style: 'stabs', sevenths: 0.3, octave: 5 },
    melody: { style: 'riff', density: 6, octave: 6 },
    sounds: {
      drums: [{ kind: 'drums' }],
      bass: [
        { kind: 'prisma', preset: 'bass/acido-303' },
        { kind: 'prisma', preset: 'bass/house-redondo' },
      ],
      chords: [
        { kind: 'prisma', preset: 'plucks/pluck-house', volume: 1.3 },
        { kind: 'prisma', preset: 'pads/pad-analogico', volume: 0.8 },
      ],
      melody: [
        { kind: 'prisma', preset: 'arps/arp-sombrio', volume: 0.45 },
        { kind: 'prisma', preset: 'leads/sync-neon', volume: 0.45 },
        { kind: 'prisma', preset: 'arps/arp-trance', volume: 0.45 },
      ],
      fx: [{ kind: 'prisma', preset: 'atmos/motor-lejano', volume: 0.35 }],
    },
    kit: { kit: 0, tone: 0.5, decay: 0.7, punch: 0.8 },
    drumMix: { kick: 1, snare: 0.9, hats: 0.8, perc: 0.9 },
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
    chords: { style: 'pad', sevenths: 0, octave: 5 },
    melody: { style: 'riff', density: 8, octave: 6 },
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
    drumMix: { kick: 1, snare: 0.9, hats: 0.8, perc: 0.75 },
    fx: {
      kick: [{ kind: 'distortion', params: { drive: 0.4, tone: 6000, output: 0.8 } }],
      melody: [{ kind: 'reverb', params: { size: 0.75, damp: 0.4, width: 1, predelay: 0.02 } }],
      chords: [{ kind: 'eq', params: { hpFreq: 250 } }],
    },
    master: [MONO_LOW, LIMITER(1.6)],
    shapes: [0, 1],
  },
};

// ── Variantes ─────────────────────────────────────────────────────────────────

/**
 * Una variante es otro ADN dentro del mismo género: el trap duro sin melodía,
 * el reggaetón moderno al lado del de los 2000. Se elige con `variant` al
 * componer; sin ella, el preset de siempre (que no cambia de sonido).
 */
export interface GenreVariant {
  id: string;
  name: string;
  description: string;
  preset: GenrePreset;
}

/**
 * Trap duro (lo agresivo de Esbabyface y del trap de calle): más rápido,
 * bombo saturado y sincopado, hats en semicorcheas que redoblan casi cada
 * compás, 808 sucio que desliza sin parar y, en vez de melodía cantable, un
 * riff de una o dos notas y un colchón de tensión.
 */
const TRAP_DURO: GenrePreset = {
  ...GENRE_PRESETS.trap,
  description:
    'Trap duro a 150: bombo saturado y sincopado, hats en semicorcheas con redobles, 808 sucio que desliza sin parar, riff de una o dos notas y un colchón de tensión.',
  bpm: { min: 140, max: 162, default: 150 },
  scales: [
    { name: 'Frigio', weight: 4 },
    { name: 'Menor natural', weight: 3 },
    { name: 'Menor armónica', weight: 2 },
  ],
  // El 808 en Re1-Fa1 (37-44 Hz), como el type beat de Esbabyface de las
  // referencias: iba una cuarta o una quinta alto y faltaban 6-10 dB en 20-40 Hz.
  roots: [
    { root: 2, weight: 3 },
    { root: 3, weight: 2 },
    { root: 4, weight: 2 },
    { root: 5, weight: 3 },
  ],
  // Casi estático: la tensión la da el bII frigio, no la progresión.
  progressions: [
    [0, 0, 0, 0],
    [0, 0, 1, 1],
    [0, 1, 0, 1],
    [0, 0, 5, 5],
  ],
  drums: {
    ...GENRE_PRESETS.trap.drums,
    kick: ['X.....x...x..x..', 'X..x..x...x.....', 'X.....xx..x...o.', 'X......x.x....x.'],
    snare: ['........X.......', '........X.....x.', '........X......o'],
    hats: ['xvxvxvxvxvxvxvxv', 'xvxxxvxvxvxxxvxv', 'xxvxxvxxxvxxvxxv'],
    // Sin percusión suelta (como el trap de siempre: dos golpes sueltos sonaban a error).
    hatRolls: 0.9,
    openHats: 0.12,
  },
  // Golpe al entrar cada hook: en la forma de rap no hay drop y el FX no sonaba nunca.
  fxKit: { riser: 'fx/sweep-up-01', impact: 'fx/impact-01', hookImpact: true },
  bass: { style: '808', glide: 0.85, octave: 2, lowKey: 26 },
  chords: { style: 'pad', sevenths: 0, octave: 4, center: 55, openVoicing: true },
  melody: { style: 'riff', density: 4, octave: 5, range: [55, 79], tune: true },
  sounds: {
    ...GENRE_PRESETS.trap.sounds,
    bass: [
      // El 808 manda (en el type beat de Esbabyface de tus referencias el sub va 9 dB sobre el resto).
      // -2 dB: el 808 quedaba por encima del bombo mientras golpea (+1,3 a +2,7 dB). La otra
      // mitad del problema era el sidechain perdido (quinto inserto del canal).
      { kind: 'sub808', params: { decay: 1.5, drive: 0.55, glide: 0.1, punch: 0.75, tone: 1200 }, volume: 0.68 },
      { kind: 'prisma', preset: 'bass/808-carbon', volume: 0.68 },
    ],
    chords: [
      // El colchón, por debajo de todo: a 0,3 era lo que embarraba los medios (-2,8 dB en 250-2k solo).
      { kind: 'prisma', preset: 'strings/tremolo-tension', volume: 0.12 },
      { kind: 'prisma', preset: 'atmos/drone-tension', volume: 0.1 },
    ],
    // Sin campanas ni plucks metálicos (el «agudo raro» que ya se vetó): riff grave y oscuro.
    melody: [
      { kind: 'prisma', preset: 'keys/piano-drill', volume: 0.65 },
      // El corno no: con notas de semicorchea su ataque lento lo dejaba en -34 LUFS (no se oía).
      { kind: 'prisma', preset: 'strings/cuerdas-staccato', volume: 0.8 },
      { kind: 'prisma', preset: 'leads/sierra-drill', volume: 0.45 },
    ],
  },
  drumMix: { kick: 1.05, snare: 1, hats: 0.65, perc: 0.55 },
  fx: {
    ...GENRE_PRESETS.trap.fx,
    // El bombo era el 60 % de 250 Hz-1 kHz (+9 dB de medios frente al type beat de Esbabyface).
    kick: [{ kind: 'distortion', params: { drive: 0.3, tone: 5000, output: 0.9 } }, { kind: 'eq', params: { midGain: -6, midFreq: 380, midQ: 0.9 } }, { kind: 'eq', params: { midGain: -2, midFreq: 700, midQ: 1 } }],
    // Caja y hats: 24 dB/oct a 12 kHz (silbidos metálicos de +9-12 dB en 13,6-15,3 kHz) y +2 dB en 8 kHz.
    // Muescas en los brillos metálicos de 13,6 y 14 kHz (+10-12 dB, caja y hats de fábrica).
    hats: [{ kind: 'eq', params: { highGain: 2, highFreq: 8000, midGain: -6, midFreq: 13600, midQ: 8, lpFreq: 12000 } }, { kind: 'eq', params: { midGain: -6, midFreq: 14040, midQ: 8, lpFreq: 12000 } }],
    snare: [
      { kind: 'eq', params: { midGain: 2, midFreq: 3000, midQ: 1, highGain: 2, highFreq: 5000, lpFreq: 12000 } },
      // La caja/clap de trap resuena en 3,8 y 4,57 kHz.
      { kind: 'eq', params: { midGain: -6, midFreq: 3820, midQ: 6, lpFreq: 12000 } },
      { kind: 'eq', params: { midGain: -6, midFreq: 4573, midQ: 6 } },
      { kind: 'eq', params: { midGain: -6, midFreq: 13600, midQ: 8 } },
    ],
    // La distorsión del 808 llenaba los medios (+10 dB en 250 Hz-1 kHz frente a la
    // referencia, siguiendo al grave con r = 0,97): paso bajo a 1,2 kHz y valle en 400.
    bass: [
      { kind: 'distortion', params: { drive: 0.3, tone: 3500, output: 0.9 } },
      // Con el bombo ya limpio, el 808 era el que llenaba 250 Hz-1 kHz (29-47 %): un valle
      // ancho de 400 a 550. Cuatro insertos como mucho: con cinco, el sidechain (el quinto)
      // no llegaba al canal, y por eso el 808 tapaba al bombo.
      { kind: 'eq', params: { midGain: -6, midFreq: 470, midQ: 0.6, lpFreq: 1200 } },
      { kind: 'eq', params: { lpFreq: 1200 } },
      DUCK_SOFT,
    ],
    // El colchón era casi todo picos tonales en 2-3,5 kHz (+12-13 dB): techo a 1,8 kHz.
    chords: [{ kind: 'eq', params: { hpFreq: 250, midGain: -3, midFreq: 400, midQ: 1, lpFreq: 1800 } }, { kind: 'eq', params: { lpFreq: 1800 } }],
    melody: [
      // El riff resonaba en 3,1-4,6 kHz (+12-14 dB, el 73 % del pico de 3.846 Hz): techo a 3 kHz, 24 dB/oct.
      { kind: 'eq', params: { hpFreq: 250, midGain: -4, midFreq: 700, midQ: 0.9, lpFreq: 3000 } },
      { kind: 'eq', params: { lpFreq: 3000 } },
      { kind: 'reverb', params: { size: 0.5, damp: 0.7, width: 0.5, predelay: 0.02 } },
    ],
  },
  // El hat-03 tenía picos metálicos fijos (+10 dB en 9,7, 10,7 y 13,6 kHz).
  drumKit: { ...GENRE_PRESETS.trap.drumKit, [HAT]: ['drums/trap/hat-01'] },
  master: [MONO_LOW, LIMITER_TP(1.5)],
  // La forma larga con breakdown (2:08 a 150).
  shapes: [5],
};

/** Trap sin melodía: el duro desnudo — batería, 808 y FX, para rapear encima sin nada que tape la voz. */
const TRAP_CRUDO: GenrePreset = {
  ...TRAP_DURO,
  description: 'Trap sin melodía a 150: solo batería dura, 808 sucio que desliza y FX. Nada que le pise la voz.',
  sounds: { ...TRAP_DURO.sounds, chords: [], melody: [] },
  // Sin melodía, la intro eran 8 compases a -30 LUFS (13 s casi en silencio); con el 808 entero
  // arrancaba al nivel del cuerpo y el primer hook no subía. Entra en su segunda mitad.
  bass: { ...TRAP_DURO.bass, inIntro: 0.5 },
  drumMix: { kick: 1.05, snare: 1.05, hats: 0.7, perc: 0.65 },
  master: [MONO_LOW, LIMITER_TP(1.5)],
};

export const GENRE_VARIANTS: Partial<Record<ComposerGenre, readonly GenreVariant[]>> = {
  trap: [
    { id: 'duro', name: 'Duro', description: TRAP_DURO.description, preset: TRAP_DURO },
    { id: 'crudo', name: 'Sin melodía', description: TRAP_CRUDO.description, preset: TRAP_CRUDO },
  ],
  reggaeton: [{ id: 'moderno', name: 'Moderno', description: REGGAETON_MODERNO.description, preset: REGGAETON_MODERNO }],
  neoperreo: [{ id: 'oscuro', name: 'Oscuro', description: NEOPERREO_OSCURO.description, preset: NEOPERREO_OSCURO }],
};

/** Las variantes de un género (vacío si no tiene). */
export function genreVariants(genre: ComposerGenre): readonly GenreVariant[] {
  return GENRE_VARIANTS[genre] ?? [];
}

/** El preset de un género y una variante; lanza con un motivo legible si la variante no existe. */
export function resolvePreset(genre: ComposerGenre, variant?: string | null): GenrePreset {
  const base = GENRE_PRESETS[genre];
  if (!base) throw new Error(`género desconocido "${String(genre)}"`);
  if (variant === undefined || variant === null || variant === '') return base;
  const v = genreVariants(genre).find((x) => x.id === variant);
  if (!v) {
    const ids = genreVariants(genre).map((x) => x.id);
    throw new Error(`variante "${variant}" desconocida para ${base.name} (${ids.length > 0 ? ids.join(', ') : 'no tiene variantes'})`);
  }
  return v.preset;
}

/** Nombre para mostrar: «Trap · Duro» o «Trap». */
export function presetLabel(genre: ComposerGenre, variant?: string | null): string {
  const base = GENRE_PRESETS[genre].name;
  const v = variant ? genreVariants(genre).find((x) => x.id === variant) : undefined;
  return v ? `${base} · ${v.name}` : base;
}

/** Carriles de batería de un género ya parseados (los usa el compositor y los tests). */
export function genreDrumLanes(
  genre: ComposerGenre,
): Record<'kick' | 'snare' | 'hats' | 'perc', { key: number; variants: StepProb[][] }> {
  return presetDrumLanes(GENRE_PRESETS[genre]);
}

/** Carriles de batería de un preset (el de un género o el de una variante). */
export function presetDrumLanes(
  preset: GenrePreset,
): Record<'kick' | 'snare' | 'hats' | 'perc', { key: number; variants: StepProb[][] }> {
  const d = preset.drums;
  return {
    kick: { key: d.keys.kick, variants: d.kick.map(parseSteps) },
    snare: { key: d.keys.snare, variants: d.snare.map(parseSteps) },
    hats: { key: d.keys.hats, variants: d.hats.map(parseSteps) },
    perc: { key: d.keys.perc, variants: d.perc.map(parseSteps) },
  };
}
