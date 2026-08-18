// @orbit/sound-library — contenido de fábrica + manifest clasificado
export const LIBRARY_VERSION = '0.1.0';

export {
  SOUND_CATEGORIES,
  loadManifest,
  type SoundCategory,
  type SoundEntry,
  type SoundManifest,
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
import type { SoundCategory, SoundEntry } from './types';

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
