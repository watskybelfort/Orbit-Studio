/**
 * El formulario del panel Compositor, sin React: qué opciones tiene, cuáles
 * son las de fábrica y cómo se traducen a `ComposeOptions`.
 *
 * Vive aparte del `.tsx` para poder probar la traducción tal cual (regla de
 * tests de packages/ui): un «Auto» que se colara como `keyRoot: 0` haría que
 * todo saliera en Do sin que nada fallara.
 */

import { SCALES } from '@orbit/core';
import {
  COMPOSER_GENRES,
  COMPOSER_ROLES,
  GENRE_PRESETS,
  genreVariants,
  type ComposeOptions,
  type ComposerGenre,
  type ComposerRole,
  type StyleProfile,
} from '@orbit/sound-library';

/** Audios que se miden como mucho por entrenamiento (como learn_style del MCP). */
export const MAX_TRAIN_FILES = 32;

export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac'] as const;

export function isAudioFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type ShapeChoice = 'song' | 'loop';

export interface ComposerForm {
  genre: ComposerGenre;
  /** Variante del género, o `null` para la de siempre. */
  variant: string | null;
  seed: number;
  /** `null` = lo decide el género / el perfil. */
  bpm: number | null;
  keyRoot: number | null;
  scale: string | null;
  shape: ShapeChoice;
  loopBars: number;
  roles: ComposerRole[];
  /** Id del perfil de estilo, o `null` para componer solo con el género. */
  profileId: string | null;
  influence: number;
  complexity: number;
  soundVariation: number;
}

export function defaultForm(seed: number): ComposerForm {
  return {
    genre: 'trap',
    variant: null,
    seed,
    bpm: null,
    keyRoot: null,
    scale: null,
    shape: 'song',
    loopBars: 8,
    roles: [...COMPOSER_ROLES],
    profileId: null,
    influence: 0.5,
    complexity: 0.5,
    soundVariation: 0.35,
  };
}

/** Semilla nueva de 32 bits (el botón del dado). */
export function rollSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0xffffffff) >>> 0;
}

/**
 * Nombre de escala que `compose` acepta, o `null`. `hasOwnProperty` y no `in`:
 * `'toString' in SCALES` es cierto y `compose` acabaría indexando el prototipo.
 */
function knownScale(value: unknown): string | null {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SCALES, value)
    ? value
    : null;
}

/**
 * Traduce el formulario a opciones del compositor. `reference` es un perfil
 * de una sola pista (la referencia soltada en el panel): si hay, MANDA sobre
 * el perfil elegido, porque es lo último que el usuario pidió.
 */
export function toComposeOptions(
  form: ComposerForm,
  profiles: readonly StyleProfile[],
  reference: StyleProfile | null = null,
): ComposeOptions {
  const profile = reference ?? profiles.find((p) => p.id === form.profileId) ?? null;
  const opts: ComposeOptions = {
    genre: form.genre,
    seed: form.seed,
    roles: form.roles.length > 0 ? form.roles : [...COMPOSER_ROLES],
    complexity: form.complexity,
    soundVariation: form.soundVariation,
  };
  if (form.variant !== null && genreVariants(form.genre).some((v) => v.id === form.variant)) opts.variant = form.variant;
  if (form.bpm !== null) opts.bpm = form.bpm;
  if (form.keyRoot !== null) opts.keyRoot = form.keyRoot;
  // La escala también se valida aquí: un formulario construido a mano (o uno
  // restaurado por una ruta que no pase por `parseForm`) no debe reventar
  // `compose` con «escala desconocida».
  const scale = knownScale(form.scale);
  if (scale !== null) opts.scale = scale;
  if (form.shape === 'loop') {
    opts.shape = 'loop';
    opts.loopBars = form.loopBars;
  }
  if (profile) {
    opts.profile = profile;
    opts.influence = form.influence;
  }
  return opts;
}

/** Un formulario que llega de settings.json, saneado campo a campo. */
export function parseForm(raw: unknown, seed: number): ComposerForm {
  const base = defaultForm(seed);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  const genre = COMPOSER_GENRES.find((g) => g === r['genre']) ?? base.genre;
  const roles = Array.isArray(r['roles'])
    ? (r['roles'] as unknown[]).filter((x): x is ComposerRole => COMPOSER_ROLES.includes(x as ComposerRole))
    : base.roles;
  const variant = genreVariants(genre).find((v) => v.id === r['variant'])?.id ?? null;
  // Una escala que no es de `SCALES` (settings viejo o editado a mano) se tira
  // aquí: `compose` LANZA con una escala desconocida, así que dejarla pasar
  // convertía el ajuste persistido en un compositor que no compone.
  const scale = knownScale(r['scale']);
  return {
    genre,
    variant,
    seed,
    bpm: num(r['bpm'], 40, 250) ?? null,
    keyRoot: (() => {
      const k = num(r['keyRoot'], 0, 11);
      return k !== undefined && Number.isInteger(k) ? k : null;
    })(),
    scale,
    shape: r['shape'] === 'loop' ? 'loop' : 'song',
    loopBars: Math.round(num(r['loopBars'], 1, 32) ?? base.loopBars),
    roles: roles.length > 0 ? roles : base.roles,
    profileId: typeof r['profileId'] === 'string' ? r['profileId'] : null,
    influence: num(r['influence'], 0, 1) ?? base.influence,
    complexity: num(r['complexity'], 0, 1) ?? base.complexity,
    soundVariation: num(r['soundVariation'], 0, 1) ?? base.soundVariation,
  };
}

/** El rango de tempo del género, para el placeholder del campo BPM. */
export function bpmHint(genre: ComposerGenre, variant: string | null = null): string {
  const preset = genreVariants(genre).find((v) => v.id === variant)?.preset ?? GENRE_PRESETS[genre];
  const { min, max, default: def } = preset.bpm;
  return `${def} (${min}–${max})`;
}
