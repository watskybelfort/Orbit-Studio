/**
 * Automatización de transporte: solo `tempo`.
 *
 * `swing` seguía en la lista, pero el motor lo aplica al COMPILAR
 * (`swungStart` mueve las notas al aplanarlas, ver `compile.ts`) y no hay
 * ningún caso de automatización que lo lea en el kernel: los eventos
 * `transport:swing` se aplican a un valor que no vuelve a tocar nada, o sea
 * una curva silenciosamente muerta. Se quita de la lista en vez de dejar que el
 * usuario gaste un clip de automatización que no hace nada.
 *
 * (El otro camino —MIDI learn— sí funciona y no se toca: `core/model/paramref.ts`
 * mapea swing y viaja como comando `setSwing`.)
 */

import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

describe('TRANSPORT_PARAMS del AutomationEditor', () => {
  it('ofrece solo tempo y documenta por qué swing ya no está', () => {
    const src = readSource('editors/automation/AutomationEditor.tsx');
    expect(src).toContain("const TRANSPORT_PARAMS = ['tempo'] as const;");
    expect(src).toContain('swing');
    // Solo en el comentario que explica el porqué, nunca como valor ofrecido.
    expect(src).not.toContain("'swing'");
  });
});
