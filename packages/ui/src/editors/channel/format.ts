/**
 * Formato de valores del editor de sonido.
 *
 * Vive aparte porque las tres pestañas pintan las mismas unidades: si cada
 * una improvisa la suya, el mismo parámetro acaba leyéndose distinto según
 * dónde lo mires, que es la manera más rápida de perder la confianza en lo
 * que dice la pantalla.
 */

import { gainToDb, type ParamSpec } from '@orbit/core';

/** Valor de un parámetro en sus unidades reales (o la etiqueta del selector). */
export function formatParam(spec: ParamSpec, v: number): string {
  if (spec.options) {
    const i = Math.min(spec.options.length - 1, Math.max(0, Math.round(v)));
    return spec.options[i] ?? '';
  }
  if (spec.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`;
  if (spec.unit === 's') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  if (spec.unit === 'dB') return `${v.toFixed(1)} dB`;
  if (spec.unit === 'st') return `${v.toFixed(1)} st`;
  if (spec.unit === 'ct') return `${Math.round(v)} ct`;
  const r = Math.round(v * 100) / 100;
  return spec.unit ? `${r} ${spec.unit}` : `${r}`;
}

/** Pan del canal: C / 40L / 65R. */
export function formatPan(v: number): string {
  if (Math.abs(v) < 0.005) return 'C';
  return v < 0 ? `${Math.round(-v * 100)}L` : `${Math.round(v * 100)}R`;
}

/** Ganancia lineal → dB, que es como se piensa el volumen al mezclar. */
export function formatGain(v: number): string {
  return `${gainToDb(v).toFixed(1)} dB`;
}

/** Nombre de la pista de mixer a la que sale un canal. */
export function mixerTrackLabel(index: number, names: string[]): string {
  if (index === 0) return 'Master';
  return `${index} — ${names[index] ?? `Insert ${index}`}`;
}
