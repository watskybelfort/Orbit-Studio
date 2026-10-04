import type { TimeSig } from './types';

/** El timeline y el tempo usan negras; el denominador define cada pulso escrito. */
export function meterBeatUnit(timeSig: TimeSig): number {
  return 4 / (Number.isFinite(timeSig.den) && timeSig.den > 0 ? timeSig.den : 4);
}

/** Longitud de un compás en beats del timeline: 6/8 son tres negras. */
export function beatsInBar(timeSig: TimeSig): number {
  const num = Number.isFinite(timeSig.num) && timeSig.num > 0 ? Math.round(timeSig.num) : 4;
  return num * meterBeatUnit(timeSig);
}
