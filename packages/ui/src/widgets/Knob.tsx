/**
 * Perilla estándar de Orbit Studio.
 * Arrastre vertical (Shift = fino), doble clic = valor por defecto,
 * rueda = pasos. Soporta curva exponencial para frecuencias/tiempos.
 *
 * Con `paramRef` la perilla queda enlazada a un destino automatizable: avisa
 * al registro de "último parámetro tocado" en cada movimiento y ofrece su
 * menú contextual (crear clip de automatización, poner LFO).
 */

import { useCallback, useRef, useState } from 'react';
import type { ParamRef } from '@orbit/core';
import { touchParam } from '../state/param-touch';
import { capturePointer } from './pointer';
import { ParamMenu, clampMenuPosition } from './ParamMenu';
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
  /** Destino automatizable que mueve esta perilla (habilita el menú y el registro). */
  paramRef?: ParamRef;
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
  paramRef,
}: KnobProps) {
  const drag = useRef<{ startY: number; startNorm: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const norm = toNorm(Math.min(max, Math.max(min, value)), min, max, curve);
  // Arco de 270° empezando abajo-izquierda.
  const angle = -135 + norm * 270;

  /** El aviso va DESPUÉS del dispatch: el proyecto ya tiene el valor nuevo. */
  const emit = useCallback(
    (v: number) => {
      onChange(v);
      if (paramRef) touchParam(paramRef);
    },
    [onChange, paramRef],
  );

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
      emit(fromNorm(drag.current.startNorm + delta, min, max, curve));
    },
    [emit, min, max, curve],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
    onCommit?.();
  }, [onCommit]);

  const onDoubleClick = useCallback(() => {
    if (defaultValue !== undefined) {
      emit(defaultValue);
      onCommit?.();
    }
  }, [defaultValue, emit, onCommit]);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const step = e.shiftKey ? 0.005 : 0.03;
      emit(fromNorm(norm + (e.deltaY < 0 ? step : -step), min, max, curve));
      onCommit?.();
    },
    [norm, emit, onCommit, min, max, curve],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!paramRef) return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(clampMenuPosition(e.clientX, e.clientY, e.currentTarget.ownerDocument.defaultView));
    },
    [paramRef],
  );

  const shown = format ? format(value) : `${round3(value)}${unit ? ` ${unit}` : ''}`;
  const r = size / 2 - 3;

  const hint = paramRef ? ' · clic derecho: automatización / LFO' : '';

  return (
    <div
      className="knob"
      style={{ width: size + 8 }}
      title={`${`${label ?? ''} ${shown}`.trim()}${hint}`}
    >
      <svg
        width={size}
        height={size}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onContextMenu={onContextMenu}
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
      {menu && paramRef && (
        <ParamMenu target={paramRef} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
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
