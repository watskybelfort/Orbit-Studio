/**
 * Menú contextual de una perilla/fader con destino automatizable.
 *
 * Es el atajo de FL llevado a Orbit: en vez de ir a la ventana de
 * automatización y buscar el parámetro en tres desplegables, clic derecho
 * sobre el mando y ya tienes su clip o su LFO, enlazados al destino correcto.
 *
 * Va por MenuPortal: una perilla puede estar dentro de una ventana interna con
 * blur (acrílico) o dentro de las cabeceras de la playlist, y ahí un
 * `position: fixed` se coloca contra la caja del ancestro y se recorta. El
 * portal lo pinta en el <body> del documento del ancla, así que sale entero y
 * también en un editor desacoplado.
 */

import type { ParamRef } from '@orbit/core';
import {
  cancelMidiLearn,
  isLearning,
  midiMappingFor,

  midiSourceLabel,
  removeMidiMapping,
  startMidiLearn,
  useMidiLearnStore,
} from '../state/midi-learn';
import { addLfoFor, createAutomationClipFor, findLfoFor, removeLfo } from '../state/param-actions';
import { useProject } from '../state/useProject';
import { useUiStore } from '../state/ui';
import { MenuPortal } from './MenuPortal';
import './widgets.css';


export interface ParamMenuProps {
  target: ParamRef;
  x: number;
  y: number;
  /** El mando que abrió el menú: dice en qué ventana hay que pintarlo. */
  anchor?: Element | null;
  onClose: () => void;
}

export function ParamMenu({ target, x, y, anchor, onClose }: ParamMenuProps) {
  const project = useProject();
  const lfo = findLfoFor(target, project);
  const mappings = useMidiLearnStore((s) => s.mappings);
  const learning = useMidiLearnStore((s) => s.learning);
  const mapping = midiMappingFor(target, mappings);
  const waiting = isLearning(target, learning);


  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };


  return (
    <MenuPortal anchor={anchor} x={x} y={y} onClose={onClose} className="param-menu">
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
      <div className="param-menu-sep" />
      {mapping ? (
        <button className="param-menu-item" onClick={run(() => removeMidiMapping(mapping.source))}>
          Soltar {midiSourceLabel(mapping.source)}
        </button>
      ) : waiting ? (
        <button className="param-menu-item learning" onClick={run(cancelMidiLearn)}>
          Mueve un mando… (clic para cancelar)
        </button>
      ) : (
        <button className="param-menu-item" onClick={run(() => startMidiLearn(target))}>
          Aprender MIDI
        </button>
      )}
    </MenuPortal>

  );
}
