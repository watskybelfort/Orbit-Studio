/**
 * Orbit Nova — el instrumento de presets.
 *
 * La idea es la de FLEX: no eliges "un sintetizador y 20 perillas", eliges un
 * SONIDO de una librería organizada por packs y categorías, y lo moldeas con
 * unas pocas macros que valen para todos. Por dentro cada preset es una pila
 * de capas sobre los motores que ya tiene Orbit (sustractivo, supersaw, FM,
 * 808), así que no hay samples que cargar ni peso extra en el proyecto: un
 * canal Nova guarda solo el id del preset y sus macros.
 *
 * Vive en `core` (y no en el motor o la UI) porque lo necesitan los tres: el
 * compilador para mandar las capas al kernel, la UI para el browser, y el
 * modelo para saber qué sonido tiene el canal.
 */

/** Motores sobre los que se construye una capa de Nova. */
export type NovaEngine = 'synth' | 'supersaw' | 'fm' | 'sub808';

export interface NovaLayer {
  engine: NovaEngine;
  /** Params del motor (claves de INSTRUMENT_PARAMS[engine]). */
  params: Record<string, number>;
  /** Ganancia lineal de la capa dentro del preset. */
  gain: number;
  /** Pan de la capa -1..1 (la macro Width lo escala). */
  pan: number;
  /** Transposición de la capa en semitonos. */
  transpose: number;
}

/** Destino de una macro: qué parámetro mueve, en qué capa y entre qué valores. */
export interface NovaMacroTarget {
  /** Índice de capa, o -1 para todas. */
  layer: number;
  param: string;
  min: number;
  max: number;
}

export interface NovaMacro {
  label: string;
  /** Valor por defecto 0..1. */
  value: number;
  targets: NovaMacroTarget[];
}

export const NOVA_CATEGORIES = [
  'keys',
  'bass',
  'leads',
  'pads',
  'plucks',
  'bells',
  'organs',
  'atmos',
] as const;

export type NovaCategory = (typeof NOVA_CATEGORIES)[number];

export const NOVA_CATEGORY_LABELS: Record<NovaCategory, string> = {
  keys: 'Teclas',
  bass: 'Bajos',
  leads: 'Leads',
  pads: 'Pads',
  plucks: 'Plucks',
  bells: 'Campanas',
  organs: 'Órganos',
  atmos: 'Atmósferas',
};

export interface NovaPreset {
  /** Id estable, ej. "keys/rhodes-calido". */
  id: string;
  name: string;
  /** Pack al que pertenece (el de fábrica es "Orbit Core"). */
  pack: string;
  category: NovaCategory;
  /** Tags libres para el buscador: género, carácter… */
  tags: string[];
  layers: NovaLayer[];
  /** Hasta dos macros propias del preset (las otras perillas son fijas). */
  macros: [NovaMacro, NovaMacro];
}

// ── Helpers de autoría ───────────────────────────────────────────────────────

const layer = (
  engine: NovaEngine,
  params: Record<string, number>,
  gain = 1,
  pan = 0,
  transpose = 0,
): NovaLayer => ({ engine, params, gain, pan, transpose });

const macro = (label: string, value: number, targets: NovaMacroTarget[]): NovaMacro => ({
  label,
  value,
  targets,
});

/** Macro que mueve un parámetro en TODAS las capas. */
const all = (param: string, min: number, max: number): NovaMacroTarget => ({
  layer: -1,
  param,
  min,
  max,
});

const on = (layerIndex: number, param: string, min: number, max: number): NovaMacroTarget => ({
  layer: layerIndex,
  param,
  min,
  max,
});

const preset = (
  id: string,
  name: string,
  category: NovaCategory,
  tags: string[],
  layers: NovaLayer[],
  macros: [NovaMacro, NovaMacro],
  pack = 'Orbit Core',
): NovaPreset => ({ id, name, pack, category, tags, layers, macros });

// ── Catálogo de fábrica ──────────────────────────────────────────────────────
// Cada preset apila capas de los motores existentes. Nada de esto pesa en el
// proyecto: son números.

export const NOVA_PRESETS: NovaPreset[] = [
  // ── Teclas ────────────────────────────────────────────────────────────────
  preset(
    'keys/rhodes-calido',
    'Rhodes Cálido',
    'keys',
    ['rhodes', 'ep', 'boombap', 'lofi', 'suave'],
    [
      layer('fm', { ratio: 2, index: 2.4, indexDecay: 0.35, attack: 0.003, decay: 1.6, sustain: 0.25, release: 0.5, octave: 0 }, 0.9),
      layer('synth', { wave: 3, cutoff: 2600, resonance: 0.1, envAmount: 0.2, attack: 0.004, decay: 1.2, sustain: 0.2, release: 0.45, unison: 1, detune: 0, octave: 0 }, 0.35, 0.15),
    ],
    [
      macro('Campana', 0.4, [on(0, 'index', 0.5, 7)]),
      macro('Cuerpo', 0.5, [on(1, 'cutoff', 800, 5000)]),
    ],
  ),
  preset(
    'keys/ep-oscuro',
    'EP Oscuro',
    'keys',
    ['ep', 'dark', 'trap', 'noche'],
    [
      layer('fm', { ratio: 1, index: 1.6, indexDecay: 0.5, attack: 0.005, decay: 2.2, sustain: 0.2, release: 0.7, octave: -1 }, 1),
      layer('synth', { wave: 2, cutoff: 1200, resonance: 0.15, envAmount: 0.25, attack: 0.01, decay: 1.6, sustain: 0.25, release: 0.6, unison: 2, detune: 0.05, octave: 0 }, 0.4, -0.2),
    ],
    [
      macro('Aire', 0.35, [on(1, 'cutoff', 600, 6000)]),
      macro('Golpe', 0.5, [on(0, 'indexDecay', 0.08, 1.2)]),
    ],
  ),
  preset(
    'keys/piano-lofi',
    'Piano Lo-fi',
    'keys',
    ['piano', 'lofi', 'boombap', 'sample'],
    [
      layer('fm', { ratio: 3, index: 1.2, indexDecay: 0.25, attack: 0.002, decay: 1.1, sustain: 0.12, release: 0.35, octave: 0 }, 0.8),
      layer('synth', { wave: 3, cutoff: 1800, resonance: 0.05, envAmount: 0.15, attack: 0.002, decay: 0.9, sustain: 0.1, release: 0.3, unison: 1, detune: 0, octave: 1 }, 0.25, 0.25),
    ],
    [
      macro('Filtro cinta', 0.45, [all('cutoff', 700, 8000)]),
      macro('Cola', 0.4, [all('decay', 0.4, 2.6)]),
    ],
  ),
  preset(
    'keys/clavi-funk',
    'Clavi Funk',
    'keys',
    ['clavinet', 'funk', 'corto'],
    [
      layer('synth', { wave: 1, cutoff: 3600, resonance: 0.35, envAmount: 0.6, attack: 0.002, decay: 0.28, sustain: 0.05, release: 0.15, unison: 2, detune: 0.03, octave: 0 }, 1),
    ],
    [
      macro('Wah', 0.5, [on(0, 'cutoff', 900, 9000)]),
      macro('Mordida', 0.35, [on(0, 'resonance', 0.05, 0.85)]),
    ],
  ),

  // ── Bajos ─────────────────────────────────────────────────────────────────
  preset(
    'bass/808-largo',
    '808 Largo',
    'bass',
    ['808', 'trap', 'sub', 'glide'],
    [layer('sub808', { tune: 0, decay: 2.4, drive: 0.45, glide: 0.06, punch: 0.55, tone: 900 }, 1)],
    [
      macro('Distorsión', 0.45, [on(0, 'drive', 0, 1)]),
      macro('Cola', 0.6, [on(0, 'decay', 0.4, 4)]),
    ],
  ),
  preset(
    'bass/808-corto',
    '808 Corto',
    'bass',
    ['808', 'drill', 'punch'],
    [layer('sub808', { tune: 0, decay: 0.85, drive: 0.6, glide: 0.02, punch: 0.8, tone: 1400 }, 1)],
    [
      macro('Click', 0.6, [on(0, 'punch', 0, 1)]),
      macro('Distorsión', 0.6, [on(0, 'drive', 0, 1)]),
    ],
  ),
  preset(
    'bass/reese',
    'Reese',
    'bass',
    ['reese', 'dnb', 'dubstep', 'ancho'],
    [
      layer('supersaw', { detune: 0.55, blend: 0.6, cutoff: 900, attack: 0.01, release: 0.3, width: 0.7, octave: -2 }, 0.85),
      layer('sub808', { tune: 0, decay: 1.8, drive: 0.3, glide: 0.02, punch: 0.3, tone: 600 }, 0.6),
    ],
    [
      macro('Movimiento', 0.55, [on(0, 'detune', 0.1, 1)]),
      macro('Filtro', 0.4, [on(0, 'cutoff', 200, 4000)]),
    ],
  ),
  preset(
    'bass/fm-metal',
    'FM Metálico',
    'bass',
    ['fm', 'metal', 'techno'],
    [
      layer('fm', { ratio: 2.5, index: 5, indexDecay: 0.18, attack: 0.001, decay: 0.5, sustain: 0.4, release: 0.2, octave: -1 }, 1),
    ],
    [
      macro('Metal', 0.5, [on(0, 'index', 0.5, 10)]),
      macro('Cuerpo', 0.4, [on(0, 'decay', 0.1, 2)]),
    ],
  ),
  preset(
    'bass/pluck-bajo',
    'Pluck Bajo',
    'bass',
    ['pluck', 'reggaeton', 'corto'],
    [
      layer('synth', { wave: 0, cutoff: 1400, resonance: 0.25, envAmount: 0.7, attack: 0.001, decay: 0.22, sustain: 0.0, release: 0.12, unison: 1, detune: 0, octave: -1 }, 1),
      layer('sub808', { tune: 0, decay: 0.5, drive: 0.25, glide: 0.01, punch: 0.5, tone: 700 }, 0.5),
    ],
    [
      macro('Filtro', 0.4, [on(0, 'cutoff', 300, 6000)]),
      macro('Sub', 0.5, [on(1, 'decay', 0.15, 1.5)]),
    ],
  ),

  // ── Leads ─────────────────────────────────────────────────────────────────
  preset(
    'leads/saw-ancho',
    'Saw Ancho',
    'leads',
    ['supersaw', 'edm', 'ancho'],
    [layer('supersaw', { detune: 0.4, blend: 0.75, cutoff: 9000, attack: 0.01, release: 0.35, width: 0.9, octave: 0 }, 1)],
    [
      macro('Detune', 0.4, [on(0, 'detune', 0, 1)]),
      macro('Brillo', 0.6, [on(0, 'cutoff', 900, 18000)]),
    ],
  ),
  preset(
    'leads/square-8bit',
    'Square 8-bit',
    'leads',
    ['chiptune', 'square', 'retro'],
    [
      layer('synth', { wave: 1, cutoff: 7000, resonance: 0.1, envAmount: 0.2, attack: 0.001, decay: 0.4, sustain: 0.6, release: 0.1, unison: 1, detune: 0, octave: 1 }, 1),
    ],
    [
      macro('Brillo', 0.6, [on(0, 'cutoff', 1200, 16000)]),
      macro('Sostenido', 0.6, [on(0, 'sustain', 0, 1)]),
    ],
  ),
  preset(
    'leads/flauta-trap',
    'Flauta Trap',
    'leads',
    ['flauta', 'trap', 'melodia'],
    [
      layer('fm', { ratio: 1, index: 0.8, indexDecay: 0.6, attack: 0.04, decay: 1.2, sustain: 0.6, release: 0.25, octave: 1 }, 0.9),
      layer('synth', { wave: 3, cutoff: 4000, resonance: 0.05, envAmount: 0.1, attack: 0.05, decay: 1, sustain: 0.5, release: 0.3, unison: 1, detune: 0, octave: 1 }, 0.4),
    ],
    [
      macro('Soplo', 0.3, [on(0, 'index', 0.1, 3)]),
      macro('Ataque', 0.35, [all('attack', 0.005, 0.25)]),
    ],
  ),
  preset(
    'leads/hard-lead',
    'Hard Lead',
    'leads',
    ['hardstyle', 'gabber', 'duro'],
    [
      layer('supersaw', { detune: 0.7, blend: 0.9, cutoff: 12000, attack: 0.002, release: 0.15, width: 0.5, octave: 0 }, 0.9),
      layer('synth', { wave: 1, cutoff: 6000, resonance: 0.3, envAmount: 0.4, attack: 0.001, decay: 0.3, sustain: 0.8, release: 0.12, unison: 3, detune: 0.12, octave: -1 }, 0.5),
    ],
    [
      macro('Dureza', 0.6, [on(1, 'resonance', 0.05, 0.9)]),
      macro('Brillo', 0.7, [all('cutoff', 1500, 18000)]),
    ],
  ),

  // ── Pads ──────────────────────────────────────────────────────────────────
  preset(
    'pads/pad-calido',
    'Pad Cálido',
    'pads',
    ['pad', 'suave', 'fondo'],
    [
      layer('supersaw', { detune: 0.3, blend: 0.6, cutoff: 3200, attack: 0.6, release: 1.6, width: 1, octave: 0 }, 0.8),
      layer('synth', { wave: 3, cutoff: 2000, resonance: 0.05, envAmount: 0.1, attack: 0.8, decay: 2, sustain: 0.8, release: 2, unison: 2, detune: 0.04, octave: -1 }, 0.5),
    ],
    [
      macro('Apertura', 0.45, [all('cutoff', 400, 12000)]),
      macro('Ataque', 0.5, [all('attack', 0.05, 2)]),
    ],
  ),
  preset(
    'pads/pad-oscuro',
    'Pad Oscuro',
    'pads',
    ['pad', 'dark', 'cine', 'tension'],
    [
      layer('supersaw', { detune: 0.5, blend: 0.4, cutoff: 1200, attack: 1.2, release: 2.5, width: 1, octave: -1 }, 0.9),
      layer('fm', { ratio: 0.5, index: 1.5, indexDecay: 2, attack: 1, decay: 3, sustain: 0.7, release: 2, octave: -1 }, 0.4),
    ],
    [
      macro('Tensión', 0.4, [on(1, 'index', 0.2, 6)]),
      macro('Apertura', 0.3, [on(0, 'cutoff', 300, 8000)]),
    ],
  ),
  preset(
    'pads/coro-aire',
    'Coro de Aire',
    'pads',
    ['coro', 'voces', 'ambiente'],
    [
      layer('synth', { wave: 3, cutoff: 3500, resonance: 0.08, envAmount: 0.1, attack: 0.9, decay: 2.5, sustain: 0.85, release: 2.2, unison: 4, detune: 0.18, octave: 0 }, 0.8),
      layer('synth', { wave: 2, cutoff: 2600, resonance: 0.05, envAmount: 0.05, attack: 1.1, decay: 2.5, sustain: 0.8, release: 2.4, unison: 3, detune: 0.24, octave: 1 }, 0.35, 0.3),
    ],
    [
      macro('Coro', 0.5, [all('detune', 0.02, 0.5)]),
      macro('Aire', 0.5, [all('cutoff', 900, 14000)]),
    ],
  ),

  // ── Plucks ────────────────────────────────────────────────────────────────
  preset(
    'plucks/pluck-cristal',
    'Pluck Cristal',
    'plucks',
    ['pluck', 'brillante', 'reggaeton'],
    [
      layer('synth', { wave: 0, cutoff: 6000, resonance: 0.2, envAmount: 0.8, attack: 0.001, decay: 0.35, sustain: 0.0, release: 0.25, unison: 2, detune: 0.06, octave: 0 }, 0.9),
      layer('fm', { ratio: 4, index: 2, indexDecay: 0.12, attack: 0.001, decay: 0.5, sustain: 0, release: 0.3, octave: 1 }, 0.35),
    ],
    [
      macro('Brillo', 0.55, [on(0, 'cutoff', 1200, 16000)]),
      macro('Cola', 0.35, [all('decay', 0.1, 1.4)]),
    ],
  ),
  preset(
    'plucks/marimba',
    'Marimba',
    'plucks',
    ['marimba', 'madera', 'latin'],
    [
      layer('fm', { ratio: 4, index: 1.4, indexDecay: 0.08, attack: 0.001, decay: 0.55, sustain: 0, release: 0.3, octave: 0 }, 1),
    ],
    [
      macro('Madera', 0.4, [on(0, 'index', 0.3, 4)]),
      macro('Cola', 0.4, [on(0, 'decay', 0.15, 1.6)]),
    ],
  ),
  preset(
    'plucks/kalimba',
    'Kalimba',
    'plucks',
    ['kalimba', 'afrobeat', 'suave'],
    [
      layer('fm', { ratio: 3, index: 0.9, indexDecay: 0.14, attack: 0.001, decay: 0.8, sustain: 0, release: 0.4, octave: 1 }, 0.9),
      layer('synth', { wave: 3, cutoff: 3000, resonance: 0.05, envAmount: 0.3, attack: 0.001, decay: 0.6, sustain: 0, release: 0.35, unison: 1, detune: 0, octave: 1 }, 0.3),
    ],
    [
      macro('Metal', 0.3, [on(0, 'index', 0.2, 3)]),
      macro('Cola', 0.45, [all('decay', 0.2, 1.8)]),
    ],
  ),

  // ── Campanas ──────────────────────────────────────────────────────────────
  preset(
    'bells/campana-fm',
    'Campana FM',
    'bells',
    ['campana', 'bell', 'trap'],
    [
      layer('fm', { ratio: 7, index: 3.5, indexDecay: 0.6, attack: 0.001, decay: 2.2, sustain: 0, release: 1.2, octave: 0 }, 1),
    ],
    [
      macro('Metal', 0.5, [on(0, 'index', 0.5, 10)]),
      macro('Cola', 0.55, [on(0, 'decay', 0.4, 4)]),
    ],
  ),
  preset(
    'bells/caja-musica',
    'Caja de Música',
    'bells',
    ['caja', 'musical', 'cine', 'terror'],
    [
      layer('fm', { ratio: 5, index: 2.2, indexDecay: 0.3, attack: 0.001, decay: 1.4, sustain: 0, release: 0.9, octave: 1 }, 0.9),
      layer('synth', { wave: 3, cutoff: 5000, resonance: 0.05, envAmount: 0.4, attack: 0.001, decay: 1.2, sustain: 0, release: 0.8, unison: 1, detune: 0, octave: 2 }, 0.25),
    ],
    [
      macro('Brillo', 0.5, [on(1, 'cutoff', 1500, 16000)]),
      macro('Cola', 0.5, [all('decay', 0.3, 3)]),
    ],
  ),

  // ── Órganos ───────────────────────────────────────────────────────────────
  preset(
    'organs/organo-iglesia',
    'Órgano de Iglesia',
    'organs',
    ['organo', 'iglesia', 'cine'],
    [
      layer('synth', { wave: 3, cutoff: 4000, resonance: 0.05, envAmount: 0, attack: 0.08, decay: 0.2, sustain: 1, release: 0.35, unison: 2, detune: 0.02, octave: 0 }, 0.7),
      layer('synth', { wave: 3, cutoff: 3000, resonance: 0.05, envAmount: 0, attack: 0.08, decay: 0.2, sustain: 1, release: 0.35, unison: 1, detune: 0, octave: 1 }, 0.4, 0.2),
      layer('synth', { wave: 3, cutoff: 2200, resonance: 0.05, envAmount: 0, attack: 0.09, decay: 0.2, sustain: 1, release: 0.4, unison: 1, detune: 0, octave: -1 }, 0.5, -0.2),
    ],
    [
      macro('Registros', 0.5, [on(1, 'sustain', 0, 1)]),
      macro('Brillo', 0.5, [all('cutoff', 800, 12000)]),
    ],
  ),
  preset(
    'organs/organo-perreo',
    'Órgano Perreo',
    'organs',
    ['organo', 'reggaeton', 'dembow'],
    [
      layer('synth', { wave: 1, cutoff: 2600, resonance: 0.2, envAmount: 0.3, attack: 0.005, decay: 0.4, sustain: 0.7, release: 0.2, unison: 2, detune: 0.04, octave: 0 }, 0.9),
      layer('fm', { ratio: 2, index: 1, indexDecay: 0.3, attack: 0.004, decay: 0.6, sustain: 0.5, release: 0.2, octave: 0 }, 0.35),
    ],
    [
      macro('Filtro', 0.5, [on(0, 'cutoff', 600, 9000)]),
      macro('Mordida', 0.35, [on(0, 'resonance', 0.05, 0.8)]),
    ],
  ),

  // ── Atmósferas ────────────────────────────────────────────────────────────
  preset(
    'atmos/drone-tension',
    'Drone de Tensión',
    'atmos',
    ['drone', 'tension', 'cine', 'terror'],
    [
      layer('supersaw', { detune: 0.85, blend: 0.3, cutoff: 700, attack: 2, release: 3, width: 1, octave: -2 }, 0.9),
      layer('fm', { ratio: 0.5, index: 3, indexDecay: 3, attack: 2.5, decay: 4, sustain: 0.8, release: 3, octave: -1 }, 0.4),
    ],
    [
      macro('Inquietud', 0.5, [on(1, 'index', 0.5, 9)]),
      macro('Apertura', 0.25, [on(0, 'cutoff', 200, 6000)]),
    ],
  ),
  preset(
    'atmos/riser',
    'Riser',
    'atmos',
    ['riser', 'transicion', 'edm'],
    [
      layer('supersaw', { detune: 0.6, blend: 0.8, cutoff: 6000, attack: 1.8, release: 0.4, width: 1, octave: 1 }, 0.8),
      layer('synth', { wave: 0, cutoff: 3000, resonance: 0.5, envAmount: 0.9, attack: 1.6, decay: 2, sustain: 0.9, release: 0.3, unison: 3, detune: 0.2, octave: 0 }, 0.4),
    ],
    [
      macro('Subida', 0.6, [all('attack', 0.2, 3)]),
      macro('Brillo', 0.6, [all('cutoff', 800, 18000)]),
    ],
  ),
  preset(
    'atmos/sub-drop',
    'Sub Drop',
    'atmos',
    ['drop', 'sub', 'impacto'],
    [layer('sub808', { tune: -12, decay: 3.2, drive: 0.2, glide: 0.4, punch: 0.2, tone: 400 }, 1)],
    [
      macro('Caída', 0.6, [on(0, 'glide', 0.02, 0.5)]),
      macro('Cola', 0.7, [on(0, 'decay', 0.5, 4)]),
    ],
  ),
];

/** Índice por id (la UI y el compilador resuelven por aquí). */
const BY_ID = new Map(NOVA_PRESETS.map((p) => [p.id, p]));

export function findNovaPreset(id: string | undefined): NovaPreset | undefined {
  return id === undefined ? undefined : BY_ID.get(id);
}

/** Preset por defecto de un canal Nova nuevo. */
export const DEFAULT_NOVA_PRESET = 'keys/rhodes-calido';
