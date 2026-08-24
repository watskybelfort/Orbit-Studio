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

/**
 * Una grabación concreta de un instrumento multisample.
 *
 * Un instrumento de verdad no es una muestra estirada por todo el teclado:
 * estirar cambia la velocidad de lectura, y con ella se mueven las formantes y
 * el ataque. Un piano grabado en do suena a ratón dos octavas arriba. Por eso
 * cada instrumento del pack trae varias grabaciones, cada una con la nota a la
 * que suena SIN transponer, y el keymap las reparte.
 */
export interface SoundSample {
  /** Ruta del WAV relativa a la raíz del pack. */
  file: string;
  /**
   * Nota MIDI a la que esta grabación suena sin transponer.
   *
   * Número, no nombre: `keyRoot` de la entrada dice "C" y eso no basta para
   * colocar nada — un bajo grabado en do y una campana grabada en do están a
   * tres octavas la una de la otra, y el sampler necesita saber cuál es cuál.
   * La convención es la de la casa: C5 = 60, la que enseña el piano roll.
   */
  rootMidi: number;
  /** Duración real del archivo en segundos. */
  durationSec: number;
}

export interface SoundEntry {
  /** Id estable y único dentro del pack, ej. "drums/trap/kick-01". */
  id: string;
  /** Nombre visible en el browser. */
  name: string;
  category: SoundCategory;
  /** Subgrupo dentro de la categoría (ej. "trap", "boombap"). */
  subcategory?: string;
  /**
   * Ruta del WAV relativa a la raíz del pack.
   *
   * En un instrumento multisample es la grabación PRINCIPAL: la que suena al
   * escucharlo en el browser y la que se coloca si lo sueltas en la playlist.
   * Las demás van en `samples`.
   */
  file: string;
  /**
   * Las grabaciones de un instrumento multisample, con su nota. Incluye la de
   * `file`. Si no está —o trae una sola—, la entrada es lo de siempre: un
   * sonido, un archivo.
   */
  samples?: SoundSample[];
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
  // Un array también es `typeof 'object'`: sin descartarlo, un manifest que
  // fuera solo la lista de entradas fallaba más adelante con "falta version",
  // que manda a mirar donde no es.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
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
    // Un `samples` mal formado NO se ignora en silencio: media entrada válida
    // deja un instrumento con agujeros en el teclado y eso solo se descubre
    // tocándolo. Mejor que el manifest no cargue y se sepa por qué.
    let samples: SoundSample[] | undefined;
    if (r['samples'] !== undefined) {
      if (!Array.isArray(r['samples']) || r['samples'].length === 0) {
        fail(i, '"samples" debe ser un array no vacío');
      }
      samples = (r['samples'] as unknown[]).map((s, j) => {
        if (typeof s !== 'object' || s === null) fail(i, `"samples[${j}]" no es un objeto`);
        const q = s as Record<string, unknown>;
        if (typeof q['file'] !== 'string' || q['file'].length === 0) {
          fail(i, `"samples[${j}].file" falta`);
        }
        if (
          typeof q['rootMidi'] !== 'number' ||
          !Number.isFinite(q['rootMidi']) ||
          q['rootMidi'] < 0 ||
          q['rootMidi'] > 127
        ) {
          fail(i, `"samples[${j}].rootMidi" debe ser una nota MIDI (0..127)`);
        }
        if (typeof q['durationSec'] !== 'number' || !(q['durationSec'] > 0)) {
          fail(i, `"samples[${j}].durationSec" debe ser un número > 0`);
        }
        return { file: q['file'], rootMidi: q['rootMidi'], durationSec: q['durationSec'] };
      });
    }
    const entry: SoundEntry = {
      id: r['id'],
      name: r['name'],
      category: r['category'],
      file: r['file'],
      tags: r['tags'] as string[],
      durationSec: r['durationSec'],
    };
    if (samples !== undefined) entry.samples = samples;
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
