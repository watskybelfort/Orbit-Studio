/**
 * Filtros combinables del browser: texto, categoría, género/tag, tonalidad y
 * rango de BPM. Todo son funciones puras sobre `SoundEntry[]` para que el
 * componente solo pinte y el conteo de resultados salga del mismo sitio que
 * la lista (nunca se desincronizan).
 *
 * Los filtros se combinan en Y (todos deben cumplirse); dentro de tags y
 * tonalidades se combinan en O (cualquiera de las marcadas vale), que es como
 * la gente espera que funcione un panel de chips.
 */

import { SOUND_CATEGORIES, type SoundCategory, type SoundEntry } from '@orbit/sound-library';

/** Rango de tempo que admite el filtro (coincide con el detector). */
export const BPM_MIN = 60;
export const BPM_MAX = 200;

export interface BrowserFilters {
  /** Texto libre: nombre, subcategoría o tag. */
  query: string;
  /** Categorías marcadas; vacío = todas. */
  categories: ReadonlySet<SoundCategory>;
  /** Tags/géneros marcados; vacío = todos. */
  tags: ReadonlySet<string>;
  /** Tonalidades marcadas ("C", "F#"…); vacío = todas. */
  keys: ReadonlySet<string>;
  /** Rango de BPM, o null si no se filtra por tempo. */
  bpm: { min: number; max: number } | null;
  /** Solo favoritos. */
  onlyFavorites: boolean;
  /** Colección concreta, o null para no filtrar por colección. */
  collection: string | null;
}

export const EMPTY_FILTERS: BrowserFilters = {
  query: '',
  categories: new Set(),
  tags: new Set(),
  keys: new Set(),
  bpm: null,
  onlyFavorites: false,
  collection: null,
};

/** Minúsculas y sin acentos, para buscar sin distinción. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** ¿Hay algún filtro activo (más allá del texto)? */
export function hasActiveFilters(f: BrowserFilters): boolean {
  return (
    f.query.trim() !== '' ||
    f.categories.size > 0 ||
    f.tags.size > 0 ||
    f.keys.size > 0 ||
    f.bpm !== null ||
    f.onlyFavorites ||
    f.collection !== null
  );
}

/** Cuántos filtros distintos están puestos (para el badge del botón). */
export function countActiveFilters(f: BrowserFilters): number {
  let n = 0;
  if (f.query.trim() !== '') n++;
  n += f.categories.size + f.tags.size + f.keys.size;
  if (f.bpm !== null) n++;
  if (f.onlyFavorites) n++;
  if (f.collection !== null) n++;
  return n;
}

export interface MatchContext {
  favorites: ReadonlySet<string>;
  /** Ids de la colección seleccionada, o null si no hay ninguna. */
  collectionIds: ReadonlySet<string> | null;
}

/** ¿La entrada pasa TODOS los filtros? */
export function matches(entry: SoundEntry, f: BrowserFilters, ctx: MatchContext): boolean {
  if (f.onlyFavorites && !ctx.favorites.has(entry.id)) return false;
  if (ctx.collectionIds !== null && !ctx.collectionIds.has(entry.id)) return false;
  if (f.categories.size > 0 && !f.categories.has(entry.category)) return false;
  if (f.keys.size > 0 && (entry.keyRoot === undefined || !f.keys.has(entry.keyRoot))) return false;
  if (f.bpm !== null) {
    if (entry.bpm === undefined) return false;
    if (entry.bpm < f.bpm.min || entry.bpm > f.bpm.max) return false;
  }
  if (f.tags.size > 0) {
    let alguno = false;
    for (const t of entry.tags) {
      if (f.tags.has(t)) {
        alguno = true;
        break;
      }
    }
    if (!alguno) return false;
  }
  const q = normalize(f.query.trim());
  if (q !== '') {
    if (normalize(entry.name).includes(q)) return true;
    if (entry.subcategory !== undefined && normalize(entry.subcategory).includes(q)) return true;
    return entry.tags.some((t) => normalize(t).includes(q));
  }
  return true;
}

export function filterEntries(
  entries: readonly SoundEntry[],
  f: BrowserFilters,
  ctx: MatchContext,
): SoundEntry[] {
  return entries.filter((e) => matches(e, f, ctx));
}

// ── Facetas (lo que se ofrece en el panel de filtros) ────────────────────────

export interface Facets {
  /** Tags ordenados por frecuencia y luego alfabéticamente. */
  tags: string[];
  /** Tonalidades presentes, en orden cromático. */
  keys: string[];
  /** Rango real de BPM del catálogo, o null si nadie declara tempo. */
  bpmRange: { min: number; max: number } | null;
  /** Categorías con al menos una entrada, en el orden fijo del browser. */
  categories: SoundCategory[];
}

const CHROMATIC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Extrae las opciones que tiene sentido ofrecer para un conjunto de sonidos. */
export function buildFacets(entries: readonly SoundEntry[]): Facets {
  const tagCount = new Map<string, number>();
  const keys = new Set<string>();
  const cats = new Set<SoundCategory>();
  let bpmMin = Infinity;
  let bpmMax = -Infinity;

  for (const e of entries) {
    cats.add(e.category);
    for (const t of e.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    if (e.keyRoot !== undefined) keys.add(e.keyRoot);
    if (e.bpm !== undefined) {
      if (e.bpm < bpmMin) bpmMin = e.bpm;
      if (e.bpm > bpmMax) bpmMax = e.bpm;
    }
  }

  return {
    tags: [...tagCount.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t]) => t),
    keys: [...keys].sort((a, b) => {
      const ia = CHROMATIC.indexOf(a);
      const ib = CHROMATIC.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    }),
    bpmRange:
      bpmMin <= bpmMax
        ? { min: Math.floor(bpmMin), max: Math.ceil(bpmMax) }
        : null,
    categories: SOUND_CATEGORIES.filter((c) => cats.has(c)),
  };
}
