/** Número arrastrable (BPM, longitudes): drag vertical, doble clic = teclear. */

import { useCallback, useRef, useState } from 'react';
import { capturePointer } from './pointer';
import './widgets.css';

export interface NumberScrubberProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  /** Paso del arrastre (por defecto = step); el valor tecleado sigue usando step. */
  dragStep?: number;
  suffix?: string;
  onChange: (v: number) => void;
  onCommit?: () => void;
}

export function NumberScrubber({
  value,
  min,
  max,
  step = 1,
  decimals = 0,
  dragStep = step,
  suffix,
  onChange,
  onCommit,
}: NumberScrubberProps) {
  const drag = useRef<{ startY: number; startValue: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  const clamp = useCallback(
    // parseFloat(toFixed) limpia el ruido de coma flotante con steps decimales (0.1).
    (v: number) =>
      Math.min(max, Math.max(min, parseFloat((Math.round(v / step) * step).toFixed(6)))),
    [min, max, step],
  );

  if (editing) {
    return (
      <input
        className="scrubber-input"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parsed = parseFloat(text.replace(',', '.'));
          if (!Number.isNaN(parsed)) {
            onChange(clamp(parsed));
            onCommit?.();
          }
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
          e.stopPropagation();
        }}
      />
    );
  }

  return (
    <span
      className="scrubber"
      onPointerDown={(e) => {
        capturePointer(e.target as HTMLElement, e.pointerId);
        drag.current = { startY: e.clientY, startValue: value };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const perPixel = e.shiftKey ? dragStep / 10 : dragStep;
        onChange(clamp(drag.current.startValue + (drag.current.startY - e.clientY) * perPixel));
      }}
      onPointerUp={() => {
        drag.current = null;
        onCommit?.();
      }}
      onDoubleClick={() => {
        setText(String(value));
        setEditing(true);
      }}
    >
      {value.toFixed(decimals)}
      {suffix && <span className="scrubber-suffix">{suffix}</span>}
    </span>
  );
}
