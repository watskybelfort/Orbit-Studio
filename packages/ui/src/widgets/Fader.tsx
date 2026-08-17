/**
 * Fader vertical del mixer: dB reales, doble clic = 0 dB.
 * Con `paramRef` avisa del movimiento y abre el menú de automatización/LFO,
 * igual que la perilla.
 */

import { useCallback, useRef, useState } from 'react';
import { gainToDb, type ParamRef } from '@orbit/core';
import { touchParam } from '../state/param-touch';
import { capturePointer } from './pointer';
import { ParamMenu } from './ParamMenu';
import './widgets.css';

export interface FaderProps {
  /** Ganancia lineal 0..2. */
  value: number;
  height?: number;
  onChange: (gain: number) => void;
  onCommit?: () => void;
  /** Destino automatizable que mueve este fader. */
  paramRef?: ParamRef;
}

/** Mapeo fader: posición 0..1 → ganancia con más recorrido útil arriba. */
function posToGain(pos: number): number {
  return Math.pow(pos, 1.8) * 2;
}

function gainToPos(gain: number): number {
  return Math.pow(Math.min(2, Math.max(0, gain)) / 2, 1 / 1.8);
}

export function Fader({ value, height = 160, onChange, onCommit, paramRef }: FaderProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // El ancla del menú es el propio fader: dice en qué ventana pintarlo.
  const [menu, setMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);

  const emit = useCallback(
    (gain: number) => {
      onChange(gain);
      if (paramRef) touchParam(paramRef);
    },
    [onChange, paramRef],
  );

  const setFromClientY = useCallback(
    (clientY: number) => {
      const el = track.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pos = 1 - (clientY - rect.top) / rect.height;
      emit(posToGain(Math.min(1, Math.max(0, pos))));
    },
    [emit],
  );

  const pos = gainToPos(value);
  const db = gainToDb(value);

  return (
    <div
      className="fader"
      style={{ height }}
      ref={track}
      title={`${db <= -96 ? '-∞' : db.toFixed(1)} dB`}
      onPointerDown={(e) => {
        // currentTarget (el carril entero), no e.target: el pulgar y la pista
        // son hijos que React redibuja al mover, y capturar sobre ellos deja
        // el gesto colgado en cuanto se reemplaza el nodo.
        capturePointer(e.currentTarget, e.pointerId);
        dragging.current = true;
        setFromClientY(e.clientY);
      }}
      onPointerMove={(e) => {
        if (dragging.current) setFromClientY(e.clientY);
      }}
      onPointerUp={() => {
        dragging.current = false;
        onCommit?.();
      }}
      // Gesto cancelado o captura perdida: soltar igual, o el fader se quedaba
      // "pegado" al puntero y se movía con el simple hover.
      onPointerCancel={() => {
        if (!dragging.current) return;
        dragging.current = false;
        onCommit?.();
      }}
      onLostPointerCapture={() => {
        if (!dragging.current) return;
        dragging.current = false;
        onCommit?.();
      }}
      onDoubleClick={() => {
        emit(1);
        onCommit?.();
      }}
      onContextMenu={(e) => {
        if (!paramRef) return;
        e.preventDefault();
        e.stopPropagation();
        // MenuPortal se encarga de medirlo y meterlo dentro de SU ventana.
        setMenu({ x: e.clientX, y: e.clientY, anchor: e.currentTarget });
      }}
    >
      <div className="fader-track" />
      <div className="fader-thumb" style={{ bottom: `calc(${pos * 100}% - 7px)` }} />
      {menu && paramRef && (
        <ParamMenu
          target={paramRef}
          x={menu.x}
          y={menu.y}
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
