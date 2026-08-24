// @orbit/sound-library — contenido de fábrica + manifest clasificado
export const LIBRARY_VERSION = '0.1.0';

export {
  SOUND_CATEGORIES,
  loadManifest,
  type SoundCategory,
  type SoundEntry,
  type SoundManifest,
  type SoundSample,
} from './types';

// Análisis automático (BPM y tonalidad) — funciones puras, ver analyze.ts.
export {
  analyzeSample,
  chromagram,
  detectBpm,
  detectKey,
  onsetEnvelope,
  toMono,
  KEY_MODE_LABELS,
  NOTE_NAMES,
  type AnalyzeOptions,
  type BpmEstimate,
  type KeyEstimate,
  type KeyMode,
  type NoteName,
  type OnsetEnvelope,
  type SampleAnalysis,
} from './analyze';

export { Fft, getFft, hannWindow } from './fft';

import type { SampleAnalysis } from './analyze';
import type { SoundCategory, SoundEntry, SoundSample } from './types';

/**
 * Las grabaciones de una entrada, siempre al menos una.
 *
 * Todo lo que carga sonidos pasa por aquí en vez de mirar `samples` a mano:
 * así una entrada de un solo archivo y un instrumento de tres siguen el mismo
 * camino, y el que no sepa de multisample sigue funcionando igual.
 */
export function entrySamples(entry: SoundEntry): SoundSample[] {
  if (entry.samples && entry.samples.length > 0) return entry.samples;
  return [{ file: entry.file, rootMidi: DEFAULT_ROOT_MIDI, durationSec: entry.durationSec }];
}

/**
 * La nota que se le supone a un sonido sin altura declarada. 60 es el do
 * central de la casa (C5 = 60) y es la referencia que el sampler ya usaba
 * cuando no había nada mejor: mantenerla es lo que hace que una entrada vieja
 * suene exactamente igual que antes.
 */
export const DEFAULT_ROOT_MIDI = 60;

/**
 * Id con el que se sube al kernel una grabación concreta de una entrada.
 *
 * La principal conserva el id de la entrada, y eso no es un detalle: los
 * proyectos guardados apuntan a ese id, y las audiciones y los clips de audio
 * lo usan tal cual. Solo las grabaciones ADICIONALES estrenan id, y para el
 * pack de fábrica es su ruta sin extensión — exactamente la convención de ids
 * que el manifest ya usaba.
 */
export function sampleIdFor(entry: SoundEntry, file: string): string {
  if (file === entry.file) return entry.id;
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  // Los packs generados y las carpetas del usuario llevan su esquema en el id;
  // colgar de él conserva el esquema y no puede chocar con el pack de fábrica.
  return entry.id.startsWith('user:') || entry.id.startsWith('pack:')
    ? `${entry.id}#${stem}`
    : stem;
}

/** Etiquetas visibles (español) de las categorías del browser. */
export const CATEGORY_LABELS: Record<SoundCategory, string> = {
  drums: 'Drums',
  '808s': '808s',
  instrumentos: 'Instrumentos',
  'percusion-latina': 'Percusión latina',
  fx: 'FX',
  'melodic-loops': 'Loops melódicos',
};

/**
 * Rellena SOLO los campos que la entrada no traiga del manifest: lo declarado
 * por el pack manda siempre sobre lo estimado. Devuelve la misma entrada si no
 * hay nada que añadir (así la UI puede comparar por identidad).
 */
export function withAnalysis(entry: SoundEntry, analysis: SampleAnalysis): SoundEntry {
  const bpm = entry.bpm === undefined ? analysis.bpm : undefined;
  const keyRoot = entry.keyRoot === undefined ? analysis.keyRoot : undefined;
  if (bpm === undefined && keyRoot === undefined) return entry;
  const next: SoundEntry = { ...entry };
  if (bpm !== undefined) next.bpm = bpm;
  if (keyRoot !== undefined) next.keyRoot = keyRoot;
  return next;
}

// Packs a medida (los que pide Claude): recetas puras, sin fs ni render.
export {
  MAX_PACK_SOUNDS,
  MAX_STRUCTURED_BEATS,
  PACK_FAMILIES,
  PACK_STYLES,
  isPackFamily,
  isPackStyle,
  planPack,
  slugifyName,
  type PackFamily,
  type PackPlan,
  type PackRequest,
  type PackSoundSpec,
  type PackStyle,
} from './pack-recipes';

// La FORMA de un beat (intro, build, drop, vuelta, outro). Se exporta porque
// la playlist dibuja esas mismas secciones: el generador y el editor tienen que
// hablar del mismo catálogo o acabarían con dos ideas distintas de qué es un
// drop.
export {
  SECTION_KINDS,
  SHAPE_COUNT,
  densityOf,
  isLastBarOfSection,
  planSections,
  sectionAt,
  totalBars,
  type Section,
  type SectionDensity,
  type SectionKind,
} from './pack-structure';
