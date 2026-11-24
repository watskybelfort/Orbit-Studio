/**
 * El compositor: de un género (y opcionalmente un perfil de estilo) a un beat
 * entero, con cada parte por separado.
 *
 * Sale un `BeatPlan` — datos puros, sin ids de proyecto ni comandos — y
 * `plan-commands.ts` lo convierte en canales, patrones, clips y secciones del
 * bus de comandos. Separarlo así permite probar la música (¿el dembow es
 * dembow?, ¿el 808 cae con el bombo?, ¿la melodía está en la escala?) sin
 * montar un proyecto, y que el MCP describa un plan antes de aplicarlo.
 *
 * Cómo piensa, parte a parte:
 * - **Batería**: cada carril se sortea UNA vez por beat a partir de las
 *   probabilidades del género (mezcladas con las del perfil si lo hay). Así el
 *   groove es el mismo en todo el tema y las secciones solo lo recortan o lo
 *   rellenan — como cuando uno programa un patrón y lo va abriendo.
 * - **Bajo**: sigue la raíz del acorde de cada compás y se apoya en el bombo
 *   (808 y sub) o en su propio patrón (contratiempo, rodando, tocado).
 * - **Acordes**: grados de la escala con conducción de voces (cada acorde se
 *   coloca en la inversión más cercana al anterior).
 * - **Melodía**: un motivo de uno o dos compases que se repite ajustándose al
 *   acorde y responde en el cuarto compás; nunca sale de la escala.
 */

import { SCALES } from '@orbit/core';
import { densityOf, planSections, type Section, type SectionKind } from '../pack-structure';
import {
  COMPOSER_ROLES,
  GENRE_PRESETS,
  ROLE_LABELS,
  genreDrumLanes,
  type ComposerGenre,
  type ComposerRole,
  type FxChoice,
  type GenrePreset,
  type SoundChoice,
  type StepProb,
} from './genres';
import { fitTempo, styleHint, type StyleHint, type StyleProfile } from './profile';
import { createRng, hashString, type Rng } from './rng';
import { factoryInstrument, factorySound } from './factory-index';
import { DRUM_PITCH, kickTune } from './drum-pitch';

export const BEATS_PER_BAR = 4;
/** Compases como mucho de un beat (tope de seguridad para MCP y UI). */
export const MAX_COMPOSE_BARS = 128;
const STEP = 0.25; // una semicorchea, en beats

export interface ComposeOptions {
  genre: ComposerGenre;
  seed: number;
  /** Tempo fijo; si falta, el del perfil o el del género. */
  bpm?: number;
  /** Tónica 0..11; si falta, la del perfil o una al azar del género. */
  keyRoot?: number;
  /** Nombre de escala de `SCALES`; si falta, una del género. */
  scale?: string;
  /**
   * Forma del tema: índice de `planSections`, o `'loop'` para un solo bucle de
   * `loopBars` compases (lo que se quiere para empezar a escribir encima).
   */
  shape?: number | 'loop';
  /** Compases del bucle cuando `shape = 'loop'` (por defecto 8). */
  loopBars?: number;
  /** Partes que se generan (por defecto todas). */
  roles?: readonly ComposerRole[];
  /** Perfil aprendido de audio que empuja el estilo. */
  profile?: StyleProfile | null;
  /** 0..1 — cuánto manda el perfil sobre el género (por defecto 0.5). */
  influence?: number;
  /** 0..1 — cuánto se aleja cada sonido del preset (sonidos nuevos). Por defecto 0.35. */
  soundVariation?: number;
  /** 0..1 — densidad de notas (por defecto 0.5). */
  complexity?: number;
  /** Grados de la escala por compás, para forzar una progresión concreta. */
  progression?: number[];
}

export interface PlanNote {
  /** Beats desde el inicio del patrón. */
  start: number;
  duration: number;
  key: number;
  velocity: number;
  slide?: boolean;
}

export interface PlanPattern {
  /** Clave única dentro de la parte (p. ej. `drop-8`). */
  id: string;
  name: string;
  bars: number;
  notes: PlanNote[];
}

export interface PlanClip {
  patternId: string;
  startBar: number;
  bars: number;
}

export interface ResolvedSound {
  kind: SoundChoice['kind'];
  preset?: string;
  /**
   * Solo sampler: qué sonido de la librería de fábrica suena en cada tecla
   * (la de DRUM_MAP de la pieza, o 60/62 en los FX). Cada tecla toca su sample
   * a su altura original.
   */
  samples?: Record<number, string>;
  /** Solo sampler de batería: afinación de la zona de cada tecla, en semitonos (el bombo a la tonalidad). */
  tunes?: Record<number, number>;
  /** Solo sampler de batería: capas extra que suenan en la MISMA tecla (el click del bombo de trap). */
  layers?: { key: number; sampleId: string }[];
  /**
   * Solo sampler: un instrumento multisampleado de fábrica (`instrumentos/…`)
   * con sus tomas por altura y por fuerza. Se toca como cualquier instrumento:
   * el keymap reparte el teclado entre las raíces de las tomas.
   */
  zones?: { sampleId: string; keyRoot: number; velLow: number; velHigh: number }[];
  /** Parámetros del canal que se sobrescriben sobre los del preset/instrumento. */
  params: Record<string, number>;
  volume: number;
}

export interface PlanPart {
  role: ComposerRole;
  name: string;
  sound: ResolvedSound;
  fx: FxChoice[];
  patterns: PlanPattern[];
  clips: PlanClip[];
}

export interface PlanSection {
  kind: SectionKind;
  name: string;
  startBar: number;
  bars: number;
}

export interface BeatPlan {
  genre: ComposerGenre;
  seed: number;
  bpm: number;
  swing: number;
  keyRoot: number;
  scaleName: string;
  /** Grados por compás del bucle armónico (se repite). */
  progression: number[];
  /** Forma usada (índice de `planSections` o `'loop'`), para recomponer encima. */
  shape: number | 'loop';
  loopBars: number;
  sections: PlanSection[];
  totalBars: number;
  parts: PlanPart[];
  master: FxChoice[];
  /** Qué se usó del perfil (para contarlo en la UI y el MCP). */
  style: { profile: string; matched: number; grooved: number; influence: number } | null;
}

export const SECTION_LABELS: Record<SectionKind, string> = {
  intro: 'Intro',
  build: 'Subida',
  drop: 'Drop',
  break: 'Puente',
  outro: 'Final',
  verse: 'Verso',
  hook: 'Hook',
};

/**
 * Formas de canción de rap del compositor, además de las tres de club del
 * pack (0..2): versos de 16 y hooks de 8, sin subida ni redoble de caja
 * (eso es de EDM). La transición al hook es un corte: el bombo y el bajo se
 * callan en la segunda mitad del último compás del verso.
 */
export const RAP_SHAPES: readonly { kind: SectionKind; bars: number }[][] = [
  [
    { kind: 'intro', bars: 8 }, { kind: 'hook', bars: 8 }, { kind: 'verse', bars: 16 }, { kind: 'hook', bars: 8 },
    { kind: 'verse', bars: 16 }, { kind: 'hook', bars: 8 }, { kind: 'outro', bars: 4 },
  ],
  [
    { kind: 'intro', bars: 4 }, { kind: 'verse', bars: 16 }, { kind: 'hook', bars: 8 }, { kind: 'verse', bars: 16 },
    { kind: 'hook', bars: 8 }, { kind: 'outro', bars: 4 },
  ],
];
/** Índice de la primera forma de rap (las 0..2 son las de club). */
export const RAP_SHAPE_BASE = 3;
export const SHAPE_TOTAL = RAP_SHAPE_BASE + RAP_SHAPES.length;

/** ¿Suena esta sección con la batería entera (drop de club, hook o verso)? */
function isFull(kind: SectionKind): boolean {
  return kind === 'drop' || kind === 'hook' || kind === 'verse';
}

export const NOTE_LABELS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

// ── Entrada saneada ───────────────────────────────────────────────────────────

/** Comprueba y normaliza las opciones; lanza `Error` con un motivo legible. */
export function normalizeComposeOptions(opts: ComposeOptions): Required<Omit<ComposeOptions, 'bpm' | 'keyRoot' | 'scale' | 'profile' | 'progression' | 'shape'>> &
  Pick<ComposeOptions, 'bpm' | 'keyRoot' | 'scale' | 'profile' | 'progression' | 'shape'> {
  if (!GENRE_PRESETS[opts.genre]) throw new Error(`género desconocido "${String(opts.genre)}"`);
  if (!Number.isFinite(opts.seed)) throw new Error('seed debe ser un número');
  if (opts.bpm !== undefined && !(opts.bpm >= 40 && opts.bpm <= 250)) throw new Error('bpm fuera de 40..250');
  if (opts.keyRoot !== undefined && !(Number.isInteger(opts.keyRoot) && opts.keyRoot >= 0 && opts.keyRoot < 12)) {
    throw new Error('keyRoot debe ser un entero 0..11');
  }
  if (opts.scale !== undefined && !SCALES[opts.scale]) {
    throw new Error(`escala desconocida "${opts.scale}" (${Object.keys(SCALES).join(', ')})`);
  }
  const loopBars = opts.loopBars ?? 8;
  if (!(Number.isInteger(loopBars) && loopBars >= 1 && loopBars <= 32)) throw new Error('loopBars debe ser un entero 1..32');
  const roles = opts.roles ?? COMPOSER_ROLES;
  if (roles.length === 0) throw new Error('hay que pedir al menos una parte');
  for (const r of roles) if (!COMPOSER_ROLES.includes(r)) throw new Error(`parte desconocida "${String(r)}"`);
  if (opts.progression !== undefined) {
    if (!Array.isArray(opts.progression) || opts.progression.length < 1 || opts.progression.length > 16) {
      throw new Error('progression: de 1 a 16 grados');
    }
    for (const d of opts.progression) if (!(Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error('progression: grados enteros 0..6');
  }
  const shape = opts.shape;
  if (shape !== undefined && shape !== 'loop' && !(Number.isInteger(shape) && shape >= 0 && shape < 100)) {
    throw new Error('shape: índice de forma o "loop"');
  }
  return {
    genre: opts.genre,
    seed: Math.floor(Math.abs(opts.seed)) >>> 0,
    bpm: opts.bpm,
    keyRoot: opts.keyRoot,
    scale: opts.scale,
    shape,
    loopBars,
    roles: [...new Set(roles)],
    profile: opts.profile ?? null,
    influence: clamp(opts.influence ?? 0.5, 0, 1),
    soundVariation: clamp(opts.soundVariation ?? 0.35, 0, 1),
    complexity: clamp(opts.complexity ?? 0.5, 0, 1),
    progression: opts.progression,
  };
}

// ── Armonía ───────────────────────────────────────────────────────────────────

/** Semitono (0..11 relativo a la tónica) del grado `degree` de la escala. */
function degreePc(scale: readonly number[], degree: number): number {
  const n = scale.length;
  const octave = Math.floor(degree / n);
  return scale[((degree % n) + n) % n]! + 12 * octave;
}

/**
 * Acorde por terceras apiladas sobre la escala (funciona igual en pentatónicas
 * y blues: apila «cada dos notas» de la escala que haya). Semitonos relativos
 * a la tónica, sin octava fija.
 */
export function chordTones(scale: readonly number[], degree: number, seventh: boolean): number[] {
  const tones = [degreePc(scale, degree), degreePc(scale, degree + 2), degreePc(scale, degree + 4)];
  if (seventh) tones.push(degreePc(scale, degree + 6));
  return tones;
}

/** Coloca el acorde en la inversión más cercana a `center` (MIDI). */
function voiceChord(pcs: number[], keyRoot: number, center: number, clusterPenalty = 0): number[] {
  let best: number[] = [];
  let bestScore = Infinity;
  for (let inv = 0; inv < pcs.length; inv++) {
    for (let oct = 2; oct <= 7; oct++) {
      const notes: number[] = [];
      let prev = -Infinity;
      for (let i = 0; i < pcs.length; i++) {
        const pc = pcs[(i + inv) % pcs.length]!;
        let key = keyRoot + pc + 12 * oct;
        while (key <= prev) key += 12;
        notes.push(key);
        prev = key;
      }
      const mid = (notes[0]! + notes[notes.length - 1]!) / 2;
      let score = Math.abs(mid - center) + (notes[notes.length - 1]! - notes[0]!) * 0.05;
      // Dos notas a un semitono (la 7.ª mayor pegada a la raíz) embarran el acorde en el grave.
      if (clusterPenalty > 0) for (let i = 1; i < notes.length; i++) if (notes[i]! - notes[i - 1]! === 1) score += clusterPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
    }
  }
  return best;
}

/** Tecla de bajo para una nota de la escala: siempre en 27..38 (como el 808 de la plantilla). */
function bassKey(keyRoot: number, pc: number): number {
  let key = 24 + ((((keyRoot + pc) % 12) + 12) % 12);
  if (key < 27) key += 12;
  return key;
}

/** Lleva una nota al rango por octavas (sin salirse de la escala, al contrario que recortar). */
function foldOctave(key: number, lo: number, hi: number): number {
  let k = key;
  while (k > hi) k -= 12;
  while (k < lo) k += 12;
  return k;
}

/** Nota de la escala más cercana a `key` (MIDI), para no salirse nunca. */
function snapToScale(key: number, keyRoot: number, scale: readonly number[]): number {
  for (let d = 0; d <= 6; d++) {
    for (const k of [key - d, key + d]) {
      const rel = (((k - keyRoot) % 12) + 12) % 12;
      if (scale.includes(rel)) return k;
    }
  }
  return key;
}

// ── Batería ───────────────────────────────────────────────────────────────────

type DrumLaneId = 'kick' | 'snare' | 'hats' | 'perc';

/** Mezcla las probabilidades del género con las del perfil, sin perder los anclajes. */
function blendLane(genre: StepProb[], learned: number[] | null, influence: number): StepProb[] {
  if (!learned || influence <= 0) return genre;
  return genre.map((s, i) => {
    const l = learned[i] ?? 0;
    // Un anclaje del género (p=1) se queda: el dembow no deja de tener su bombo
    // en el 1 por mucho que la referencia lo esconda.
    const p = s.p >= 1 ? 1 : clamp((1 - influence) * s.p + influence * (l > 0.18 ? l : 0), 0, 1);
    const vel = s.vel > 0 ? s.vel : 0.72;
    return { p, vel };
  });
}

/** Un compás de 16 pasos sorteado: velocidad por paso (0 = silencio). */
function rollBar(lane: StepProb[], rng: Rng, densityBoost: number): number[] {
  return lane.map((s) => {
    const p = s.p >= 1 ? 1 : clamp(s.p * (0.6 + densityBoost * 0.8), 0, 1);
    return rng.chance(p) ? s.vel : 0;
  });
}

interface DrumGroove {
  /** Compás base y relleno (último compás de cada frase de 4). */
  main: number[];
  fill: number[];
}

function drumGrooves(
  preset: GenrePreset,
  hint: StyleHint | null,
  influence: number,
  complexity: number,
  rng: Rng,
): Record<DrumLaneId, DrumGroove> {
  const lanes = genreDrumLanes(preset.id);
  const learned: Record<DrumLaneId, number[] | null> = {
    kick: hint?.lanes?.low ?? null,
    snare: hint?.lanes?.mid ?? null,
    hats: hint?.lanes?.high ?? null,
    perc: null,
  };
  const out = {} as Record<DrumLaneId, DrumGroove>;
  let kickAnchors: boolean[] = new Array(16).fill(false);
  for (const id of ['kick', 'snare', 'hats', 'perc'] as const) {
    const r = rng.fork(`drum-${id}`);
    if (lanes[id].variants.length === 0) {
      out[id] = { main: new Array(16).fill(0), fill: new Array(16).fill(0) };
      continue;
    }
    const variant = r.pick(lanes[id].variants);
    const blended = blendLane(variant, learned[id], influence);
    if (id === 'kick') kickAnchors = blended.map((s) => s.p >= 1);
    const main = rollBar(blended, r, complexity);
    // El relleno parte de OTRA variante del género: el cambio se nota pero no desentona.
    const other = lanes[id].variants[(lanes[id].variants.indexOf(variant) + 1) % lanes[id].variants.length]!;
    const fill = rollBar(blendLane(other, learned[id], influence), r, Math.min(1, complexity + 0.3));
    // El 1 del compás siempre lleva bombo: sin él no hay groove que valga.
    if (id === 'kick') {
      main[0] = Math.max(main[0]!, 0.95);
      fill[0] = Math.max(fill[0]!, 0.95);
    }
    out[id] = { main, fill };
  }
  // Bombo y caja no se pisan en el mismo paso, salvo donde el bombo es un
  // anclaje del género (el cuatro en el suelo lleva bombo Y palmas en el 2 y el 4).
  for (const g of ['main', 'fill'] as const) {
    const k = out.kick[g];
    const s = out.snare[g];
    for (let i = 1; i < 16; i++) if (s[i]! >= 0.8 && k[i]! > 0 && !kickAnchors[i]) k[i] = 0;
  }
  return out;
}

function stepsToNotes(steps: number[], bar: number, key: number, rng: Rng, len = STEP * 0.9): PlanNote[] {
  const notes: PlanNote[] = [];
  steps.forEach((vel, i) => {
    if (vel <= 0) return;
    notes.push({
      start: bar * BEATS_PER_BAR + i * STEP,
      duration: len,
      key,
      velocity: round3(clamp(vel * rng.range(0.9, 1.04), 0.08, 1)),
    });
  });
  return notes;
}

/** Redoble de hats (1/32 o tresillo) sobre un tiempo del compás. */
function hatRoll(bar: number, beat: number, key: number, rng: Rng): PlanNote[] {
  const triplet = rng.chance(0.4);
  const count = triplet ? 6 : rng.pick([4, 8]);
  const span = triplet ? 1 : rng.pick([0.5, 1]);
  const notes: PlanNote[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    notes.push({
      start: bar * BEATS_PER_BAR + beat + span * t,
      duration: (span / count) * 0.9,
      key,
      velocity: round3(clamp(0.45 + 0.45 * t, 0.1, 1)),
    });
  }
  return notes;
}

// ── Generación por sección ────────────────────────────────────────────────────

interface Ctx {
  preset: GenrePreset;
  rng: Rng;
  keyRoot: number;
  scale: number[];
  progression: number[];
  grooves: Record<DrumLaneId, DrumGroove>;
  complexity: number;
  motif: { start: number; duration: number; degree: number; velocity: number }[];
  motifBars: number;
  bpm: number;
  swing: number;
}

function chordAt(ctx: Ctx, absBar: number): number {
  return ctx.progression[absBar % ctx.progression.length]!;
}

function drumPart(
  ctx: Ctx,
  lane: DrumLaneId,
  kind: SectionKind,
  bars: number,
  sectionStartBar: number,
): PlanNote[] {
  const density = densityOf(kind);
  const level = lane === 'hats' ? density.hats : density.drums;
  if (level <= 0) return [];
  const { preset } = ctx;
  const key = preset.drums.keys[lane];
  const groove = ctx.grooves[lane];
  const rng = ctx.rng.fork(`${lane}-${kind}-${bars}-${sectionStartBar}`);
  const notes: PlanNote[] = [];
  for (let b = 0; b < bars; b++) {
    const last = b === bars - 1;
    const phraseEnd = b % 4 === 3;
    let steps = [...(phraseEnd && isFull(kind) ? groove.fill : groove.main)];

    if (kind === 'build') {
      // La subida quita el bombo en su último compás y deja que la caja redoble.
      if (lane === 'kick' && (last || b >= bars - Math.ceil(bars / 2))) steps = steps.map((v, i) => (i === 0 && !last ? v : 0));
      if (lane === 'perc') steps = steps.map(() => 0);
    } else if (kind === 'break' || kind === 'outro') {
      // A media asta: bombo solo en los tiempos fuertes, sin percusión.
      if (lane === 'kick') steps = steps.map((v, i) => (i === 0 || (i === 8 && rng.chance(0.5)) ? v : 0));
      if (lane === 'perc') steps = steps.map((v) => (rng.chance(0.35) ? v : 0));
      if (lane === 'snare' && kind === 'outro' && b >= bars - 1) steps = steps.map(() => 0);
    } else if (kind === 'intro') {
      if (lane !== 'hats') steps = steps.map(() => 0);
    } else if (kind === 'verse' && last && lane === 'kick') {
      // El corte antes del hook: el bombo se calla en la segunda mitad del compás.
      steps = steps.map((v, i) => (i < 8 ? v : 0));
    }

    if (lane === 'hats' && density.doubleHats) {
      // Hats al doble en la subida: todas las semicorcheas, con acento en negras.
      steps = steps.map((_, i) => (i % 4 === 0 ? 0.85 : i % 2 === 0 ? 0.62 : 0.45));
    }
    if (lane === 'hats' && kind === 'intro') steps = steps.map((v) => v * 0.7);

    notes.push(...stepsToNotes(steps, b, key, rng, lane === 'kick' ? STEP * 1.6 : STEP * 0.9));

    // Redobles de hats (trap) en los drops.
    if (lane === 'hats' && isFull(kind) && !(kind === 'verse' && last) && rng.chance(preset.drums.hatRolls * (0.5 + ctx.complexity))) {
      const beat = rng.pick([1, 3, 3.5]);
      const at = b * BEATS_PER_BAR + beat;
      // El redoble sustituye a lo que hubiera en ese tramo.
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i]!;
        if (n.start >= at && n.start < at + 1) notes.splice(i, 1);
      }
      notes.push(...hatRoll(b, beat, key, rng).filter((n) => n.start < (b + 1) * BEATS_PER_BAR));
    }
    // Hat abierto a contratiempo.
    if (lane === 'hats' && preset.drums.keys.openhat !== undefined && (isFull(kind) || kind === 'break')) {
      if (rng.chance(preset.drums.openHats)) {
        const at = b * BEATS_PER_BAR + rng.pick(preset.drums.openHats > 0.5 ? [0.5, 1.5, 2.5, 3.5] : [1.5, 3.5]);
        if (preset.drums.openHats > 0.5) {
          for (const off of [0.5, 1.5, 2.5, 3.5]) {
            notes.push({ start: b * BEATS_PER_BAR + off, duration: 0.4, key: preset.drums.keys.openhat, velocity: 0.62 });
          }
        } else {
          notes.push({ start: at, duration: 0.45, key: preset.drums.keys.openhat, velocity: 0.6 });
        }
      }
    }
    // Remate de caja al cerrar cada frase de 4 en verso y hook (urbanos): sin
    // él la caja era idéntica 16 compases seguidos.
    if (lane === 'snare' && preset.drums.snareFills && (kind === 'verse' || kind === 'hook') && phraseEnd) {
      const at = (i: number) => b * BEATS_PER_BAR + i * STEP;
      const fill = rng.pick([[13, 15], [14, 15], [11, 14, 15], [13, 14, 15]]);
      for (const [j, i] of fill.entries()) {
        if (notes.some((n) => Math.abs(n.start - at(i)) < 1e-6 && n.key === key)) continue;
        notes.push({ start: at(i), duration: STEP * 0.8, key, velocity: round3(0.45 + 0.4 * (j / Math.max(1, fill.length - 1))) });
      }
    }
    // Palmas doblando la caja en el drop.
    if (lane === 'snare' && isFull(kind) && preset.drums.clapLayer !== undefined) {
      steps.forEach((v, i) => {
        if (v >= 0.8) notes.push({ start: b * BEATS_PER_BAR + i * STEP, duration: STEP * 0.9, key: preset.drums.clapLayer!, velocity: round3(v * 0.8) });
      });
    }
    // Redoble de caja al cerrar la subida (anuncia el drop).
    if (lane === 'snare' && density.roll && last) {
      for (let i = notes.length - 1; i >= 0; i--) if (notes[i]!.start >= b * BEATS_PER_BAR) notes.splice(i, 1);
      for (let i = 0; i < 16; i++) {
        const t = i / 15;
        notes.push({ start: b * BEATS_PER_BAR + i * STEP, duration: STEP * 0.8, key, velocity: round3(0.35 + 0.6 * t) });
      }
    }
  }
  const feel = preset.drums.feelMs?.[lane];
  if (feel) applyFeel(notes, feel, ctx.bpm, ctx.swing);
  return notes.sort((a, b) => a.start - b.start || a.key - b.key);
}

/** Las opciones de sonido de una parte; la melodía (con `tune`) no repite el timbre de los acordes. */
function timbreChoices(choices: SoundChoice[], role: ComposerRole, preset: GenrePreset, chordsTimbre: string | undefined): SoundChoice[] {
  if (role !== 'melody' || !preset.melody.tune || !chordsTimbre) return choices;
  const other = choices.filter((c) => {
    const id = c.preset ?? (c.instrument ? factoryInstrument(c.instrument)?.[0]?.id : undefined);
    return id !== chordsTimbre;
  });
  return other.length > 0 ? other : choices;
}

/**
 * Microtiming fijo por pieza (boom bap): el bombo un poco tarde, la caja un
 * poco adelantada, los hats bastante tarde, y el MISMO desfase en cada compás
 * —así suena una MPC tocada, no un humanizado al azar (Linn, Bonedo, Hein).
 *
 * El motor solo aplica el swing a las notas que caen en la rejilla, y estas
 * dejan de caer en ella al moverlas; por eso se les aplica aquí el swing del
 * beat antes del desfase, con la misma cuenta que `swungStart` del compilador.
 */
function applyFeel(notes: PlanNote[], ms: number, bpm: number, swing: number): void {
  const shift = (ms / 1000) * (bpm / 60);
  for (const n of notes) {
    const step = Math.round(n.start / STEP);
    let start = n.start;
    if (swing > 0 && Math.abs(start - step * STEP) < 1e-4 && step % 2 === 1) start += swing * (STEP / 2);
    n.start = round3(Math.max(0, start + shift));
  }
}

function bassPart(ctx: Ctx, kind: SectionKind, bars: number, sectionStartBar: number): PlanNote[] {
  const notes = bassNotes(ctx, kind, bars, sectionStartBar);
  if (kind !== 'verse') return notes;
  // El corte antes del hook, igual que el bombo: nada de bajo en la segunda
  // mitad del último compás del verso, y lo que venía sonando se apaga ahí.
  const cut = (bars - 1) * BEATS_PER_BAR + 2;
  return notes
    .filter((n) => n.start < cut)
    .map((n) => (n.start + n.duration > cut ? { ...n, duration: round3(cut - n.start) } : n));
}

function bassNotes(ctx: Ctx, kind: SectionKind, bars: number, sectionStartBar: number): PlanNote[] {
  const density = densityOf(kind);
  if (density.bass <= 0) return [];
  const { preset, keyRoot, scale } = ctx;
  const rng = ctx.rng.fork(`bass-${kind}-${bars}-${sectionStartBar}`);
  const style = preset.bass.style;
  const notes: PlanNote[] = [];
  const activeBars = density.bass < 1 ? Math.max(1, Math.round(bars * density.bass)) : bars;
  for (let b = 0; b < activeBars; b++) {
    const degree = chordAt(ctx, sectionStartBar + b);
    const root = bassKey(keyRoot, degreePc(scale, degree));
    const fifth = bassKey(keyRoot, degreePc(scale, degree + 4));
    const barStart = b * BEATS_PER_BAR;
    const kicks = (b % 4 === 3 && isFull(kind) ? ctx.grooves.kick.fill : ctx.grooves.kick.main)
      .map((v, i) => (v > 0 ? i : -1))
      .filter((i) => i >= 0);

    if (style === '808' || style === 'sub') {
      const hits = preset.bass.hits ?? (kicks.length > 0 ? kicks : [0]);
      hits.forEach((step, idx) => {
        const next = hits[idx + 1] ?? 16;
        const len = (next - step) * STEP;
        let key = root;
        let slide = false;
        // El glide va donde lo pone un productor: cerrando la frase (último
        // compás de cada 4, segunda mitad) y casi siempre hacia la quinta. Un
        // slide en cada nota pierde el impacto (Output, Attack): por eso aquí
        // ya no se sortea en cualquier golpe.
        const phraseTail = (sectionStartBar + b) % 4 === 3 && step >= 8;
        if (idx > 0 && phraseTail && rng.chance(Math.min(1, preset.bass.glide * (1.2 + ctx.complexity)))) {
          key = rng.chance(0.7) ? fifth : root + 12;
          slide = style === '808';
        }
        notes.push({
          start: barStart + step * STEP,
          duration: round3(style === 'sub' ? Math.min(len * 0.85, 0.75) : Math.max(STEP, len * 0.96)),
          key,
          velocity: round3(idx === 0 ? 0.95 : rng.range(0.78, 0.9)),
          ...(slide ? { slide: true } : null),
        });
      });
    } else if (style === 'walk') {
      const hits = [...new Set([...kicks, 14])].sort((a, z) => a - z);
      hits.forEach((step, idx) => {
        const next = hits[idx + 1] ?? 16;
        const isPickup = step === 14 && !kicks.includes(14);
        const nextRoot = bassKey(keyRoot, degreePc(scale, chordAt(ctx, sectionStartBar + b + 1)));
        const raw = isPickup ? snapToScale(nextRoot + (rng.chance(0.5) ? -1 : 2), keyRoot, scale) : idx === 0 ? root : rng.pick([root, fifth, root + 12]);
        // La nota de paso puede caer un semitono por debajo del grave del bajo: se dobla arriba.
        const key = foldOctave(raw, 27, 51);
        notes.push({
          start: barStart + step * STEP,
          duration: round3(Math.min((next - step) * STEP * 0.8, 1)),
          key,
          velocity: round3(rng.range(0.7, 0.9)),
        });
      });
    } else if (style === 'offbeat') {
      for (const step of [2, 6, 10, 14]) {
        notes.push({
          start: barStart + step * STEP,
          duration: round3(STEP * rng.range(1.2, 1.6)),
          key: rng.chance(0.15 + ctx.complexity * 0.2) ? root + 12 : root,
          velocity: round3(rng.range(0.75, 0.92)),
        });
      }
    } else {
      // rolling: todas las semicorcheas menos las del bombo.
      for (let step = 0; step < 16; step++) {
        if (step % 4 === 0) continue;
        notes.push({
          start: barStart + step * STEP,
          duration: STEP * 0.8,
          key: step % 4 === 3 && rng.chance(0.3) ? root + 12 : root,
          velocity: round3(step % 4 === 2 ? 0.9 : 0.72),
        });
      }
    }
  }
  return notes;
}

function chordPart(ctx: Ctx, kind: SectionKind, bars: number, sectionStartBar: number): PlanNote[] {
  const density = densityOf(kind);
  if (density.melody <= 0) return [];
  const { preset, keyRoot, scale } = ctx;
  const rng = ctx.rng.fork(`chords-${kind}-${bars}-${sectionStartBar}`);
  const center = preset.chords.center ?? 12 * preset.chords.octave + 7; // ~G de esa octava (C5 = 60)
  const notes: PlanNote[] = [];
  let prevCenter = center;
  const sevenths = rng.chance(preset.chords.sevenths);
  for (let b = 0; b < bars; b++) {
    const degree = chordAt(ctx, sectionStartBar + b);
    const pcs = chordTones(scale, degree, sevenths);
    const voiced = voiceChord(pcs, keyRoot, (prevCenter * 2 + center) / 3, preset.chords.openVoicing ? 6 : 0);
    prevCenter = (voiced[0]! + voiced[voiced.length - 1]!) / 2;
    const barStart = b * BEATS_PER_BAR;
    const hits: { at: number; len: number; vel: number }[] = [];
    switch (preset.chords.style) {
      case 'pad':
        hits.push({ at: 0, len: BEATS_PER_BAR * 0.98, vel: 0.7 });
        break;
      case 'stabs': {
        const offs = [0.5, 1.5, 2.5, 3.5].filter((_, i) => i === 0 || rng.chance(0.55 + ctx.complexity * 0.3));
        for (const at of offs) hits.push({ at, len: 0.3, vel: 0.72 });
        break;
      }
      case 'perreo':
        // En el verso, con `sparseVerse`, el rasgueo deja huecos para la voz.
        for (const at of kind === 'verse' && preset.chords.sparseVerse ? [0, 1.5, 2, 3.5] : [0, 0.75, 1.5, 2, 2.75, 3.5]) {
          hits.push({ at, len: 0.4, vel: at % 2 === 0 ? 0.78 : 0.66 });
        }
        break;
      case 'chops':
        hits.push({ at: 0, len: 1.4, vel: 0.74 });
        if (rng.chance(0.7)) hits.push({ at: 1.75, len: 0.5, vel: 0.6 });
        hits.push({ at: 2.5, len: 1.4, vel: 0.68 });
        break;
    }
    // En la intro y el puente los acordes van más suaves.
    const soft = kind === 'intro' || kind === 'break' ? 0.82 : 1;
    for (const h of hits) {
      for (const key of voiced) {
        notes.push({
          start: barStart + h.at,
          duration: round3(h.len),
          key,
          velocity: round3(clamp(h.vel * soft * rng.range(0.94, 1.03), 0.1, 1)),
        });
      }
    }
  }
  return notes;
}

/** El motivo: ritmo y grados relativos al acorde, compuesto una vez por beat. */
function buildMotif(preset: GenrePreset, rng: Rng, complexity: number): { notes: Ctx['motif']; bars: number } {
  const style = preset.melody.style;
  const bars = style === 'hook' ? 2 : style === 'riff' ? 1 : rng.pick([1, 2]);
  const perBar = clamp(Math.round(preset.melody.density * (0.6 + complexity * 0.8)), 2, 12);
  const notes: Ctx['motif'] = [];
  for (let b = 0; b < bars; b++) {
    if (style === 'arp') {
      const step = perBar > 6 ? 0.25 : 0.5;
      const shape = rng.pick([[0, 2, 4, 2], [0, 2, 4, 7], [4, 2, 0, 2], [0, 4, 2, 4]]);
      for (let i = 0; i * step < BEATS_PER_BAR; i++) {
        notes.push({ start: b * BEATS_PER_BAR + i * step, duration: step * 0.9, degree: shape[i % shape.length]!, velocity: i % 4 === 0 ? 0.85 : 0.68 });
      }
      continue;
    }
    if (style === 'riff') {
      // Dos o tres alturas, en semicorcheas sueltas: hipnótico.
      const pool = rng.pick([[0, 0, 7], [0, 1, 0], [0, 7, 6], [0, 2, 4]]);
      const slots = Array.from({ length: 16 }, (_, i) => i).filter((i) => rng.chance((perBar / 16) * (i % 2 === 0 ? 1.3 : 0.7)));
      if (!slots.includes(0)) slots.unshift(0);
      for (const s of slots) {
        notes.push({ start: b * BEATS_PER_BAR + s * STEP, duration: STEP * rng.pick([0.9, 1.8]), degree: rng.pick(pool), velocity: s % 4 === 0 ? 0.84 : 0.7 });
      }
      continue;
    }
    // motif / hook: posiciones en corcheas (hook: con huecos para la voz).
    const grid = style === 'hook' ? 0.5 : rng.chance(0.5) ? 0.5 : 0.25;
    const slotsInBar = BEATS_PER_BAR / grid;
    const chosen = new Set<number>([0]);
    while (chosen.size < Math.min(perBar, slotsInBar)) chosen.add(rng.int(0, slotsInBar - 1));
    const sorted = [...chosen].sort((a, z) => a - z);
    let degree = rng.pick([0, 2, 4]);
    sorted.forEach((slot, i) => {
      const next = sorted[i + 1] ?? slotsInBar;
      const gap = (next - slot) * grid;
      // Paso a paso por la escala, con algún salto; los tiempos fuertes tiran al acorde.
      const strong = (slot * grid) % 2 === 0;
      degree = strong ? rng.pick([0, 2, 4, degree]) : clamp(degree + rng.weighted([-2, -1, 1, 2, 3], [1, 3, 3, 1, 0.5]), -3, 9);
      notes.push({
        start: b * BEATS_PER_BAR + slot * grid,
        duration: round3(Math.max(grid * 0.8, Math.min(gap * (style === 'hook' ? 0.95 : 0.7), 2))),
        degree,
        velocity: round3(strong ? rng.range(0.78, 0.9) : rng.range(0.62, 0.78)),
      });
    });
  }
  return { notes, bars };
}

function melodyPart(ctx: Ctx, kind: SectionKind, bars: number, sectionStartBar: number): PlanNote[] {
  const density = densityOf(kind);
  // En el puente la melodía calla a ratos: deja respirar.
  if (density.melody < 0.8) return [];
  const { preset, keyRoot, scale } = ctx;
  const rng = ctx.rng.fork(`melody-${kind}-${bars}-${sectionStartBar}`);
  // Convención FL de la casa: octava 5 = C5 = 60.
  const base = 12 * preset.melody.octave;
  const notes: PlanNote[] = [];
  for (let b = 0; b < bars; b += ctx.motifBars) {
    const answer = (b / ctx.motifBars) % 4 === 3 || (ctx.motifBars === 2 && (b / 2) % 2 === 1);
    for (const m of ctx.motif) {
      const absBar = Math.floor(m.start / BEATS_PER_BAR) + b;
      if (absBar >= bars) continue;
      const chordDeg = chordAt(ctx, sectionStartBar + absBar);
      let deg = m.degree + chordDeg;
      // La respuesta: misma rítmica, otra altura, y la última nota a la tónica.
      if (answer) deg += rng.pick([-1, 1, 2]);
      const isLast = answer && m === ctx.motif[ctx.motif.length - 1];
      if (isLast) deg = Math.round(deg / scale.length) * scale.length;
      let key = snapToScale(keyRoot + base + degreePc(scale, deg), keyRoot, scale);
      const tune = preset.melody.tune;
      if (tune) {
        // Un semitono por encima de una nota del acorde (b9: G sobre el F# de un
        // Re, C sobre el B de un Mi menor) choca: se baja a esa nota del acorde.
        const tones = chordTones(scale, chordDeg, false).map((pc) => (keyRoot + pc) % 12);
        if (tones.some((pc) => (((key - pc) % 12) + 12) % 12 === 1)) key -= 1;
      }
      notes.push({
        start: b * BEATS_PER_BAR + m.start,
        duration: m.duration,
        key: foldOctave(key, preset.melody.range?.[0] ?? 48, preset.melody.range?.[1] ?? 96),
        // Con `tune`, la fuerza respira (±10 %): dos velocidades fijas suenan a máquina.
        velocity: round3(clamp(m.velocity * (kind === 'intro' ? 0.85 : 1) * (tune ? rng.range(0.88, 1.08) : 1), 0.1, 1)),
      });
    }
  }
  // En la intro, solo la primera mitad: presenta y deja hueco.
  return kind === 'intro' ? notes.filter((n) => n.start < Math.max(BEATS_PER_BAR, (bars * BEATS_PER_BAR) / 2) || rng.chance(0.5)) : notes;
}

/** Tecla del barrido y del impacto en el sampler de FX. */
export const FX_RISER_KEY = 60;
export const FX_IMPACT_KEY = 62;

/**
 * FX con samples de fábrica: el barrido arranca para TERMINAR justo donde cae
 * el drop (mide lo que mide el archivo, así que se calcula con el tempo), y
 * el impacto cae en el primer tiempo del drop. Nada en intro ni puente.
 */
function fxSamplePart(kind: SectionKind, bars: number, bpm: number, riserId: string): PlanNote[] {
  if (kind === 'build') {
    const sec = factorySound(riserId)?.durationSec ?? 3.4;
    const len = Math.min(bars * BEATS_PER_BAR, Math.ceil(((sec * bpm) / 60) * 4) / 4);
    return [{ start: bars * BEATS_PER_BAR - len, duration: len, key: FX_RISER_KEY, velocity: 0.75 }];
  }
  if (kind === 'drop') return [{ start: 0, duration: BEATS_PER_BAR, key: FX_IMPACT_KEY, velocity: 0.8 }];
  return [];
}

function fxPart(kind: SectionKind, bars: number, keyRoot: number): PlanNote[] {
  // Riser en la subida (los dos últimos compases) y un barrido al arrancar la intro.
  const key = 60 + keyRoot;
  if (kind === 'build') {
    const len = Math.min(bars, 2) * BEATS_PER_BAR;
    return [{ start: bars * BEATS_PER_BAR - len, duration: len, key, velocity: 0.8 }];
  }
  if (kind === 'intro') return [{ start: 0, duration: Math.min(bars, 2) * BEATS_PER_BAR, key, velocity: 0.6 }];
  return [];
}

// ── Sonidos ───────────────────────────────────────────────────────────────────

/**
 * El sonido de una parte: el preset del género, movido por el perfil (brillo,
 * suciedad) y por la semilla. Eso es lo que hace que cada beat estrene sonido
 * sin salirse del carácter: las macros y perillas se mueven dentro de rangos
 * seguros, nunca a un extremo que rompa el preset.
 */
function resolveSound(
  choice: SoundChoice,
  role: ComposerRole,
  preset: GenrePreset,
  hint: StyleHint | null,
  variation: number,
  rng: Rng,
): ResolvedSound {
  const params: Record<string, number> = { ...(choice.params ?? {}) };
  const jitter = (base: number, spread: number, lo: number, hi: number): number =>
    round3(clamp(base + (rng.next() * 2 - 1) * spread * variation, lo, hi));
  const bright = hint ? hint.brightness - 0.5 : 0;
  const grit = hint ? hint.grit - 0.5 : 0;

  if (choice.kind === 'drums') {
    Object.assign(params, preset.kit);
    params['tone'] = jitter(clamp((preset.kit['tone'] ?? 0.5) + bright * 0.4, 0, 1), 0.15, 0, 1);
    params['punch'] = jitter(clamp((preset.kit['punch'] ?? 0.5) + grit * 0.3, 0, 1), 0.15, 0, 1);
    params['decay'] = jitter(preset.kit['decay'] ?? 1, 0.25, 0.3, 1.8);
  } else if (choice.kind === 'sub808') {
    params['drive'] = jitter(clamp((params['drive'] ?? 0.45) + grit * 0.4, 0, 1), 0.15, 0, 1);
    params['decay'] = jitter(params['decay'] ?? 1.2, 0.4, 0.3, 3);
    params['tone'] = Math.round(clamp((params['tone'] ?? 900) * (1 + bright * 0.6) * (1 + (rng.next() * 2 - 1) * 0.25 * variation), 250, 3500));
  } else if (choice.kind === 'nova') {
    params['filter'] = jitter(0.5 + bright * 0.35, 0.18, 0.15, 0.9);
    params['drive'] = jitter(clamp(grit * 0.5, 0, 0.6), 0.12, 0, 0.7);
    params['macro1'] = jitter(0.5, 0.25, 0.1, 0.9);
    params['macro2'] = jitter(0.5, 0.25, 0.1, 0.9);
  } else if (choice.kind === 'prisma') {
    // Las macros de Prisma son el sitio pensado para mover un preset sin romperlo.
    for (let i = 1; i <= 4; i++) params[`macro${i}`] = jitter(0.5 + (i === 2 ? bright * 0.3 : 0), 0.3, 0.05, 0.95);
  }
  const baseVolume = choice.volume ?? (role === 'bass' ? 0.8 : 0.78);
  const takes = choice.instrument ? factoryInstrument(choice.instrument) : undefined;
  return {
    kind: choice.kind,
    ...(takes ? { zones: takes.map((t) => ({ sampleId: t.id, keyRoot: t.rootMidi, velLow: t.velLow, velHigh: t.velHigh })) } : null),
    ...(choice.preset ? { preset: choice.preset } : null),
    params,
    volume: round3(clamp(baseVolume * (1 + (rng.next() * 2 - 1) * 0.05), 0.1, 1.2)),
  };
}

/**
 * Batería sampleada: un canal sampler por parte con, en cada tecla de las
 * piezas que toca esa parte (bombo; caja + palmas; hat + abierto;
 * percusión), uno de los sonidos de fábrica que el género propone para ella.
 */
function sampledDrum(preset: GenrePreset, lane: DrumLaneId, rng: Rng, keyRoot: number): ResolvedSound {
  const d = preset.drums;
  const keys: number[] =
    lane === 'kick' ? [d.keys.kick]
      : lane === 'snare' ? [d.keys.snare, ...(d.clapLayer !== undefined ? [d.clapLayer] : [])]
        : lane === 'hats' ? [d.keys.hats, ...(d.keys.openhat !== undefined ? [d.keys.openhat] : [])]
          : [d.keys.perc];
  const samples: Record<number, string> = {};
  for (const key of keys) {
    const options = preset.drumKit?.[key];
    if (options && options.length > 0) samples[key] = rng.pick(options);
  }
  const sound: ResolvedSound = { kind: 'sampler', params: {}, volume: 0.8, samples };
  if (lane === 'kick' && d.tuneKick) {
    const id = samples[d.keys.kick];
    const pitch = id ? DRUM_PITCH[id] : undefined;
    const tune = pitch === undefined ? 0 : kickTune(pitch, keyRoot);
    if (tune !== 0) sound.tunes = { [d.keys.kick]: tune };
  }
  if (lane === 'kick' && d.kickLayer) sound.layers = [{ key: d.keys.kick, sampleId: d.kickLayer }];
  return sound;
}

// ── Plan entero ───────────────────────────────────────────────────────────────

function resolveShape(opts: ReturnType<typeof normalizeComposeOptions>, preset: GenrePreset, rng: Rng): number | 'loop' {
  if (opts.shape !== undefined) return opts.shape;
  return preset.shapes.length > 0 ? rng.pick(preset.shapes) : 0;
}

function sectionsFor(shape: number | 'loop', loopBars: number): Section[] {
  if (shape === 'loop') return [{ kind: 'drop', bars: loopBars, startBar: 0 }];
  const rap = RAP_SHAPES[shape - RAP_SHAPE_BASE];
  if (rap) {
    let startBar = 0;
    return rap.map((s) => {
      const section = { kind: s.kind, bars: s.bars, startBar };
      startBar += s.bars;
      return section;
    });
  }
  return planSections(shape);
}

export function composeBeat(input: ComposeOptions): BeatPlan {
  const opts = normalizeComposeOptions(input);
  const preset = GENRE_PRESETS[opts.genre];
  const rng = createRng(hashString(opts.genre, opts.seed));
  const hint = opts.profile ? styleHint(opts.profile, opts.genre) : null;
  const influence = hint ? opts.influence : 0;

  // Tempo: el pedido, o el del perfil (llevado al rango del género), o el del género.
  const tr = rng.fork('tempo');
  let bpm = opts.bpm;
  if (bpm === undefined && hint?.bpm && influence > 0) bpm = fitTempo(hint.bpm, opts.genre) ?? undefined;
  if (bpm === undefined) bpm = preset.bpm.default + tr.int(-3, 3);
  bpm = Math.round(clamp(bpm, 40, 250) * 10) / 10;

  // Tonalidad y escala.
  const kr = rng.fork('key');
  let keyRoot = opts.keyRoot;
  if (keyRoot === undefined && hint?.keyRoot !== null && hint?.keyRoot !== undefined && influence > 0) keyRoot = hint.keyRoot;
  if (keyRoot === undefined) {
    keyRoot = preset.roots && preset.roots.length > 0
      ? kr.weighted(preset.roots.map((r) => r.root), preset.roots.map((r) => r.weight))
      : kr.int(0, 11);
  }
  let scaleName = opts.scale;
  if (!scaleName) {
    const candidates = preset.scales;
    // Si el perfil dice mayor, se prefieren las escalas mayores del género (y al revés).
    const weights = candidates.map((s) => {
      const major = SCALES[s.name]![2] === 4;
      if (!hint?.keyMode || influence <= 0) return s.weight;
      return s.weight * ((hint.keyMode === 'major') === major ? 1 + influence * 3 : 1);
    });
    scaleName = kr.weighted(candidates.map((s) => s.name), weights);
  }
  const scale = SCALES[scaleName]!;
  const progression = opts.progression ?? kr.pick(preset.progressions);

  const swing = round3(clamp(hint && influence > 0 ? (1 - influence) * preset.swing + influence * hint.swing : preset.swing, 0, 0.75));
  const shape = resolveShape(opts, preset, rng.fork('shape'));
  const sections = sectionsFor(shape, opts.loopBars);
  const totalBars = sections.reduce((s, x) => s + x.bars, 0);
  if (totalBars > MAX_COMPOSE_BARS) throw new Error(`el tema mide ${totalBars} compases (máximo ${MAX_COMPOSE_BARS})`);

  const motif = buildMotif(preset, rng.fork('motif'), opts.complexity);
  const ctx: Ctx = {
    preset,
    rng,
    keyRoot,
    scale,
    progression,
    grooves: drumGrooves(preset, hint, influence, opts.complexity, rng.fork('grooves')),
    complexity: opts.complexity,
    motif: motif.notes,
    motifBars: motif.bars,
    bpm,
    swing,
  };

  const parts: PlanPart[] = [];
  const sr = rng.fork('sounds');
  // El timbre de los acordes, para no repetirlo en la melodía (dos partes con el
  // mismo piano eléctrico se tapan en la misma banda).
  let chordsTimbre: string | undefined;
  for (const role of COMPOSER_ROLES) {
    if (!opts.roles.includes(role)) continue;
    const isDrum = role === 'kick' || role === 'snare' || role === 'hats' || role === 'perc';
    const choices = isDrum ? preset.sounds.drums : preset.sounds[role as 'bass' | 'chords' | 'melody' | 'fx'];
    // Un género sin sonidos para una parte no la tiene (boom bap sin FX).
    if (choices.length === 0) continue;
    const roleRng = sr.fork(role);
    const sound = isDrum && preset.drumKit
      ? sampledDrum(preset, role as DrumLaneId, roleRng, keyRoot)
      : role === 'fx' && preset.fxKit
        ? { kind: 'sampler' as const, params: {}, volume: choices[0]!.volume ?? 0.5, samples: { [FX_RISER_KEY]: preset.fxKit.riser, [FX_IMPACT_KEY]: preset.fxKit.impact } }
        : resolveSound(roleRng.pick(timbreChoices(choices, role, preset, chordsTimbre)), role, preset, hint, opts.soundVariation, roleRng);
    if (role === 'chords') chordsTimbre = sound.preset ?? sound.zones?.[0]?.sampleId;

    const patterns: PlanPattern[] = [];
    const clips: PlanClip[] = [];
    const byKey = new Map<string, PlanPattern>();
    for (const s of sections) {
      // Los dos drops (o las dos subidas) comparten patrón si miden lo mismo,
      // como en un arreglo hecho a mano; el bajo y la armonía dependen del
      // compás de arranque solo a través de la progresión, que es cíclica.
      // Cada verso se compone aparte (otros redobles, otros remates): copiar el
      // primero en el segundo sonaba a bucle. Los hooks sí se repiten iguales.
      const pid = s.kind === 'verse' ? `${s.kind}-${s.bars}-${s.startBar}` : `${s.kind}-${s.bars}`;
      const at = s.kind === 'verse' ? s.startBar : 0;
      let pattern = byKey.get(pid);
      if (!pattern) {
        const notes =
          role === 'bass'
            ? bassPart(ctx, s.kind, s.bars, at)
            : role === 'chords'
              ? chordPart(ctx, s.kind, s.bars, at)
              : role === 'melody'
                ? melodyPart(ctx, s.kind, s.bars, at)
                : role === 'fx'
                  ? preset.fxKit
                    ? fxSamplePart(s.kind, s.bars, bpm, preset.fxKit.riser)
                    : fxPart(s.kind, s.bars, keyRoot)
                  : drumPart(ctx, role, s.kind, s.bars, at);
        pattern = { id: pid, name: `${ROLE_LABELS[role]} · ${SECTION_LABELS[s.kind]}`, bars: s.bars, notes };
        byKey.set(pid, pattern);
        if (notes.length > 0) patterns.push(pattern);
      }
      if (pattern.notes.length > 0) clips.push({ patternId: pid, startBar: s.startBar, bars: s.bars });
    }
    if (sound.samples) {
      const playable = new Set(Object.keys(sound.samples).map(Number));
      for (const pt of patterns) pt.notes = pt.notes.filter((n) => playable.has(n.key));
      const emptied = new Set(patterns.filter((pt) => pt.notes.length === 0).map((pt) => pt.id));
      for (let i = patterns.length - 1; i >= 0; i--) if (emptied.has(patterns[i]!.id)) patterns.splice(i, 1);
      for (let i = clips.length - 1; i >= 0; i--) if (emptied.has(clips[i]!.patternId)) clips.splice(i, 1);
    }
    if (clips.length === 0) continue;
    // El volumen de la batería se reparte por pieza, según el balance del género.
    if (isDrum) sound.volume = round3(clamp(sound.volume * preset.drumMix[role as DrumLaneId], 0.1, 1.6));
    parts.push({ role, name: ROLE_LABELS[role], sound, fx: preset.fx[role] ?? [], patterns, clips });
  }

  return {
    genre: opts.genre,
    seed: opts.seed,
    bpm,
    swing,
    keyRoot,
    scaleName,
    progression,
    shape,
    loopBars: opts.loopBars,
    sections: sections.map((s) => ({ kind: s.kind, name: SECTION_LABELS[s.kind], startBar: s.startBar, bars: s.bars })),
    totalBars,
    parts,
    master: preset.master,
    style: hint && opts.profile ? { profile: opts.profile.name, matched: hint.matched, grooved: hint.grooved, influence } : null,
  };
}

/**
 * Vuelve a componer UNA parte dejando el resto igual: misma tonalidad, tempo,
 * progresión y forma; otra semilla para esa parte. Es el «no me gusta la
 * melodía, dame otra» del MCP y del panel.
 */
export function recomposePart(
  plan: BeatPlan,
  role: ComposerRole,
  seed: number,
  extra: Pick<ComposeOptions, 'profile' | 'influence' | 'soundVariation' | 'complexity'> = {},
): PlanPart | null {
  const beat = composeBeat({
    genre: plan.genre,
    seed,
    bpm: plan.bpm,
    keyRoot: plan.keyRoot,
    scale: plan.scaleName,
    progression: plan.progression,
    shape: plan.shape,
    loopBars: plan.loopBars,
    roles: [role],
    ...extra,
  });
  return beat.parts[0] ?? null;
}

/** Una línea legible del plan («Neo perreo · 98 BPM · F# Frigio · 40 compases · 8 partes»). */
export function describePlan(plan: BeatPlan): string {
  const preset = GENRE_PRESETS[plan.genre];
  const style = plan.style ? ` · estilo «${plan.style.profile}» (${plan.style.matched} pistas)` : '';
  return `${preset.name} · ${plan.bpm} BPM · ${NOTE_LABELS[plan.keyRoot]} ${plan.scaleName} · ${plan.totalBars} compases · ${plan.parts.length} partes${style}`;
}
