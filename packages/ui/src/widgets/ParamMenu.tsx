/**
 * Menú contextual de una perilla/fader con destino automatizable.
 *
 * Es el atajo de FL llevado a Orbit: en vez de ir a la ventana de
 * automatización y buscar el parámetro en tres desplegables, clic derecho
 * sobre el mando y ya tienes su clip o su LFO, enlazados al destino correcto.
 *
 * Se pinta con position: fixed dentro de SU documento, así que funciona igual
 * en la ventana principal y en un editor desacoplado.
 */

import { useEffect } from 'react';
import type { ParamRef } from '@orbit/core';
import { addLfoFor, createAutomationClipFor, findLfoFor, removeLfo } from '../state/param-actions';
import { useProject } from '../state/useProject';
import { useUiStore } from '../state/ui';
import './widgets.css';

export interface ParamMenuProps {
  target: ParamRef;
  x: number;
  y: number;
  onClose: () => void;
}

export function ParamMenu({ target, x, y, onClose }: ParamMenuProps) {
  const project = useProject();
  const lfo = findLfoFor(target, project);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      className="popup param-menu"
      style={{ left: x, top: y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="param-menu-item" onClick={run(() => createAutomationClipFor(target))}>
        Crear clip de automatización
      </button>
      {lfo ? (
        <>
          <button className="param-menu-item" onClick={run(() => removeLfo(lfo.id))}>
            Quitar LFO
          </button>
          <button
            className="param-menu-item"
            onClick={run(() => useUiStore.getState().openWindow('lfo'))}
          >
            Ajustar LFO…
          </button>
        </>
      ) : (
        <button className="param-menu-item" onClick={run(() => addLfoFor(target))}>
          Añadir LFO
        </button>
      )}
    </div>
  );
}

/**
 * Coloca el menú dentro de su ventana (no de la principal: en un editor
 * desacoplado el ancho útil es el de ESA ventana).
 */
export function clampMenuPosition(
  x: number,
  y: number,
  view: Window | null | undefined,
  w = 210,
  h = 96,
): { x: number; y: number } {
  const v = view ?? window;
  return {
    x: Math.max(4, Math.min(x, v.innerWidth - w)),
    y: Math.max(4, Math.min(y, v.innerHeight - h)),
  };
}
