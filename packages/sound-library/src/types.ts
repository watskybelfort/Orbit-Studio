/**
 * Tipos del manifest de la librería de sonidos (pack de fábrica "Orbit
 * Essentials" y packs de usuario). El manifest es un JSON plano que el
 * browser de la UI indexa: categorías fijas + tags libres por entrada.
 */

/** Categorías raíz del browser (claves estables, en el manifest). */
export const SOUND_CATEGORIES = [
  'drums',
  '808s',
  'instrumentos',
  'percusion-latina',
  'fx',
  'melodic-loops',
] as const;

export type SoundCategory = (typeof SOUND_CATEGORIES)[number];

export interface SoundEntry {
  /** Id estable y único dentro del pack, ej. "drums/trap/kick-01". */
  id: string;
  /** Nombre visible en el browser. */
  name: string;
  category: SoundCategory;
  /** Subgrupo dentro de la categoría (ej. "trap", "boombap"). */
  subcategory?: string;
  /** Ruta del WAV relativa a la raíz del pack. */
  file: string;
  /** Tags libres: género, pieza, carácter ("punchy", "dark", "long"...). */
  tags: string[];
  /** Nota raíz cuando aplica (808s y loops), ej. "F". */
  keyRoot?: string;
  /** BPM cuando aplica (loops). */
  bpm?: number;
  /** Duración real del archivo en segundos. */
  durationSec: number;
  /**
   * Ganancia lineal sugerida al cargar en un canal (los WAV van
   * normalizados a -1 dBFS; esto equilibra piezas entre sí).
   */
  gainSuggestion?: number;
}

export interface SoundManifest {
  /** Versión del formato/pack, semver. */
  version: string;
  /** Nombre del pack, ej. "Orbit Essentials". */
  pack: string;
  /** Herramienta/motor que generó el pack (trazabilidad). */
  generatedWith: string;
  entries: SoundEntry[];
}

function isCategory(x: unknown): x is SoundCategory {
  return typeof x === 'string' && (SOUND_CATEGORIES as readonly string[]).includes(x);
}

function fail(idx: number, msg: string): never {
  throw new Error(`Manifest inválido (entrada ${idx}): ${msg}`);
}

/**
 * Parsea y valida un manifest JSON. Lanza Error con mensaje claro si el
 * JSON no cumple la forma mínima (campos obligatorios y tipos).
 */
export function loadManifest(json: string): SoundManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Manifest inválido: no es JSON parseable');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Manifest inválido: la raíz debe ser un objeto');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m['version'] !== 'string' || m['version'].length === 0) {
    throw new Error('Manifest inválido: falta "version" (string)');
  }
  if (typeof m['pack'] !== 'string' || m['pack'].length === 0) {
    throw new Error('Manifest inválido: falta "pack" (string)');
  }
  if (typeof m['generatedWith'] !== 'string') {
    throw new Error('Manifest inválido: falta "generatedWith" (string)');
  }
  if (!Array.isArray(m['entries'])) {
    throw new Error('Manifest inválido: falta "entries" (array)');
  }

  const seen = new Set<string>();
  const entries: SoundEntry[] = m['entries'].map((e: unknown, i: number) => {
    if (typeof e !== 'object' || e === null) fail(i, 'no es un objeto');
    const r = e as Record<string, unknown>;
    if (typeof r['id'] !== 'string' || r['id'].length === 0) fail(i, 'falta "id"');
    if (seen.has(r['id'])) fail(i, `id duplicado "${r['id']}"`);
    seen.add(r['id']);
    if (typeof r['name'] !== 'string' || r['name'].length === 0) fail(i, 'falta "name"');
    if (!isCategory(r['category'])) fail(i, `categoría desconocida "${String(r['category'])}"`);
    if (typeof r['file'] !== 'string' || r['file'].length === 0) fail(i, 'falta "file"');
    if (!Array.isArray(r['tags']) || r['tags'].some((t) => typeof t !== 'string')) {
      fail(i, '"tags" debe ser string[]');
    }
    if (typeof r['durationSec'] !== 'number' || !(r['durationSec'] > 0)) {
      fail(i, '"durationSec" debe ser un número > 0');
    }
    if (r['subcategory'] !== undefined && typeof r['subcategory'] !== 'string') {
      fail(i, '"subcategory" debe ser string');
    }
    if (r['keyRoot'] !== undefined && typeof r['keyRoot'] !== 'string') {
      fail(i, '"keyRoot" debe ser string');
    }
    if (r['bpm'] !== undefined && (typeof r['bpm'] !== 'number' || !(r['bpm'] > 0))) {
      fail(i, '"bpm" debe ser un número > 0');
    }
    if (
      r['gainSuggestion'] !== undefined &&
      (typeof r['gainSuggestion'] !== 'number' || !(r['gainSuggestion'] > 0))
    ) {
      fail(i, '"gainSuggestion" debe ser un número > 0');
    }
    const entry: SoundEntry = {
      id: r['id'],
      name: r['name'],
      category: r['category'],
      file: r['file'],
      tags: r['tags'] as string[],
      durationSec: r['durationSec'],
    };
    if (r['subcategory'] !== undefined) entry.subcategory = r['subcategory'];
    if (r['keyRoot'] !== undefined) entry.keyRoot = r['keyRoot'];
    if (r['bpm'] !== undefined) entry.bpm = r['bpm'];
    if (r['gainSuggestion'] !== undefined) entry.gainSuggestion = r['gainSuggestion'];
    return entry;
  });

  return {
    version: m['version'],
    pack: m['pack'],
    generatedWith: m['generatedWith'],
    entries,
  };
}
