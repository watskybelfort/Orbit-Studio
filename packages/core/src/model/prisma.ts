/**
 * Orbit Prisma — el instrumento grande de presets.
 *
 * Nova ya hacía la idea básica de FLEX (elegir un SONIDO en vez de montar un
 * sinte), pero se quedaba corto para trabajar de verdad: dos macros, cuatro
 * motores prestados de otros canales y seis perillas que solo escalaban lo que
 * dejara el preset. Prisma es el paso siguiente:
 *
 * - **Capas de verdad**: hasta cuatro, cada una con su motor, su afinación,
 *   su nivel/pan, su rango de teclas y sus propios retoques de envolvente y
 *   filtro. Un preset es una pila, no un sonido plano.
 * - **Motores propios** (ver `engine/dsp/prisma-voice.ts`): tabla de ondas con
 *   morph, pulso con PWM, ruido filtrado, FM con realimentación, cuerda
 *   pulsada, aditivo de órgano, parciales de campana, formantes y sub.
 * - **Perillas absolutas**: el preset CARGA sus valores en el canal y a partir
 *   de ahí mandas tú. Nada de multiplicadores misteriosos sobre un valor que
 *   no ves — cada perilla dice lo que vale, en Hz o en segundos.
 * - **Ocho macros** por preset, cada una capaz de mover varios destinos a la
 *   vez, en el canal o dentro de una capa concreta.
 *
 * Como Nova, vive en `core` porque lo necesitan los tres lados: el compilador
 * para mandar las capas al kernel, la UI para el browser de sonidos y el
 * modelo para saber qué toca el canal. Y como Nova, un preset **no pesa**: son
 * números, no samples, así que un proyecto guarda solo el id.
 */

import { PRISMA_MACROS, defaultInstrumentParams } from './params';

// ── Motores de capa ──────────────────────────────────────────────────────────

/**
 * Motor sobre el que se construye una capa. Cada uno responde a `wave` (0..1)
 * de una forma distinta, que es lo que hace que un mismo preset con la perilla
 * Wave movida siga sonando a él y no a otra cosa.
 */
export type PrismaEngine =
  /** Tabla de ondas: `wave` recorre seno → triángulo → sierra → cuadrada → dientes. */
  | 'wt'
  /** Pulso con ancho variable: `wave` es el duty (0.5 = cuadrada). */
  | 'pulse'
  /** Ruido pasado por un filtro que sigue a la tecla; `wave` abre el filtro. */
  | 'noise'
  /** Dos operadores con realimentación; `wave` es el índice de modulación. */
  | 'fm'
  /** Cuerda pulsada (Karplus–Strong); `wave` es el brillo de la púa. */
  | 'pluck'
  /** Aditivo tipo órgano por registros; `wave` mezcla los armónicos. */
  | 'organ'
  /** Parciales inarmónicos de campana/metal; `wave` estira la inarmonicidad. */
  | 'bell'
  /** Formantes vocales; `wave` recorre las vocales A→E→I→O→U. */
  | 'formant'
  /** Seno grave saturable con caída de tono; `wave` es la saturación. */
  | 'sub';

export const PRISMA_ENGINES: PrismaEngine[] = [
  'wt',
  'pulse',
  'noise',
  'fm',
  'pluck',
  'organ',
  'bell',
  'formant',
  'sub',
];

export const PRISMA_ENGINE_LABELS: Record<PrismaEngine, string> = {
  wt: 'Tabla',
  pulse: 'Pulso',
  noise: 'Ruido',
  fm: 'FM',
  pluck: 'Cuerda',
  organ: 'Órgano',
  bell: 'Campana',
  formant: 'Formantes',
  sub: 'Sub',
};

// ── Capa ─────────────────────────────────────────────────────────────────────

export interface PrismaLayer {
  engine: PrismaEngine;
  /** Carácter del motor 0..1 (la perilla Wave del canal lo desplaza). */
  wave: number;
  /** Nivel lineal de la capa dentro del preset, 0..1. */
  level: number;
  /** Pan de la capa -1..1 (la perilla Width lo escala). */
  pan: number;
  /** Transposición de la capa en semitonos. */
  semi: number;
  /** Desafinación fina de la capa en cents. */
  fine: number;
  /**
   * Retoques de la envolvente del canal, multiplicativos (1 = tal cual). Una
   * capa de ataque puede así ser corta mientras la de fondo respira.
   */
  attackMul: number;
  decayMul: number;
  releaseMul: number;
  /** Suma al sustain del canal, -1..1 (se recorta a 0..1). */
  sustainAdd: number;
  /** Desplazamiento del cutoff en OCTAVAS respecto al filtro del canal. */
  cutoffOct: number;
  /** Rango de teclas MIDI en el que suena la capa (fuera, calla). */
  keyLo: number;
  keyHi: number;
  /** Cuánto responde a la velocidad: 0 = plana, 1 = del todo. */
  velTrack: number;
  /** Fase inicial 0..1, o -1 para aleatoria por nota (ancho natural). */
  phase: number;
  /** Parámetros propios del motor (`ratio`/`feedback` de FM, etc.). */
  params: Record<string, number>;
}

/**
 * Destino de una macro.
 * - `layer === -1` → mueve un parámetro del CANAL (clave de INSTRUMENT_PARAMS.prisma).
 * - `layer >= 0` → mueve un campo de esa capa (`level`, `wave`, `fine`,
 *   `cutoffOct`, `semi`, `pan`, `attackMul`, `decayMul`, `releaseMul`) o una
 *   clave de su `params`.
 */
export interface PrismaMacroTarget {
  layer: number;
  param: string;
  min: number;
  max: number;
}

export interface PrismaMacro {
  label: string;
  /** Valor por defecto 0..1 que carga el preset. */
  value: number;
  targets: PrismaMacroTarget[];
}

// ── Categorías ───────────────────────────────────────────────────────────────

export const PRISMA_CATEGORIES = [
  'keys',
  'bass',
  'leads',
  'pads',
  'plucks',
  'bells',
  'organs',
  'strings',
  'brass',
  'guitars',
  'vocals',
  'arps',
  'atmos',
  'fx',
  'drums',
  'world',
] as const;

export type PrismaCategory = (typeof PRISMA_CATEGORIES)[number];

export const PRISMA_CATEGORY_LABELS: Record<PrismaCategory, string> = {
  keys: 'Teclas',
  bass: 'Bajos',
  leads: 'Leads',
  pads: 'Pads',
  plucks: 'Plucks',
  bells: 'Campanas',
  organs: 'Órganos',
  strings: 'Cuerdas',
  brass: 'Vientos',
  guitars: 'Guitarras',
  vocals: 'Voces',
  arps: 'Arpegios',
  atmos: 'Atmósferas',
  fx: 'Efectos',
  drums: 'Percusión',
  world: 'Del mundo',
};

// ── Preset ───────────────────────────────────────────────────────────────────

export interface PrismaPreset {
  /** Id estable, ej. "keys/rhodes-nocturno". */
  id: string;
  name: string;
  /** Pack al que pertenece (el de fábrica es "Prisma Core"). */
  pack: string;
  category: PrismaCategory;
  /** Tags libres para el buscador: género, carácter, instrumento real… */
  tags: string[];
  layers: PrismaLayer[];
  /**
   * Valores que el preset escribe en las perillas del canal al cargarse. Las
   * claves que no aparezcan se quedan en su default. Esto es lo que hace que
   * las perillas de Prisma sean ABSOLUTAS y muestren la verdad.
   */
  base: Record<string, number>;
  /** Hasta PRISMA_MACROS macros; las que falten salen vacías y sin efecto. */
  macros: PrismaMacro[];
}

// ── Helpers de autoría ───────────────────────────────────────────────────────
// Los presets se escriben a mano y son muchos: estos helpers existen para que
// una línea de preset quepa en una línea y se lea como una ficha.

/** Capa con todos los campos rellenos a partir de unos pocos. */
export function layer(
  engine: PrismaEngine,
  opts: Partial<Omit<PrismaLayer, 'engine'>> = {},
): PrismaLayer {
  return {
    engine,
    wave: opts.wave ?? 0.5,
    level: opts.level ?? 1,
    pan: opts.pan ?? 0,
    semi: opts.semi ?? 0,
    fine: opts.fine ?? 0,
    attackMul: opts.attackMul ?? 1,
    decayMul: opts.decayMul ?? 1,
    releaseMul: opts.releaseMul ?? 1,
    sustainAdd: opts.sustainAdd ?? 0,
    cutoffOct: opts.cutoffOct ?? 0,
    keyLo: opts.keyLo ?? 0,
    keyHi: opts.keyHi ?? 127,
    velTrack: opts.velTrack ?? 1,
    phase: opts.phase ?? 0,
    params: opts.params ?? {},
  };
}

export function macro(
  label: string,
  value: number,
  targets: PrismaMacroTarget[],
): PrismaMacro {
  return { label, value, targets };
}

/** Destino de macro sobre una perilla del CANAL. */
export function chan(param: string, min: number, max: number): PrismaMacroTarget {
  return { layer: -1, param, min, max };
}

/** Destino de macro sobre un campo de una capa concreta. */
export function on(
  layerIndex: number,
  param: string,
  min: number,
  max: number,
): PrismaMacroTarget {
  return { layer: layerIndex, param, min, max };
}

export function preset(
  id: string,
  name: string,
  category: PrismaCategory,
  tags: string[],
  layers: PrismaLayer[],
  base: Record<string, number>,
  macros: PrismaMacro[],
  pack = 'Prisma Core',
): PrismaPreset {
  return { id, name, pack, category, tags, layers, base, macros };
}

// ── Catálogo ─────────────────────────────────────────────────────────────────
// Partido en dos archivos porque son muchos y así se editan sin pelearse.

import { PRISMA_MELODIC } from './prisma-presets-melodic';
import { PRISMA_RHYTHM } from './prisma-presets-rhythm';

export const PRISMA_PRESETS: PrismaPreset[] = [...PRISMA_MELODIC, ...PRISMA_RHYTHM];

const BY_ID = new Map(PRISMA_PRESETS.map((p) => [p.id, p]));

export function findPrismaPreset(id: string | undefined): PrismaPreset | undefined {
  return id === undefined ? undefined : BY_ID.get(id);
}

/** Presets de una categoría, en el orden en que se declararon. */
export function prismaPresetsOf(category: PrismaCategory): PrismaPreset[] {
  return PRISMA_PRESETS.filter((p) => p.category === category);
}

/** Packs presentes en el catálogo (para el selector del browser). */
export function prismaPacks(): string[] {
  return [...new Set(PRISMA_PRESETS.map((p) => p.pack))];
}

/** Preset por defecto de un canal Prisma nuevo. */
export const DEFAULT_PRISMA_PRESET = 'keys/rhodes-nocturno';

/**
 * Params que deja un preset en el canal: los defaults del instrumento, encima
 * lo que declare el preset en `base`, y encima los valores de sus macros.
 * Cargar un preset es exactamente esto — por eso las perillas nunca mienten.
 */
export function prismaPresetParams(preset: PrismaPreset): Record<string, number> {
  const params = defaultInstrumentParams('prisma');
  for (const [key, value] of Object.entries(preset.base)) params[key] = value;
  for (let i = 0; i < PRISMA_MACROS; i++) {
    params[`macro${i + 1}`] = preset.macros[i]?.value ?? 0.5;
  }
  return params;
}

/** Etiqueta de la macro n (1..PRISMA_MACROS) del preset, o vacía si no la usa. */
export function prismaMacroLabel(preset: PrismaPreset | undefined, index: number): string {
  return preset?.macros[index]?.label ?? '';
}
