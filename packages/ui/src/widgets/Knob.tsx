/**
 * Perilla estándar de Orbit Studio.
 * Arrastre vertical (Shift = fino), doble clic = valor por defecto,
 * rueda = pasos. Soporta curva exponencial para frecuencias/tiempos.
 */

import { useCallback, useRef } from 'react';
import { capturePointer } from './pointer';
import './widgets.css';

export interface KnobProps {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  curve?: 'lin' | 'exp';
  label?: string;
  unit?: string;
  size?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Se llama al soltar (para cerrar el mergeKey del undo). */
  onCommit?: () => void;
}

function toNorm(v: number, min: number, max: number, curve: 'lin' | 'exp'): number {
  if (curve === 'exp' && min > 0) return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}

function fromNorm(t: number, min: number, max: number, curve: 'lin' | 'exp'): number {
  const c = Math.min(1, Math.max(0, t));
  if (curve === 'exp' && min > 0) return min * Math.pow(max / min, c);
  return min + (max - min) * c;
}

export function Knob({
  value,
  min,
  max,
  defaultValue,
  curve = 'lin',
  label,
  unit,
  size = 36,
  format,
  onChange,
  onCommit,
}: KnobProps) {
  const drag = useRef<{ startY: number; startNorm: number } | null>(null);

  const norm = toNorm(Math.min(max, Math.max(min, value)), min, max, curve);
  // Arco de 270° empezando abajo-izquierda.
  const angle = -135 + norm * 270;

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      capturePointer(e.target as HTMLElement, e.pointerId);
      drag.current = { startY: e.clientY, startNorm: norm };
    },
    [norm],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const range = e.shiftKey ? 1200 : 200;
      const delta = (drag.current.startY - e.clientY) / range;
      onChange(fromNorm(drag.current.startNorm + delta, min, max, curve));
    },
    [onChange, min, max, curve],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
    onCommit?.();
  }, [onCommit]);

  const onDoubleClick = useCallback(() => {
    if (defaultValue !== undefined) {
      onChange(defaultValue);
      onCommit?.();
    }
  }, [defaultValue, onChange, onCommit]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const step = e.shiftKey ? 0.005 : 0.03;
      onChange(fromNorm(norm + (e.deltaY < 0 ? step : -step), min, max, curve));
      onCommit?.();
    },
    [norm, onChange, onCommit, min, max, curve],
  );

  const shown = format ? format(value) : `${round3(value)}${unit ? ` ${unit}` : ''}`;
  const r = size / 2 - 3;

  return (
    <div className="knob" style={{ width: size + 8 }} title={`${label ?? ''} ${shown}`.trim()}>
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        className="knob-svg"
      >
        <circle cx={size / 2} cy={size / 2} r={r} className="knob-body" />
        <path d={arcPath(size / 2, size / 2, r + 2, -135, angle)} className="knob-arc" />
        <line
          x1={size / 2}
          y1={size / 2}
          x2={size / 2 + (r - 4) * Math.cos(((angle - 90) * Math.PI) / 180)}
          y2={size / 2 + (r - 4) * Math.sin(((angle - 90) * Math.PI) / 180)}
          className="knob-pointer"
        />
      </svg>
      {label && <span className="knob-label">{label}</span>}
    </div>
  );
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  const a0 = ((fromDeg - 90) * Math.PI) / 180;
  const a1 = ((toDeg - 90) * Math.PI) / 180;
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  return `M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}`;
}
