/**
 * Cinco lienzos capturan el puntero pero no cerraban el gesto si la captura se
 * perdía (`pointercancel` / `lostpointercapture`): el arrastre se quedaba vivo,
 * el fantasma seguía al cursor sin botón y el `previewNote` del Piano Roll
 * seguía sonando porque solo se apagaba en `onPointerUp`.
 *
 * La regla vive en el JSX de cada canvas, así que se lee el fuente de verdad
 * (convención del repo, `read-source.ts`) y se comprueba que el tag del canvas
 * cierra el gesto con los dos manejadores. `capturePointer` documenta que la
 * captura puede fallar; cuando falla, `lostpointercapture` puede llegar sin
 * `pointerup` — por eso van los dos.
 */

import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

/** Tag JSX del canvas que abre con `marker`, hasta su `/>`. */
function canvasTag(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `no se encontró el canvas: ${marker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('/>', at);
  expect(end, `el tag de ${marker} nunca cierra`).toBeGreaterThan(at);
  return source.slice(at, end);
}

const CANVASES: { file: string; marker: string; what: string }[] = [
  {
    file: 'editors/pianoroll/PianoRoll.tsx',
    // Por trozos: el `${...}` es TEXTO buscado, no una plantilla del test.
    marker: ['className={`pr-canvas tool-', '$', '{tool}`}'].join(''),
    what: 'PianoRoll',
  },
  { file: 'editors/playlist/Playlist.tsx', marker: 'className="pl-canvas"', what: 'Playlist' },
  {
    file: 'editors/automation/AutomationEditor.tsx',
    marker: 'className="au-canvas"',
    what: 'AutomationEditor',
  },
  { file: 'editors/audio/AudioEditor.tsx', marker: 'className="ae-wave"', what: 'AudioEditor' },
  {
    file: 'editors/playlist/SectionLane.tsx',
    marker: 'className="pl-sections-canvas"',
    what: 'SectionLane',
  },
];

describe('los cinco canvases cierran el gesto al perder el puntero', () => {
  for (const { file, marker, what } of CANVASES) {
    it(`${what}: pointercancel y lostpointercapture llaman al cierre del gesto`, () => {
      const tag = canvasTag(readSource(file), marker);
      expect(tag).toContain('onPointerCancel={onPointerUp}');
      expect(tag).toContain('onLostPointerCapture={onPointerUp}');
    });
  }

  it('los cierres son idempotentes: repetir `onPointerUp` no re-despacha nada', () => {
    // Si no lo fueran, el `lostpointercapture` que sigue a un pointerup normal
    // duplicaría el commit del gesto. Los cuatro que despachan guardan `drag`
    // y salen si ya está cerrado; AutomationEditor limpia y sale igual.
    for (const { file } of CANVASES) {
      const src = readSource(file);
      const at = src.indexOf('const onPointerUp = useCallback(');
      expect(at, `no hay onPointerUp en ${file}`).toBeGreaterThanOrEqual(0);
      // Una ventana generosa: la guarda o el reset van al principio del cuerpo.
      const body = src.slice(at, at + 1500);
      expect(body).toMatch(/if \(!d\)|drag\.current = null/);
    }
  });
});
