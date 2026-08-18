/**
 * Protocolo UI ⇄ kernel y proyecto compilado.
 *
 * El kernel no conoce el modelo editable: recibe un `CompiledProject`
 * (eventos aplanados + cadena de mixer) y mensajes de transporte/parámetros.
 */

import type { EffectKind, InstrumentKind } from '@orbit/core';
import type { NovaLayerDef, NovaMacroDef } from './dsp/voices';
import type { PrismaDef } from './dsp/prisma-voice';

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
  /**
   * kind === 'slicer': cortes propios del canal (0..1, ordenados, el primero
   * 0). Sin ellos el motor reparte el sample en `params.slices` partes
   * iguales, que es como funcionó siempre.
   */
  slicePoints?: number[];
  /**
   * kind === 'nova': el preset ya resuelto. El kernel no conoce la librería
   * de sonidos — recibe las capas y el mapa de macros y con eso construye la
   * voz, así que un preset nuevo no obliga a tocar el motor.
   */
  nova?: { layers: NovaLayerDef[]; macros: NovaMacroDef[] };
  /**
   * kind === 'prisma': el preset ya resuelto (capas + macros), igual que Nova.
   * El kernel sigue sin conocer la librería de sonidos.
   */
  prisma?: PrismaDef;
  /**
   * Efectos PROPIOS del canal: suenan entre las voces y la pista de mixer, así
   * que un sonido se puede tratar a solas sin arrastrar a los demás canales
   * que compartan pista. Ausente o todo null = el canal entra seco, que es el
   * camino rápido de siempre.
   */
  fx?: (CompiledEffect | null)[];
  /**
   * Plugin JS de instrumento que sustituye al motor interno del canal: cada
   * nota instancia `createInstrument(sampleRate)` del plugin registrado. Si el
   * id no está registrado (o su fábrica falla) el canal cae a su `kind`, que
   * es la misma degradación amable que un slot de efecto con plugin ausente.
   */
  instrumentPluginId?: string;
}

export interface CompiledEffect {
  id: string;
  kind: EffectKind;
  enabled: boolean;
  mix: number;
  params: Record<string, number>;
  sidechainSource?: number;
  /** kind === 'plugin': id del plugin JS registrado en el kernel. */
  pluginId?: string;
}

export interface CompiledMixerTrack {
  id: string;
  volume: number;
  pan: number;
  stereoWidth: number;
  /** EQ del strip en dB (0 = plano; si los tres lo están, el filtro ni corre). */
  eqLow: number;
  eqMid: number;
  eqHigh: number;
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

/**
 * LFO compilado. El kernel no conoce specs de parámetros: recibe una LUT
 * monótona (norm 0..1 → valor real) para ir y volver entre ambos mundos, y
 * la fase se deriva de la posición en beats para que el render offline dé
 * exactamente lo mismo que la reproducción en vivo.
 */
export interface CompiledLfo {
  target: CompiledParamTarget;
  /** 0 seno · 1 triángulo · 2 sierra · 3 cuadrada · 4 sample & hold. */
  shape: number;
  /** Beats por ciclo. */
  rateBeats: number;
  /** Profundidad bipolar -1..1 en unidades normalizadas. */
  amount: number;
  /** Desfase inicial en ciclos (0..1). */
  phase: number;
  /** Valor normalizado del parámetro en el proyecto (base de la oscilación). */
  baseNorm: number;
  /** Tabla norm→valor real, `LFO_LUT_STEPS + 1` entradas equiespaciadas. */
  lut: Float32Array;
}

/** Resolución de la LUT de los LFOs (el error de interpolación queda < 0.2 %). */
export const LFO_LUT_STEPS = 64;

export type CompiledParamTarget =
  | { scope: 'channelParam'; channelIndex: number; key: string }
  | { scope: 'channelMix'; channelIndex: number; key: 'volume' | 'pan' }
  | {
      scope: 'mixer';
      trackIndex: number;
      key: 'volume' | 'pan' | 'stereoWidth' | 'eqLow' | 'eqMid' | 'eqHigh';
    }
  | { scope: 'effect'; trackIndex: number; slotIndex: number; key: string }
  | { scope: 'channelFx'; channelIndex: number; slotIndex: number; key: string }
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
  /** Time-stretch: el sample se estira (pitch intacto) hasta llenar el clip. */
  stretch: boolean;
  /**
   * Transposición en semitonos (+12 = una octava arriba). La duración NO
   * cambia: el kernel lee el sample más rápido/lento y compensa con el mismo
   * motor de grains del stretch. Ausente o 0 = lectura directa, sin grains.
   */
  pitch?: number;
}

/** Cambio de tempo o de compás a partir de un beat (viene de un marcador). */
export interface TempoChange {
  beat: number;
  tempo: number;
}

export interface MeterChange {
  beat: number;
  /** Pulsos por compás desde ese beat. */
  num: number;
}

export interface CompiledProject {
  tempo: number;
  /** Pulsos por compás (acento del metrónomo); ausente = 4. */
  timeSigNum?: number;
  /**
   * Mapas de tempo y compás por marcador, ordenados y con el valor del
   * proyecto en el beat 0. Con un solo tramo el kernel se comporta igual que
   * antes: tempo constante y compás fijo.
   */
  tempoMap?: TempoChange[];
  meterMap?: MeterChange[];
  /** Longitud del timeline en beats (para loop de canción y render). */
  lengthBeats: number;
  channels: CompiledChannel[];
  events: CompiledNoteEvent[];
  audioClips: CompiledAudioClip[];
  automation: CompiledAutomationEvent[];
  /** Moduladores continuos; se aplican DESPUÉS de la automatización. */
  lfos: CompiledLfo[];
  mixer: CompiledMixerTrack[];
  /** Orden topológico de proceso del mixer (hojas → master). */
  mixerOrder: number[];
}

// ── Mensajes UI → kernel ─────────────────────────────────────────────────────

export type ToKernel =
  | { type: 'snapshot'; project: CompiledProject }
  /** Cambio CUANTIZADO: el snapshot entra al terminar el loop actual (vista Live). */
  | { type: 'queueSnapshot'; project: CompiledProject }
  /** Registra (o actualiza) un plugin JS de usuario: código fuente del módulo. */
  | { type: 'registerPlugin'; pluginId: string; code: string }
  /**
   * Igual que `registerPlugin` pero para un plugin de INSTRUMENTO
   * (`createInstrument(sampleRate)`). Son dos mensajes y no uno porque el
   * emisor es distinto — el escáner de plugins sabe qué exporta cada archivo —
   * pero el kernel compila el módulo una sola vez y se queda con las fábricas
   * que encuentre, así un archivo con las dos sirve para ambas cosas.
   */
  | { type: 'registerInstrument'; pluginId: string; code: string }
  | { type: 'play'; fromBeat: number }
  | { type: 'stop' }
  | { type: 'seek'; beat: number }
  | { type: 'setLoop'; start: number; end: number; enabled: boolean }
  | { type: 'setMetronome'; enabled: boolean }
  /** Tap del Orbit Scope; `trackIndex` elige la pista de mixer (default 0 = master). */
  | { type: 'setScope'; enabled: boolean; trackIndex?: number }
  /** Graba la salida post-fader de una pista: el audio viaja en los frames. */
  | { type: 'setTrackCapture'; trackIndex: number; enabled: boolean }
  | { type: 'setTempo'; tempo: number }
  | { type: 'channelParam'; channelIndex: number; key: string; value: number }
  | { type: 'channelMix'; channelIndex: number; volume: number; pan: number; audible: boolean }
  | {
      type: 'mixerParam';
      trackIndex: number;
      key: 'volume' | 'pan' | 'stereoWidth' | 'eqLow' | 'eqMid' | 'eqHigh';
      value: number;
    }
  | { type: 'mixerAudible'; audible: boolean[] }
  | { type: 'effectParam'; trackIndex: number; slotIndex: number; key: string; value: number }
  | { type: 'effectState'; trackIndex: number; slotIndex: number; enabled: boolean; mix: number }
  /** Perilla de un insert PROPIO del canal (sin recompilar el proyecto). */
  | { type: 'channelEffectParam'; channelIndex: number; slotIndex: number; key: string; value: number }
  | {
      type: 'channelEffectState';
      channelIndex: number;
      slotIndex: number;
      enabled: boolean;
      mix: number;
    }
  | { type: 'loadSample'; sampleId: string; left: Float32Array; right: Float32Array; sampleRate: number }
  | { type: 'previewNote'; channelIndex: number; key: number; on: boolean }
  | { type: 'previewSample'; sampleId: string; gain: number };

// ── Mensajes kernel → UI ─────────────────────────────────────────────────────

export interface MeterFrame {
  /** Peak L/R por pista de mixer (post-fader), lineal. */
  peaks: Float32Array;
  /** RMS por pista de mixer (post-fader, media L/R), lineal; una entrada por pista. */
  rms: Float32Array;
  /** RMS master L/R. */
  masterRms: [number, number];
  /** Últimos samples de la pista tapeada (mono L+R/2) para el Orbit Scope; solo si está activado. */
  scope?: Float32Array;
  /** Audio grabado de la pista en captura desde el frame anterior (estéreo). */
  captureL?: Float32Array;
  captureR?: Float32Array;
  /** Posición del playhead en beats. */
  positionBeats: number;
  playing: boolean;
  /** Carga estimada del kernel 0..1. */
  cpu: number;
  /**
   * Notas que están sonando ahora mismo (voces todavía no soltadas), una
   * entrada por voz, empaquetadas como (channelIndex << 8) | key. Es lo que
   * ilumina las teclas del piano: el dato sale del kernel, así que cubre por
   * igual lo que se toca en vivo y lo que dispara el secuenciador. Ausente
   * cuando no suena nada, que es el caso normal y evita alocar por frame.
   */
  notes?: Uint16Array;
}

export type FromKernel =
  | { type: 'meters'; frame: MeterFrame }
  | { type: 'ready' };

export const KERNEL_NAME = 'orbit-kernel';
export const METER_INTERVAL_BLOCKS = 16; // ~46 ms a 128 samples/48 kHz
