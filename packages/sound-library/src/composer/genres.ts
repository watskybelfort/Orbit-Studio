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
  };
  /** `hits`: pasos fijos del bajo (si no, sigue al bombo). */
  /** `hits`: pasos fijos del bajo (si no, sigue al bombo). `maxLen`: tope de duración de la nota del bajo `sub`, en tiempos. */
  /** `inIntro`: el bajo ya suena en la intro (por defecto la intro va sin bajo). */
  bass: { style: BassStyle; glide: number; octave: number; hits?: number[]; maxLen?: number; inIntro?: boolean };
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
  /** FX de la librería de fábrica: barrido en la subida e impacto al caer el drop. */
  fxKit?: { riser: string; impact: string };
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

const AIR_CAP = (hz: number): FxChoice[] => [
  { kind: 'eq', params: { lpFreq: hz } },
  { kind: 'eq', params: { lpFreq: hz } },
];

// ── Los géneros ───────────────────────────────────────────────────────────────

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

  reggaeton: {
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
  },

  neoperreo: {
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

export function genrePreset(genre: ComposerGenre): GenrePreset {
  return GENRE_PRESETS[genre];
}

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

export const GENRE_VARIANTS: Partial<Record<ComposerGenre, readonly GenreVariant[]>> = {};

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
  const d = GENRE_PRESETS[genre].drums;
  return {
    kick: { key: d.keys.kick, variants: d.kick.map(parseSteps) },
    snare: { key: d.keys.snare, variants: d.snare.map(parseSteps) },
    hats: { key: d.keys.hats, variants: d.hats.map(parseSteps) },
    perc: { key: d.keys.perc, variants: d.perc.map(parseSteps) },
  };
}
