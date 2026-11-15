import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

/**
 * Las correcciones de la auditoría que viven dentro del JSX/efectos de un
 * componente se afirman sobre su fuente (convención del repo, ver
 * `read-source.ts`): montar el canvas o el worker real pediría DOM y arrastraría
 * una clase de test que aquí no existe.
 */
describe('auditoría de noviembre: las puertas que se cerraron en la UI', () => {
  it('Playlist y PianoRoll solo borran cuando su editor es el activo', () => {
    const playlist = readSource('editors/playlist/Playlist.tsx');
    const piano = readSource('editors/pianoroll/PianoRoll.tsx');
    expect(playlist).toContain("if (activeEditTarget() !== 'playlist') return;");
    expect(piano).toContain("if (activeEditTarget() !== 'pianoRoll') return;");
  });

  it('el editor de audio solo recorta desde el asa y con el botón izquierdo', () => {
    const audio = readSource('editors/audio/AudioEditor.tsx');
    expect(audio).toContain('if (e.button !== 0) return;');
    expect(audio).toContain('TRIM_EDGE_PX');
    expect(audio).toContain('if (!nearStart && !nearEnd) return;');
  });

  it('mover una sección deja UN undo, no uno por pointermove', () => {
    const sections = readSource('editors/playlist/SectionLane.tsx');
    expect(sections).toContain(['sec:move:', '$', '{d.sectionId}'].join(''));
    expect(sections).toContain(['sec:resize:', '$', '{d.sectionId}'].join(''));
  });

  it('el fader no se mueve con el clic derecho que abre su menú', () => {
    expect(readSource('widgets/Fader.tsx')).toContain('if (e.button !== 0) return;');
  });

  it('el zoom del Piano Roll ancla el beat bajo el cursor', () => {
    expect(readSource('editors/pianoroll/PianoRoll.tsx')).toContain(
      'const beat = px / zoomX + scrollX;',
    );
  });

  it('el worker de la vista no deja el manejador real en self.onmessage', () => {
    const worker = readSource('plugins/plugin-view-worker.ts');
    expect(worker).toContain('scope.onmessage = null;');
    expect(worker).toContain("scope.addEventListener('message'");
    expect(worker).toContain('input.length !== IN_LEN');
    expect(worker).toContain('out.length !== VIEW_LIST_CAP');
  });

  it('el worker de export desarma la red antes de compilar plugins', () => {
    const worker = readSource('export/render-worker.ts');
    expect(worker).toContain("'fetch'");
    expect(worker).toContain("'WebSocket'");
    expect(worker).toContain('ctx.onmessage = null;');
    expect(worker).toContain("ctx.addEventListener('message'");
  });

  it('la paleta es un diálogo modal y atrapa el tabulador', () => {
    const palette = readSource('palette/CommandPalette.tsx');
    expect(palette).toContain('role="dialog"');
    expect(palette).toContain('aria-modal="true"');
    expect(palette).toContain("if (e.key === 'Tab')");
  });
});
