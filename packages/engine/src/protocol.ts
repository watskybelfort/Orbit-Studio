/**
 * Protocolo UI ⇄ kernel y proyecto compilado.
 *
 * El kernel no conoce el modelo editable: recibe un `CompiledProject`
 * (eventos aplanados + cadena de mixer) y mensajes de transporte/parámetros.
 */

import type { EffectKind, InstrumentKind, KeymapZone } from '@orbit/core';

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
  /**
   * Rueda de tono del canal, en semitonos. Ausente = 0 (sin doblar).
   *
   * Va en el canal COMPILADO porque es un parámetro automatizable como el
   * volumen, y el kernel tiene que poder recibirlo por la curva y por el
   * gesto. Lo que hace con él no es escribirlo en una variable: reafina las
   * voces vivas de ese canal y se queda puesto para las que nazcan después.
   */
  bend?: number;
  sampleId?: string;
  /**
   * kind === 'slicer': cortes propios del canal (0..1, ordenados, el primero
   * 0). Sin ellos el motor reparte el sample en `params.slices` partes
   * iguales, que es como funcionó siempre.
   */
  slicePoints?: number[];
  /**
   * kind === 'sampler': multisample. Con zonas MANDA sobre `sampleId` —que
   * viaja igual, para que quitar el keymap devuelva el canal a como estaba—.
   */
  keymap?: KeymapZone[];

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
  /**
   * Envíos ya resueltos por el compilador: el kernel no adivina valores por
   * defecto (si lo hiciera, un `.orbit` viejo podría sonar distinto de lo que
   * pinta la UI, que resuelve con `resolveSend`).
   */
  sends: {
    target: number;
    level: number;
    /** 'pre' toma la señal antes del fader. */
    tap: 'post' | 'pre';
    part: 'stereo' | 'mid' | 'side' | 'left' | 'right';
    invert: boolean;
    pan: number;
    mute: boolean;
  }[];
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
  | { scope: 'channelMix'; channelIndex: number; key: 'volume' | 'pan' | 'bend' }
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
  /** Fundido de entrada en beats (rampa lineal de 0 a 1 desde el inicio). */
  fadeIn?: number;
  /** Fundido de salida en beats (rampa lineal de 1 a 0 hasta el final). */
  fadeOut?: number;
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

// ── Entrada en vivo: enrutado de canales físicos ─────────────────────────────

/**
 * Una ruta de entrada tal como la ve el KERNEL: de qué canales físicos del
 * aparato lee y dónde los deja. Nada de nombres ni de ids — eso vive en el
 * proyecto (`@orbit/core`, `model/input-routing.ts`), y el motor no lo
 * necesita para mover muestras.
 *
 * El ÍNDICE de la ruta dentro del array es su identidad aquí: es lo que dice
 * el mensaje de captura y lo que vuelve en cada paquete de audio grabado. Por
 * eso las rutas que el aparato no tiene viajan igual en vez de filtrarse: si
 * se filtraran, la toma de una ruta caería en la pista de otra.
 */
export interface CompiledInputRoute {
  /** Canal físico (0-based) que alimenta el lado izquierdo. */
  srcL: number;
  /** Canal físico del lado derecho; **-1 = mono** (el izquierdo a los dos lados). */
  srcR: number;
  /** Pista de mixer por la que entra, ANTES de sus inserts. */
  mixerTrack: number;
  /** Ganancia de entrada, lineal. No afecta al medidor ni a la toma en crudo. */
  gain: number;
  /** Se oye por su pista (con el interruptor maestro de `setLiveInput` puesto). */
  monitor: boolean;
}

/** Audio en crudo de UNA ruta desde el frame anterior. */
export interface InputCaptureChunk {
  /** Índice de la ruta dentro del último `setInputRoutes`. */
  routeIndex: number;
  left: Float32Array;
  right: Float32Array;
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
  /**
   * Cuenta atrÃ¡s CON EL TRANSPORTE PARADO: `beats` clics al tempo actual y, al
   * cerrar el Ãºltimo, el transporte arranca solo en `playFrom` (si viene).
   *
   * Existe porque el metrÃ³nomo del kernel solo suena rodando: grabar desde el
   * compÃ¡s 1 no tiene sitio por delante para el pre-roll, asÃ­ que la cuenta se
   * hacÃ­a paradaâ€¦ y muda. Que la cuente el kernel y no un `setTimeout` es lo
   * que hace que el 1 caiga en el sample exacto: la cuenta y el compÃ¡s 1
   * comparten reloj.
   */
  | { type: 'countIn'; beats: number; beatsPerBar: number; playFrom?: number }
  /** Aborta la cuenta atrÃ¡s en marcha (y con ella su arranque diferido). */
  | { type: 'cancelCountIn' }
  /**
   * Entrada en vivo (micro/instrumento) por la entrada del nodo del kernel.
   *
   * `listening` = medir el nivel de lo que entra, para poder ajustar ganancia
   * sin oírse. `monitor` = además meterlo en la pista `trackIndex` ANTES de
   * sus inserts: oírlo con la cadena del canal puesta, que es la gracia —
   * cantar con el reverb y el compresor que va a llevar la toma.
   */
  | {
      type: 'setLiveInput';
      listening: boolean;
      monitor: boolean;
      trackIndex: number;
      gain: number;
    }
  /**
   * Guardar la entrada EN CRUDO: mientras está activo, el audio del micro
   * viaja tal cual en `inputCaptureL/R` de cada frame de medidores.
   *
   * Es lo que hace que una toma no pase por un códec con pérdida. Antes la
   * grabación la hacía `MediaRecorder`, que en este Electron solo sabe
   * webm/opus: cada toma se comprimía y se volvía a decodificar antes de
   * escribirse como WAV de 24 bits que ya no tenía 24 bits de información.
   */
  /**
   * Reparto de la entrada por canal físico. Sin esto (o con la lista vacía) el
   * kernel se comporta como siempre: una ruta implícita que lee los canales 1
   * y 2 y los mete en la pista de `setLiveInput`.
   *
   * Llega COMO MENSAJE y no dentro del snapshot a propósito: el enrutado
   * depende del aparato que haya abierto ahora mismo (cuántas entradas trae),
   * no solo del proyecto, y recompilar el proyecto entero por enchufar una
   * interfaz sería trabajo de sobra en el peor momento.
   */
  | { type: 'setInputRoutes'; routes: readonly CompiledInputRoute[] }
  | {
      type: 'setInputCapture';
      enabled: boolean;
      /**
       * Qué rutas se graban, por índice. Ausente o vacío = solo la primera,
       * que sin rutas declaradas es la implícita: exactamente la grabación de
       * un micro de toda la vida.
       */
      routes?: readonly number[];
    }

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
  /**
   * Recolección de samples del worklet: `keep` es la lista COMPLETA de ids que
   * todavía hacen falta, y el kernel SUELTA todo lo demás que tenga cargado.
   *
   * Va con la lista de los que se quedan y no con la de los que sobran por una
   * razón concreta: quien manda el mensaje (la UI) sabe qué usa el proyecto,
   * pero NO sabe qué tiene cargado el worklet —nadie lleva esa cuenta fuera
   * del kernel—, así que la resta solo la puede hacer el que tiene el mapa.
   *
   * Quién decide es el hilo de la UI, contando referencias contra el proyecto
   * editable (`sampleKeepSet` en compile.ts). Dentro de `process()` no se
   * recorre ningún mapa buscando huérfanos: la lista llega hecha.
   *
   * El kernel no obedece a ciegas. Protege por su cuenta lo que el proyecto
   * compilado que tiene puesto (y el que tenga en cola) referencia, el preview
   * de sample en marcha y lo que esté leyendo una voz viva — eso último no se
   * suelta, se APLAZA hasta que la voz muere.
   *
   * Es una descarga LOCAL del worklet, no un borrado del asset: el sample
   * sigue en el proyecto, en el disco y en la sala de colaboración, y volver a
   * usarlo es volver a subirlo con `loadSample`.
   */
  | { type: 'collectSamples'; keep: readonly string[] }
  | { type: 'previewNote'; channelIndex: number; key: number; on: boolean }
  /**
   * Rueda de tono de un canal, en SEMITONOS (bipolar).
   *
   * Van semitonos y no la posición cruda de la rueda porque el rango es una
   * decisión de quien toca (±2 de fábrica, ±12 para un lead) y no del motor.
   * El kernel se lo aplica a las voces vivas de ese canal Y se lo guarda: la
   * nota que se toque con la rueda sujeta tiene que nacer ya doblada.
   */
  | { type: 'pitchBend'; channelIndex: number; semitones: number }
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
  /**
   * Entrada en vivo en crudo desde el frame anterior (grabación de micro).
   * Es la PRIMERA ruta que esté capturando; el resto viaja en `inputCaptures`.
   * Se mantiene aparte porque es el camino de siempre —una toma, un micro— y
   * quien lo escucha (el grabador, la calibración de latencia) no tiene por
   * qué saber que existen las rutas.
   */
  inputCaptureL?: Float32Array;
  inputCaptureR?: Float32Array;
  /**
   * Todas las rutas que están capturando, la primera incluida (la misma que
   * viaja arriba, sin copiar: es el mismo Float32Array). Ausente cuando no hay
   * ninguna captura en marcha, que es el caso normal.
   */
  inputCaptures?: InputCaptureChunk[];

  /** Posición del playhead en beats. */
  positionBeats: number;
  playing: boolean;
  /**
   * Beats de cuenta atrÃ¡s que faltan para que entre el transporte, contando el
   * que suena ahora. Ausente cuando no hay cuenta en marcha.
   */
  countInBeatsLeft?: number;
  /**
   * Pico de la entrada en vivo ANTES de su ganancia (0 si no se escucha). Con
   * varias rutas es el MAYOR de todas: es el LED de "está entrando algo", y
   * sigue significando eso enchufes lo que enchufes.
   */
  inputPeak: number;
  /**
   * Pico por ruta, en el orden del último `setInputRoutes`. Es lo que permite
   * ajustar la ganancia de cada micro por separado — con un solo número no se
   * puede saber cuál de los dos está saturando. Ausente mientras no se escucha.
   */
  inputPeaks?: Float32Array;

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
