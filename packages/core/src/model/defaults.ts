/** Fábricas de entidades y proyecto vacío. */

import { newId } from '../ids';
import { DEFAULT_NOVA_PRESET, findNovaPreset } from './nova';
import { DEFAULT_PRISMA_PRESET, findPrismaPreset, prismaPresetParams } from './prisma';
import {
  defaultInstrumentParams,
  INSTRUMENT_LABELS,
} from './params';
import type {
  Arrangement,
  Channel,
  EffectSlot,
  InstrumentKind,
  Lfo,
  MixerTrack,
  ParamRef,
  Pattern,
  PlaylistTrack,
  Project,
} from './types';
import { CHANNEL_SLOTS, FORMAT_VERSION, MIXER_SLOTS } from './types';

/** Paleta por defecto para canales/patrones/pistas (se rota). */
export const PALETTE = [
  '#5aa9e6', '#e6675a', '#7ce65a', '#e6c95a', '#b45ae6',
  '#5ae6c9', '#e65aa9', '#a9e65a', '#5a7ce6', '#e6935a',
] as const;

export function pickColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

/** Cadena de inserts vacía de un canal (longitud fija, huecos = null). */
export function createChannelFx(): (EffectSlot | null)[] {
  return Array.from({ length: CHANNEL_SLOTS }, () => null);
}

export function createChannel(
  kind: InstrumentKind,
  index: number,
  name?: string,
): Channel {
  // Un canal de presets (Nova o Prisma) nace con uno cargado y sus macros en
  // el valor que el preset propone: abrirlo y que no suene a nada sería un mal
  // recibimiento.
  let params = defaultInstrumentParams(kind);
  let novaPreset: string | undefined;
  let prismaPreset: string | undefined;
  let presetName: string | undefined;
  if (kind === 'nova') {
    novaPreset = DEFAULT_NOVA_PRESET;
    const preset = findNovaPreset(novaPreset);
    if (preset) {
      params['macro1'] = preset.macros[0].value;
      params['macro2'] = preset.macros[1].value;
      presetName = preset.name;
    }
  } else if (kind === 'prisma') {
    prismaPreset = DEFAULT_PRISMA_PRESET;
    const preset = findPrismaPreset(prismaPreset);
    if (preset) {
      params = prismaPresetParams(preset);
      presetName = preset.name;
    }
  }
  return {
    id: newId(),
    name: name ?? presetName ?? INSTRUMENT_LABELS[kind],
    color: pickColor(index),
    kind,
    ...(novaPreset ? { novaPreset } : null),
    ...(prismaPreset ? { prismaPreset } : null),
    params,
    volume: 0.78, // ≈ -2.2 dB, margen de mezcla
    pan: 0,
    mute: false,
    solo: false,
    mixerTrack: 0,
    fx: createChannelFx(),
  };
}

export function createPattern(index: number, name?: string): Pattern {
  return {
    id: newId(),
    name: name ?? `Patrón ${index + 1}`,
    color: pickColor(index),
    length: 4,
    notes: {},
  };
}

export function createMixerTrack(index: number): MixerTrack {
  return {
    id: newId(),
    name: index === 0 ? 'Master' : `Insert ${index}`,
    color: index === 0 ? '#e6c95a' : '#3a3d45',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    slots: Array.from({ length: MIXER_SLOTS }, () => null),
    routeTo: index === 0 ? null : 0,
    sends: [],
  };
}

export function createPlaylistTrack(
  arrangementId: string,
  order: number,
  name?: string,
): PlaylistTrack {
  return {
    id: newId(),
    arrangementId,
    name: name ?? `Pista ${order + 1}`,
    color: pickColor(order),
    height: 56,
    muted: false,
    order,
  };
}

/**
 * LFO nuevo sobre un destino: seno de un compás, profundidad discreta.
 * Se crea apagado-de-fábrica NO: nace encendido para que se oiga al instante
 * (es lo que espera quien acaba de pulsar "Añadir LFO" en la perilla).
 */
export function createLfo(target: ParamRef, rateBeats = 4): Lfo {
  return {
    id: newId(),
    target,
    shape: 'sine',
    rateBeats,
    amount: 0.25,
    phase: 0,
    enabled: true,
  };
}

export const DEFAULT_MIXER_TRACKS = 26; // Master + 25 inserts (crece bajo demanda)

export function createEmptyProject(title = 'Nuevo proyecto'): Project {
  const arrangement: Arrangement = { id: newId(), name: 'Arrangement 1' };
  const pattern = createPattern(0);
  const tracks: Record<string, PlaylistTrack> = {};
  for (let i = 0; i < 8; i++) {
    const t = createPlaylistTrack(arrangement.id, i);
    tracks[t.id] = t;
  }
  return {
    formatVersion: FORMAT_VERSION,
    id: newId(),
    meta: { title, author: '', comments: '' },
    tempo: 140,
    timeSig: { num: 4, den: 4 },
    swing: 0,
    channels: {},
    channelOrder: [],
    patterns: { [pattern.id]: pattern },
    patternOrder: [pattern.id],
    arrangements: { [arrangement.id]: arrangement },
    arrangementOrder: [arrangement.id],
    activeArrangementId: arrangement.id,
    playlistTracks: tracks,
    clips: {},
    markers: {},
    lfos: {},
    mixer: Array.from({ length: DEFAULT_MIXER_TRACKS }, (_, i) => createMixerTrack(i)),
    samples: {},
  };
}
