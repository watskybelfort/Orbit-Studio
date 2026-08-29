/**
 * Plugin local de ESLint: las reglas duras de CLAUDE.md que ningún linter de
 * catálogo conoce. Sin dependencias — son tres archivos de este repo.
 *
 * Están aquí y no en un paquete publicado a propósito: son reglas sobre ESTE
 * árbol (sus paquetes, su worklet, su carpeta de temas) y se leen mejor al lado
 * del código que vigilan.
 */

import packageBoundaries from './package-boundaries.js';
import noAudioThreadAlloc from './no-audio-thread-alloc.js';
import noHardcodedColors from './no-hardcoded-colors.js';

export default {
  meta: { name: 'orbit' },
  rules: {
    'package-boundaries': packageBoundaries,
    'no-audio-thread-alloc': noAudioThreadAlloc,
    'no-hardcoded-colors': noHardcodedColors,
  },
};
