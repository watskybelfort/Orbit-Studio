/** Fader vertical del mixer: dB reales, doble clic = 0 dB. */

import { useCallback, useRef } from 'react';
import { gainToDb } from '@orbit/core';
import { capturePointer } from './pointer';
import './widgets.css';

export interface FaderProps {
  /** Ganancia lineal 0..2. */
  value: number;
  height?: number;
  onChange: (gain: number) => void;
  onCommit?: () => void;
}

/** Mapeo fader: posición 0..1 → ganancia con más recorrido útil arriba. */
function posToGain(pos: number): number {
  return Math.pow(pos, 1.8) * 2;
}

function gainToPos(gain: number): number {
  return Math.pow(Math.min(2, Math.max(0, gain)) / 2, 1 / 1.8);
}

export function Fader({ value, height = 160, onChange, onCommit }: FaderProps) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const setFromClientY = useCallback(
    (clientY: number) => {
      const el = track.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pos = 1 - (clientY - rect.top) / rect.height;
      onChange(posToGain(Math.min(1, Math.max(0, pos))));
    },
    [onChange],
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
        capturePointer(e.target as HTMLElement, e.pointerId);
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
      onDoubleClick={() => {
        onChange(1);
        onCommit?.();
      }}
    >
      <div className="fader-track" />
      <div className="fader-thumb" style={{ bottom: `calc(${pos * 100}% - 7px)` }} />
    </div>
  );
}
