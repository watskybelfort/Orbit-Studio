/**
 * Un parámetro del canal, pintado según su spec: perilla para lo continuo y
 * lista para lo discreto.
 *
 * Un parámetro con `options` NO es una rampa: pintar "Normal / Invertida" como
 * perilla obliga a adivinar dónde acaba una y empieza la otra. Lo comparten la
 * pestaña de sonido y la de efectos, que es justo por lo que vive aparte.
 */

import type { ParamRef, ParamSpec } from '@orbit/core';
import { Knob } from '../../widgets/Knob';
import { formatParam } from './format';

export interface ParamControlProps {
  spec: ParamSpec;
  value: number;
  onChange: (v: number) => void;
  /** Destino automatizable; los parámetros sin spec en el registro van sin él. */
  paramRef?: ParamRef;
}

export function ParamControl({ spec, value, onChange, paramRef }: ParamControlProps) {
  if (spec.options) {
    const index = Math.min(spec.options.length - 1, Math.max(0, Math.round(value)));
    return (
      <label className="chan-opt">
        <select
          className="chan-select"
          value={index}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {spec.options.map((opt, i) => (
            <option key={opt} value={i}>
              {opt}
            </option>
          ))}
        </select>
        <span className="knob-label">{spec.label}</span>
      </label>
    );
  }
  return (
    <Knob
      value={value}
      min={spec.min}
      max={spec.max}
      defaultValue={spec.default}
      curve={spec.curve}
      label={spec.label}
      size={34}
      format={(v) => formatParam(spec, v)}
      onChange={onChange}
      paramRef={paramRef}
    />
  );
}
