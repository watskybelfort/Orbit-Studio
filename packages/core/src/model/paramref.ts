/**
 * Utilidades de `ParamRef`: identidad, spec, nombre legible y conversión
 * valor real ⇄ 0..1.
 *
 * Un ParamRef apunta a CUALQUIER parámetro automatizable del proyecto
 * (canal, mezcla del canal, pista de mixer, parámetro de efecto, transporte).
 * Antes cada consumidor tenía su propia copia de estas conversiones — el
 * compilador del motor desnormalizaba y el editor de automatización
 * normalizaba, con el riesgo evidente de que dejaran de ser inversas. Aquí
 * viven una sola vez y las usan motor, editor, LFOs y grabación de perillas.
 */

import type { Command } from '../commands';
import { EFFECT_LABELS, EFFECT_PARAMS, INSTRUMENT_PARAMS, denormalizeParam, findParamSpec, normalizeParam, type ParamSpec } from './params';
import type { ParamRef, Project } from './types';


/** Rango del tempo cuando se automatiza (BPM). */
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 999;

/** Rango del EQ de pista (dB). */
export const EQ_MIN = -18;
export const EQ_MAX = 18;

function isEqParam(param: string): boolean {
  return param === 'eqLow' || param === 'eqMid' || param === 'eqHigh';
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Clave estable de un destino: dos ParamRef equivalentes dan la misma cadena.
 * Sirve de identidad en mapas (LFOs por destino, carriles de grabación...).
 */
export function paramRefKey(ref: ParamRef): string {
  switch (ref.kind) {
    case 'channel':
      return `ch:${ref.channelId}:${ref.param}`;
    case 'channelMix':
      return `chmix:${ref.channelId}:${ref.param}`;
    case 'mixer':
      return `mix:${ref.trackIndex}:${ref.param}`;
    case 'effect':
      return `fx:${ref.trackIndex}:${ref.slotIndex}:${ref.param}`;
    case 'channelFx':
      return `chfx:${ref.channelId}:${ref.slotIndex}:${ref.param}`;
    case 'transport':
      return `tr:${ref.param}`;
  }
}

/** Slot de efecto propio de un canal (o undefined si no hay). */
function channelSlot(ref: Extract<ParamRef, { kind: 'channelFx' }>, project: Project) {
  return project.channels[ref.channelId]?.fx?.[ref.slotIndex] ?? undefined;
}

/** ParamSpec del destino; solo canal y efecto tienen (el resto es rango fijo). */
export function paramSpecOf(ref: ParamRef, project: Project): ParamSpec | undefined {
  if (ref.kind === 'channel') {
    const ch = project.channels[ref.channelId];
    return ch ? findParamSpec(INSTRUMENT_PARAMS[ch.kind], ref.param) : undefined;
  }
  if (ref.kind === 'effect') {
    const slot = project.mixer[ref.trackIndex]?.slots[ref.slotIndex];
    return slot ? findParamSpec(EFFECT_PARAMS[slot.kind], ref.param) : undefined;
  }
  if (ref.kind === 'channelFx') {
    const slot = channelSlot(ref, project);
    return slot ? findParamSpec(EFFECT_PARAMS[slot.kind], ref.param) : undefined;
  }
  return undefined;
}

/** Descripción legible ("Insert 3 · volume", "Canal 808 · glide"…). */
export function describeParamRef(ref: ParamRef, project: Project): string {
  switch (ref.kind) {
    case 'channel': {
      const ch = project.channels[ref.channelId];
      const spec = ch ? findParamSpec(INSTRUMENT_PARAMS[ch.kind], ref.param) : undefined;
      return `Canal ${ch?.name ?? '?'} · ${spec?.label ?? ref.param}`;
    }
    case 'channelMix': {
      const ch = project.channels[ref.channelId];
      return `Canal ${ch?.name ?? '?'} · ${ref.param} (mezcla)`;
    }
    case 'mixer': {
      const t = project.mixer[ref.trackIndex];
      return `${t?.name ?? `Mixer ${ref.trackIndex}`} · ${ref.param}`;
    }
    case 'effect': {
      const t = project.mixer[ref.trackIndex];
      const slot = t?.slots[ref.slotIndex];
      const fx = slot ? EFFECT_LABELS[slot.kind] : `slot ${ref.slotIndex + 1}`;
      const spec = slot ? findParamSpec(EFFECT_PARAMS[slot.kind], ref.param) : undefined;
      return `${t?.name ?? `Mixer ${ref.trackIndex}`} · ${fx} · ${spec?.label ?? ref.param}`;
    }
    case 'channelFx': {
      const ch = project.channels[ref.channelId];
      const slot = channelSlot(ref, project);
      const fx = slot ? EFFECT_LABELS[slot.kind] : `slot ${ref.slotIndex + 1}`;
      const spec = slot ? findParamSpec(EFFECT_PARAMS[slot.kind], ref.param) : undefined;
      return `Canal ${ch?.name ?? '?'} · ${fx} · ${spec?.label ?? ref.param}`;
    }
    case 'transport':
      return `Transporte · ${ref.param}`;
  }
}

/**
 * 0..1 → valor REAL del parámetro (lo que consume el kernel).
 * Los destinos sin spec tienen rango fijo: ganancias 0..2, pan -1..1,
 * tempo 20..999 BPM y swing 0..1.
 */
export function paramRefValue(norm: number, ref: ParamRef, project: Project): number {
  const t = clamp01(norm);
  switch (ref.kind) {
    case 'channel': {
      const spec = paramSpecOf(ref, project);
      return spec ? denormalizeParam(spec, t) : t;
    }
    case 'channelMix':
      return ref.param === 'volume' ? t * 2 : t * 2 - 1;
    case 'mixer':
      if (ref.param === 'pan') return t * 2 - 1;
      if (isEqParam(ref.param)) return EQ_MIN + t * (EQ_MAX - EQ_MIN);
      return t * 2; // volume y stereoWidth 0..2
    case 'effect':
    case 'channelFx': {
      const spec = paramSpecOf(ref, project);
      return spec ? denormalizeParam(spec, t) : t;
    }
    case 'transport':
      return ref.param === 'tempo' ? TEMPO_MIN + t * (TEMPO_MAX - TEMPO_MIN) : t;
  }
}

/** Valor real → 0..1 (inversa exacta de `paramRefValue`). */
export function paramValueNorm(value: number, ref: ParamRef, project: Project): number {
  switch (ref.kind) {
    case 'channel':
    case 'effect':
    case 'channelFx': {
      const spec = paramSpecOf(ref, project);
      return spec ? normalizeParam(spec, value) : clamp01(value);
    }
    case 'channelMix':
      return ref.param === 'volume' ? clamp01(value / 2) : clamp01((value + 1) / 2);
    case 'mixer':
      if (ref.param === 'pan') return clamp01((value + 1) / 2);
      if (isEqParam(ref.param)) return clamp01((value - EQ_MIN) / (EQ_MAX - EQ_MIN));
      return clamp01(value / 2);
    case 'transport':
      return ref.param === 'tempo'
        ? clamp01((value - TEMPO_MIN) / (TEMPO_MAX - TEMPO_MIN))
        : clamp01(value);
  }
}

/** Valor ACTUAL del destino en el proyecto, normalizado a 0..1 (null si no existe). */
export function paramRefNorm(ref: ParamRef, project: Project): number | null {
  switch (ref.kind) {
    case 'channel': {
      const ch = project.channels[ref.channelId];
      const value = ch?.params[ref.param];
      return value === undefined ? null : paramValueNorm(value, ref, project);
    }
    case 'channelMix': {
      const ch = project.channels[ref.channelId];
      if (!ch) return null;
      return paramValueNorm(ref.param === 'volume' ? ch.volume : ch.pan, ref, project);
    }
    case 'mixer': {
      const t = project.mixer[ref.trackIndex];
      if (!t) return null;
      return paramValueNorm(t[ref.param], ref, project);
    }
    case 'effect': {
      const slot = project.mixer[ref.trackIndex]?.slots[ref.slotIndex];
      const value = slot?.params[ref.param];
      return value === undefined ? null : paramValueNorm(value, ref, project);
    }
    case 'channelFx': {
      const value = channelSlot(ref, project)?.params[ref.param];
      return value === undefined ? null : paramValueNorm(value, ref, project);
    }
    case 'transport':
      return paramValueNorm(ref.param === 'tempo' ? project.tempo : project.swing, ref, project);
  }
}

/** Texto del valor de un destino: con spec en unidades reales; sin spec, 0..1. */
export function formatParamRef(ref: ParamRef, project: Project, norm: number): string {
  const spec = paramSpecOf(ref, project);
  if (!spec) {
    const real = paramRefValue(norm, ref, project);
    if (ref.kind === 'transport' && ref.param === 'tempo') return `${real.toFixed(1)} BPM`;
    if (ref.kind === 'mixer' && isEqParam(ref.param)) return `${real.toFixed(1)} dB`;
    if (ref.kind === 'mixer' || ref.kind === 'channelMix') {
      return ref.param === 'pan' ? formatPanValue(real) : real.toFixed(2);
    }
    return real.toFixed(2);
  }
  const real = denormalizeParam(spec, norm);
  if (spec.options) {
    const idx = Math.min(spec.options.length - 1, Math.max(0, Math.round(real)));
    return spec.options[idx] ?? real.toFixed(0);
  }
  const digits = Math.abs(real) >= 100 ? 0 : Math.abs(real) >= 10 ? 1 : 2;
  return `${real.toFixed(digits)}${spec.unit ? ` ${spec.unit}` : ''}`;
}

function formatPanValue(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
}

/**
 * Comando que ESCRIBE un destino con un valor 0..1. La mitad que faltaba:
 * `paramRefNorm` sabía leer cualquier parámetro y no había forma de escribir
 * uno sin saber de antemano de qué tipo era y qué comando le tocaba.
 *
 * Lo necesita todo lo que mueve un parámetro sin ser su perilla: un mando
 * físico aprendido por MIDI, la paleta de comandos, un preset que se aplica.
 * Que salga un `Command` y no una mutación es lo que mantiene la regla dura
 * del repo — todo pasa por el bus, así que todo tiene undo y viaja a la sala.
 *
 * Devuelve `null` si el destino ya no existe (canal borrado, slot vacío): un
 * mando aprendido sobrevive al efecto que apuntaba, y mover ese mando no
 * puede reventar.
 */
export function paramRefCommand(ref: ParamRef, norm: number, project: Project): Command | null {
  const value = paramRefValue(norm, ref, project);
  switch (ref.kind) {
    case 'channel': {
      const ch = project.channels[ref.channelId];
      if (!ch || ch.params[ref.param] === undefined) return null;
      return { type: 'setChannelParam', channelId: ref.channelId, key: ref.param, value };
    }
    case 'channelMix': {
      if (!project.channels[ref.channelId]) return null;
      return {
        type: 'patchChannel',
        channelId: ref.channelId,
        patch: ref.param === 'volume' ? { volume: value } : { pan: value },
      };
    }
    case 'mixer': {
      if (!project.mixer[ref.trackIndex]) return null;
      return {
        type: 'patchMixerTrack',
        trackIndex: ref.trackIndex,
        patch: { [ref.param]: value },
      };
    }
    case 'effect': {
      const slot = project.mixer[ref.trackIndex]?.slots[ref.slotIndex];
      if (!slot || slot.params[ref.param] === undefined) return null;
      return {
        type: 'setEffectParam',
        trackIndex: ref.trackIndex,
        slotIndex: ref.slotIndex,
        key: ref.param,
        value,
      };
    }
    case 'channelFx': {
      const slot = channelSlot(ref, project);
      if (!slot || slot.params[ref.param] === undefined) return null;
      return {
        type: 'setChannelEffectParam',
        channelId: ref.channelId,
        slotIndex: ref.slotIndex,
        key: ref.param,
        value,
      };
    }
    case 'transport':
      return ref.param === 'tempo'
        ? { type: 'setTempo', tempo: value }
        : { type: 'setSwing', swing: value };
  }
}
