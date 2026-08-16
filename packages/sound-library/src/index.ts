// @orbit/sound-library — contenido de fábrica + manifest clasificado
export const LIBRARY_VERSION = '0.1.0';

export {
  SOUND_CATEGORIES,
  loadManifest,
  type SoundCategory,
  type SoundEntry,
  type SoundManifest,
} from './types';

import type { SoundCategory } from './types';

/** Etiquetas visibles (español) de las categorías del browser. */
export const CATEGORY_LABELS: Record<SoundCategory, string> = {
  drums: 'Drums',
  '808s': '808s',
  instrumentos: 'Instrumentos',
  'percusion-latina': 'Percusión latina',
  fx: 'FX',
  'melodic-loops': 'Loops melódicos',
};
