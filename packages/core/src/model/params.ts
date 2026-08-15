/**
 * Registro central de parámetros de instrumentos y efectos.
 * UI (perillas), motor (DSP), automatización y MCP leen de aquí:
 * un parámetro se define una sola vez.
 */

import type { EffectKind, InstrumentKind } from './types';

export interface ParamSpec {
  /** Clave en `params`. */
  key: string;
  /** Nombre visible. */
  label: string;
  min: number;
  max: number;
  default: number;
  /** Curva de la perilla: lin | exp (frecuencias/tiempos). */
  curve?: 'lin' | 'exp';
  unit?: string;
  /** Valores discretos con etiqueta (selector en vez de perilla). */
  options?: string[];
}

const p = (
  key: string,
  label: string,
  min: number,
  max: number,
  def: number,
  extra: Partial<ParamSpec> = {},
): ParamSpec => ({ key, label, min, max, default: def, ...extra });

// ── Instrumentos ─────────────────────────────────────────────────────────────

export const INSTRUMENT_PARAMS: Record<InstrumentKind, ParamSpec[]> = {
  sub808: [
    p('tune', 'Tune', -12, 12, 0, { unit: 'st' }),
    p('decay', 'Decay', 0.1, 4, 1.2, { unit: 's', curve: 'exp' }),
    p('drive', 'Drive', 0, 1, 0.45),
    p('glide', 'Glide', 0, 0.5, 0.06, { unit: 's' }),
    p('punch', 'Punch', 0, 1, 0.5),
    p('tone', 'Tone', 200, 4000, 900, { unit: 'Hz', curve: 'exp' }),
  ],
  synth: [
    p('wave', 'Wave', 0, 3, 0, { options: ['Saw', 'Square', 'Triangle', 'Sine'] }),
    p('cutoff', 'Cutoff', 40, 18000, 4000, { unit: 'Hz', curve: 'exp' }),
    p('resonance', 'Reso', 0, 1, 0.2),
    p('envAmount', 'Env→Filt', 0, 1, 0.4),
    p('attack', 'Attack', 0.001, 2, 0.005, { unit: 's', curve: 'exp' }),
    p('decay', 'Decay', 0.01, 3, 0.3, { unit: 's', curve: 'exp' }),
    p('sustain', 'Sustain', 0, 1, 0.7),
    p('release', 'Release', 0.01, 4, 0.25, { unit: 's', curve: 'exp' }),
    p('unison', 'Unison', 1, 5, 1),
    p('detune', 'Detune', 0, 0.5, 0.1),
    p('octave', 'Octave', -2, 2, 0),
  ],
  supersaw: [
    p('detune', 'Detune', 0, 1, 0.4),
    p('blend', 'Blend', 0, 1, 0.7),
    p('cutoff', 'Cutoff', 200, 18000, 8000, { unit: 'Hz', curve: 'exp' }),
    p('attack', 'Attack', 0.001, 2, 0.01, { unit: 's', curve: 'exp' }),
    p('release', 'Release', 0.01, 4, 0.4, { unit: 's', curve: 'exp' }),
    p('width', 'Width', 0, 1, 0.8),
    p('octave', 'Octave', -2, 2, 0),
  ],
  fm: [
    p('ratio', 'Ratio', 0.5, 12, 2),
    p('index', 'FM Index', 0, 10, 3),
    p('indexDecay', 'Idx Decay', 0.01, 3, 0.4, { unit: 's', curve: 'exp' }),
    p('attack', 'Attack', 0.001, 2, 0.002, { unit: 's', curve: 'exp' }),
    p('decay', 'Decay', 0.01, 4, 1.2, { unit: 's', curve: 'exp' }),
    p('sustain', 'Sustain', 0, 1, 0.0),
    p('release', 'Release', 0.01, 4, 0.4, { unit: 's', curve: 'exp' }),
    p('octave', 'Octave', -2, 2, 0),
  ],
  drums: [
    p('kit', 'Kit', 0, 2, 0, { options: ['Trap', 'Boom Bap', 'Latin'] }),
    p('tone', 'Tone', 0, 1, 0.5),
    p('decay', 'Decay', 0.2, 2, 1),
    p('punch', 'Punch', 0, 1, 0.5),
  ],
  sampler: [
    p('pitch', 'Pitch', -24, 24, 0, { unit: 'st' }),
    p('attack', 'Attack', 0.001, 2, 0.001, { unit: 's', curve: 'exp' }),
    p('release', 'Release', 0.005, 4, 0.05, { unit: 's', curve: 'exp' }),
    p('start', 'Start', 0, 1, 0),
    p('reverse', 'Reverse', 0, 1, 0, { options: ['Off', 'On'] }),
    p('keytrack', 'Keytrack', 0, 1, 1, { options: ['Off', 'On'] }),
  ],
};

/**
 * Mapa de piezas del kit de drums (canal kind='drums'):
 * la altura MIDI elige la pieza, estilo drum map.
 */
export const DRUM_MAP: Record<number, string> = {
  36: 'kick', // C3
  37: 'rim',
  38: 'snare',
  39: 'clap',
  42: 'hat',
  46: 'openhat',
  45: 'tom',
  48: 'conga',
  49: 'crash',
  70: 'shaker',
};

// ── Efectos ──────────────────────────────────────────────────────────────────

export const EFFECT_PARAMS: Record<EffectKind, ParamSpec[]> = {
  eq: [
    p('hpFreq', 'HP', 20, 1000, 20, { unit: 'Hz', curve: 'exp' }),
    p('lowGain', 'Low', -18, 18, 0, { unit: 'dB' }),
    p('lowFreq', 'LowF', 40, 600, 120, { unit: 'Hz', curve: 'exp' }),
    p('midGain', 'Mid', -18, 18, 0, { unit: 'dB' }),
    p('midFreq', 'MidF', 200, 8000, 1000, { unit: 'Hz', curve: 'exp' }),
    p('midQ', 'Q', 0.3, 8, 1),
    p('highGain', 'High', -18, 18, 0, { unit: 'dB' }),
    p('highFreq', 'HighF', 1500, 16000, 6000, { unit: 'Hz', curve: 'exp' }),
    p('lpFreq', 'LP', 1000, 20000, 20000, { unit: 'Hz', curve: 'exp' }),
  ],
  compressor: [
    p('threshold', 'Thresh', -60, 0, -18, { unit: 'dB' }),
    p('ratio', 'Ratio', 1, 20, 4),
    p('attack', 'Attack', 0.0005, 0.2, 0.01, { unit: 's', curve: 'exp' }),
    p('release', 'Release', 0.02, 1, 0.15, { unit: 's', curve: 'exp' }),
    p('knee', 'Knee', 0, 24, 6, { unit: 'dB' }),
    p('makeup', 'Makeup', 0, 24, 0, { unit: 'dB' }),
  ],
  limiter: [
    p('gain', 'Gain', 0, 24, 0, { unit: 'dB' }),
    p('ceiling', 'Ceiling', -6, 0, -0.3, { unit: 'dB' }),
    p('release', 'Release', 0.01, 0.5, 0.05, { unit: 's', curve: 'exp' }),
  ],
  reverb: [
    p('size', 'Size', 0, 1, 0.6),
    p('damp', 'Damp', 0, 1, 0.4),
    p('width', 'Width', 0, 1, 1),
    p('predelay', 'PreDelay', 0, 0.2, 0.02, { unit: 's' }),
  ],
  delay: [
    p('time', 'Time', 0, 7, 4, {
      options: ['1/32', '1/16', '1/16.', '1/8', '1/8.', '1/4', '1/4.', '1/2'],
    }),
    p('feedback', 'Feedback', 0, 0.95, 0.4),
    p('pingpong', 'PingPong', 0, 1, 1, { options: ['Off', 'On'] }),
    p('filter', 'Filter', 200, 12000, 3500, { unit: 'Hz', curve: 'exp' }),
  ],
  chorus: [
    p('rate', 'Rate', 0.05, 8, 0.8, { unit: 'Hz', curve: 'exp' }),
    p('depth', 'Depth', 0, 1, 0.5),
    p('voices', 'Voices', 2, 6, 3),
  ],
  flanger: [
    p('rate', 'Rate', 0.05, 8, 0.3, { unit: 'Hz', curve: 'exp' }),
    p('depth', 'Depth', 0, 1, 0.6),
    p('feedback', 'Feedback', 0, 0.9, 0.5),
  ],
  phaser: [
    p('rate', 'Rate', 0.05, 8, 0.4, { unit: 'Hz', curve: 'exp' }),
    p('depth', 'Depth', 0, 1, 0.7),
    p('stages', 'Stages', 2, 8, 4),
    p('feedback', 'Feedback', 0, 0.9, 0.3),
  ],
  distortion: [
    p('drive', 'Drive', 0, 1, 0.4),
    p('tone', 'Tone', 500, 12000, 4000, { unit: 'Hz', curve: 'exp' }),
    p('mode', 'Mode', 0, 2, 0, { options: ['Soft', 'Hard', 'Fold'] }),
    p('output', 'Output', 0, 2, 1),
  ],
  bitcrush: [
    p('bits', 'Bits', 2, 16, 8),
    p('downsample', 'Downsmp', 1, 40, 4),
  ],
  autofilter: [
    p('type', 'Type', 0, 2, 0, { options: ['LP', 'HP', 'BP'] }),
    p('cutoff', 'Cutoff', 40, 18000, 1200, { unit: 'Hz', curve: 'exp' }),
    p('resonance', 'Reso', 0, 1, 0.4),
    p('lfoRate', 'LFO Rate', 0.05, 16, 2, { unit: 'Hz', curve: 'exp' }),
    p('lfoAmount', 'LFO Amt', 0, 1, 0),
    p('envAmount', 'Env Amt', 0, 1, 0),
  ],
  gate: [
    p('threshold', 'Thresh', -70, 0, -40, { unit: 'dB' }),
    p('attack', 'Attack', 0.0005, 0.05, 0.002, { unit: 's', curve: 'exp' }),
    p('release', 'Release', 0.01, 1, 0.1, { unit: 's', curve: 'exp' }),
  ],
  stereo: [
    p('width', 'Width', 0, 2, 1),
    p('gain', 'Gain', 0, 2, 1),
    p('monoBelow', 'MonoBelow', 0, 500, 110, { unit: 'Hz' }),
  ],
  analyzer: [],
};

export const EFFECT_LABELS: Record<EffectKind, string> = {
  eq: 'Orbit EQ',
  compressor: 'Orbit Comp',
  limiter: 'Orbit Limiter',
  reverb: 'Orbit Reverb',
  delay: 'Orbit Delay',
  chorus: 'Orbit Chorus',
  flanger: 'Orbit Flanger',
  phaser: 'Orbit Phaser',
  distortion: 'Orbit Drive',
  bitcrush: 'Orbit Crush',
  autofilter: 'Orbit Filter',
  gate: 'Orbit Gate',
  stereo: 'Orbit Stereo',
  analyzer: 'Orbit Scope',
};

export const INSTRUMENT_LABELS: Record<InstrumentKind, string> = {
  sub808: 'Orbit Sub',
  synth: 'Orbit Synth',
  supersaw: 'Orbit Saw',
  fm: 'Orbit FM',
  drums: 'Orbit Drums',
  sampler: 'Orbit Sampler',
};

/** Params por defecto de un instrumento. */
export function defaultInstrumentParams(kind: InstrumentKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of INSTRUMENT_PARAMS[kind]) out[spec.key] = spec.default;
  return out;
}

/** Params por defecto de un efecto. */
export function defaultEffectParams(kind: EffectKind): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of EFFECT_PARAMS[kind]) out[spec.key] = spec.default;
  return out;
}

/** Busca el spec de un parámetro concreto. */
export function findParamSpec(
  specs: ParamSpec[],
  key: string,
): ParamSpec | undefined {
  return specs.find((s) => s.key === key);
}

/** Desnormaliza 0..1 → rango real del spec (respetando curva exp). */
export function denormalizeParam(spec: ParamSpec, norm: number): number {
  const t = Math.min(1, Math.max(0, norm));
  if (spec.curve === 'exp' && spec.min > 0) {
    return spec.min * Math.pow(spec.max / spec.min, t);
  }
  return spec.min + (spec.max - spec.min) * t;
}

/** Normaliza un valor real → 0..1 según el spec. */
export function normalizeParam(spec: ParamSpec, value: number): number {
  const v = Math.min(spec.max, Math.max(spec.min, value));
  if (spec.curve === 'exp' && spec.min > 0) {
    return Math.log(v / spec.min) / Math.log(spec.max / spec.min);
  }
  return (v - spec.min) / (spec.max - spec.min);
}
