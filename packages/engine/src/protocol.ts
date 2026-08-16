/**
 * Protocolo UI ⇄ kernel y proyecto compilado.
 *
 * El kernel no conoce el modelo editable: recibe un `CompiledProject`
 * (eventos aplanados + cadena de mixer) y mensajes de transporte/parámetros.
 */

import type { EffectKind, InstrumentKind } from '@orbit/core';

// ── Proyecto compilado ───────────────────────────────────────────────────────

export interface CompiledNoteEvent {
  /** Inicio en beats absolutos del timeline activo (con swing aplicado). */
  start: number;
  duration: number;
  key: number;
  velocity: number;
  pan: number;
  slide: boolean;
  channelIndex: number;
}

export interface CompiledChannel {
  id: string;
  kind: InstrumentKind;
  params: Record<string, number>;
  volume: number;
  pan: number;
  audible: boolean; // mute/solo ya resueltos
  mixerTrack: number;
  sampleId?: string;
}

export interface CompiledEffect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  mix: number;
  params: Record<string, number>;
  sidechainSource?: number;
}

export interface CompiledMixerTrack {
  id: string;
  volume: number;
  pan: number;
  stereoWidth: number;
  audible: boolean; // mute/solo resueltos
  slots: (CompiledEffect | null)[];
  routeTo: number | null;
  sends: { target: number; level: number }[];
}

export interface CompiledAutomationEvent {
  /** Curva muestreada a rejilla fija (1/32 de beat) sobre el rango del clip. */
  startBeat: number;
  /** Paso entre muestras en beats. */
  step: number;
  values: number[];
  target: CompiledParamTarget;
}

export type CompiledParamTarget =
  | { scope: 'channelParam'; channelIndex: number; key: string }
  | { scope: 'channelMix'; channelIndex: number; key: 'volume' | 'pan' }
  | { scope: 'mixer'; trackIndex: number; key: 'volume' | 'pan' | 'stereoWidth' }
  | { scope: 'effect'; trackIndex: number; slotIndex: number; key: string }
  | { scope: 'transport'; key: 'tempo' | 'swing' };

export interface CompiledAudioClip {
  /** Inicio en beats absolutos. */
  start: number;
  /** Duración audible en beats. */
  length: number;
  sampleId: string;
  /** Offset en segundos dentro del sample. */
  offset: number;
  gain: number;
  mixerTrack: number;
}

export interface CompiledProject {
  tempo: number;
  /** Longitud del timeline en beats (para loop de canción y render). */
  lengthBeats: number;
  channels: CompiledChannel[];
  events: CompiledNoteEvent[];
  audioClips: CompiledAudioClip[];
  automation: CompiledAutomationEvent[];
  mixer: CompiledMixerTrack[];
  /** Orden topológico de proceso del mixer (hojas → master). */
  mixerOrder: number[];
}

// ── Mensajes UI → kernel ─────────────────────────────────────────────────────

export type ToKernel =
  | { type: 'snapshot'; project: CompiledProject }
  | { type: 'play'; fromBeat: number }
  | { type: 'stop' }
  | { type: 'seek'; beat: number }
  | { type: 'setLoop'; start: number; end: number; enabled: boolean }
  | { type: 'setMetronome'; enabled: boolean }
  | { type: 'setScope'; enabled: boolean }
  | { type: 'setTempo'; tempo: number }
  | { type: 'channelParam'; channelIndex: number; key: string; value: number }
  | { type: 'channelMix'; channelIndex: number; volume: number; pan: number; audible: boolean }
  | { type: 'mixerParam'; trackIndex: number; key: 'volume' | 'pan' | 'stereoWidth'; value: number }
  | { type: 'mixerAudible'; audible: boolean[] }
  | { type: 'effectParam'; trackIndex: number; slotIndex: number; key: string; value: number }
  | { type: 'effectState'; trackIndex: number; slotIndex: number; enabled: boolean; mix: number }
  | { type: 'loadSample'; sampleId: string; left: Float32Array; right: Float32Array; sampleRate: number }
  | { type: 'previewNote'; channelIndex: number; key: number; on: boolean }
  | { type: 'previewSample'; sampleId: string; gain: number };

// ── Mensajes kernel → UI ─────────────────────────────────────────────────────

export interface MeterFrame {
  /** Peak L/R por pista de mixer (post-fader), lineal. */
  peaks: Float32Array;
  /** RMS master L/R. */
  masterRms: [number, number];
  /** Últimos samples del master (mono L+R/2) para el Orbit Scope; solo si está activado. */
  scope?: Float32Array;
  /** Posición del playhead en beats. */
  positionBeats: number;
  playing: boolean;
  /** Carga estimada del kernel 0..1. */
  cpu: number;
}

export type FromKernel =
  | { type: 'meters'; frame: MeterFrame }
  | { type: 'ready' };

export const KERNEL_NAME = 'orbit-kernel';
export const METER_INTERVAL_BLOCKS = 16; // ~46 ms a 128 samples/48 kHz
