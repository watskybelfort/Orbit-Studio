/**
 * Generador del pack "Warehouse" — techno duro y rave.
 *
 * Ejecutar desde la raíz del repo:
 *   npm run pack:warehouse            → lo instala en Orbit (userData/packs)
 *   npm run pack:warehouse -- --out X → lo deja en la carpeta X (para mirarlo)
 *
 * ── De dónde sale ──────────────────────────────────────────────────────────
 *
 * No es un pack "de techno" sacado de la cabeza: sale de MEDIR dos temas que
 * pidió el usuario y rehacer lo que se midió con el motor de la casa. Ninguna
 * muestra de los originales entra aquí —todo es síntesis— pero los números de
 * abajo son suyos, y son los que explican por qué cada perilla está donde
 * está.
 *
 *   Referencia A (hard groove, 134,0 BPM medidos — pulso de 447,8 ms)
 *     · centro tonal La menor: La en 55/110/220 Hz y Mi en 83/165/330 Hz
 *     · bombo con fundamental en ~51 Hz; el ataque (0-15 ms) sale plano de 20
 *       a 120 Hz, −8 dB en 120-200, −22 en 200-400 y REPUNTA en 1,6-3,2 kHz:
 *       ese repunte es el click, y es lo que lo hace sonar "delante"
 *     · el cuerpo (15-120 ms) ya es casi solo 40-60 Hz (−13 dB en 80-120)
 *     · ruido de fondo continuo con máximo en 2-3 kHz y caída suave: −8,5 dB
 *       en 4-6 k, −12,6 en 6-9 k, −18,4 en 9-12 k, −25 en 12-16 k
 *     · factor de cresta 10,0 dB
 *
 *   Referencia B (rave, 156,0 BPM — pulso de 384,6 ms)
 *     · mucho más oscura: −12,5 dB ya en 4-6 kHz y −19 en 12-16 k
 *     · factor de cresta 7,2 dB (limitada de verdad)
 *     · bombo en ~47-49 Hz con una cola descendente que LLENA el pulso: a
 *       200 ms sigue habiendo 40-60 Hz a −0 dB y 200-400 Hz a −21
 *     · el grave del tramo cambia de nota: 65 Hz (Do) en los drops, 124 Hz
 *       (Si) en la sección de en medio
 *
 * De ahí salen las tres familias de bombo del pack: el de A (click en 2-3 kHz,
 * cuerpo corto), el de B (cola larga y oscura, el "rumble") y el crudo, que es
 * el de A pasado por saturación dura, como suena cuando el tema aprieta.
 *
 * ── Por qué NO va en el pack de fábrica ────────────────────────────────────
 *
 * Porque el de fábrica viaja dentro del instalador y dentro del repo: 98,87 MB
 * de 115 de tope, y sus 276 WAV están versionados. Este pack se GENERA: el
 * generador ocupa lo que ocupa un archivo de texto, se escribe en la carpeta
 * de packs de la app (la misma que usan los packs que pide Claude, con su
 * mismo manifest) y se rehace igualito cuando haga falta, porque aquí no hay
 * ni un Math.random: toda la variación sale de parámetros escritos a mano.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  encodeWavMono,
  esMono,
  fadeOut,
  normalizar,
  picoDeWavDb,
  recortarCola,
} from './wav-out';

// Imports relativos a la fuente del engine: el index del paquete arrastra
// engine.ts (worklet de Vite) que Node no puede resolver fuera del bundler.
import { renderProject } from '../../engine/src/render/offline';
import { encodeWav } from '../../engine/src/render/wav';
import type {
  CompiledAutomationEvent,
  CompiledChannel,
  CompiledEffect,
  CompiledMixerTrack,
  CompiledNoteEvent,
  CompiledProject,
} from '../../engine/src/protocol';
import type { EffectKind, InstrumentKind } from '@orbit/core';
import { loadManifest, type SoundCategory, type SoundEntry, type SoundManifest } from '../src/types';

const SR = 44100;
const PACK_NAME = 'Warehouse';
const PACK_SLUG = 'warehouse';
/** Tope de archivos por pack que impone `pack:save` en el main de Electron. */
const MAX_ARCHIVOS = 64;
/** Tope de bytes por pack que impone `pack:save`. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * La carpeta de packs de la app instalada, que es `userData/packs` de Electron
 * (`@orbit/desktop` es el nombre del paquete, y de ahí sale el del directorio).
 * El browser lee de ahí sin que haya que tocar nada de la app: el pack aparece
 * al lado de los que genera Claude, con su nombre y su botón de borrar.
 */
function carpetaDePacks(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, '@orbit', 'desktop', 'packs');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', '@orbit', 'desktop', 'packs');
  }
  const config = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
  return path.join(config, '@orbit', 'desktop', 'packs');
}

// ── Constructores de proyecto ────────────────────────────────────────────────

/** Contador global: ids estables por orden, sin azar. */
let contador = 0;

interface OpcionesCanal {
  volume?: number;
  pan?: number;
  /** Inserts PROPIOS del canal: tratan una capa sin tocar las demás. */
  fx?: CompiledEffect[];
}

function canal(
  kind: InstrumentKind,
  params: Record<string, number>,
  o: OpcionesCanal = {},
): CompiledChannel {
  const ch: CompiledChannel = {
    id: `ch-${contador++}`,
    kind,
    params,
    volume: o.volume ?? 0.8,
    pan: o.pan ?? 0,
    audible: true,
    mixerTrack: 0,
  };
  if (o.fx) ch.fx = o.fx;
  return ch;
}

function efecto(kind: EffectKind, params: Record<string, number>, mix = 1): CompiledEffect {
  return { id: `fx-${contador++}`, kind, enabled: true, mix, params };
}

interface OpcionesNota {
  vel?: number;
  ch?: number;
  /** Nota slide: reutiliza la voz viva y la arrastra (el glide del 808). */
  slide?: boolean;
  pan?: number;
}

function nota(start: number, duration: number, key: number, o: OpcionesNota = {}): CompiledNoteEvent {
  return {
    start,
    duration,
    key,
    velocity: o.vel ?? 1,
    pan: o.pan ?? 0,
    slide: o.slide ?? false,
    channelIndex: o.ch ?? 0,
  };
}

interface ProyectoOpts {
  tempo: number;
  lengthBeats: number;
  channels: CompiledChannel[];
  events: CompiledNoteEvent[];
  masterSlots?: CompiledEffect[];
  automation?: CompiledAutomationEvent[];
}

function proyecto(o: ProyectoOpts): CompiledProject {
  const master: CompiledMixerTrack = {
    id: 'master',
    volume: 1,
    pan: 0,
    stereoWidth: 1,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    audible: true,
    slots: o.masterSlots ?? [],
    routeTo: null,
    sends: [],
  };
  return {
    tempo: o.tempo,
    lengthBeats: o.lengthBeats,
    channels: o.channels,
    events: [...o.events].sort((a, b) => a.start - b.start),
    audioClips: [],
    automation: o.automation ?? [],
    lfos: [],
    mixer: [master],
    mixerOrder: [0],
  };
}

/** Rampa exponencial muestreada (frecuencias: el oído las oye así). */
function rampaExp(desde: number, hasta: number, beats: number, step = 0.125): number[] {
  const n = Math.max(1, Math.ceil(beats / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(desde * Math.pow(hasta / desde, i / n));
  return out;
}

/** Rampa lineal muestreada (semitonos, volúmenes). */
function rampaLin(desde: number, hasta: number, beats: number, step = 0.125): number[] {
  const n = Math.max(1, Math.ceil(beats / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(desde + (hasta - desde) * (i / n));
  return out;
}

/** Curva sobre un parámetro de un efecto del máster. */
function autoEfecto(
  slotIndex: number,
  key: string,
  values: number[],
  step = 0.125,
  startBeat = 0,
): CompiledAutomationEvent {
  return { startBeat, step, values, target: { scope: 'effect', trackIndex: 0, slotIndex, key } };
}

/** Curva sobre la rueda de tono de un canal (en semitonos). */
function autoBend(
  channelIndex: number,
  values: number[],
  step = 0.125,
  startBeat = 0,
): CompiledAutomationEvent {
  return { startBeat, step, values, target: { scope: 'channelMix', channelIndex, key: 'bend' } };
}

// ── Piezas reutilizables ─────────────────────────────────────────────────────

/** Teclas del DRUM_MAP (packages/core/src/model/params.ts). */
const K = {
  kick: 36,
  rim: 37,
  snare: 38,
  clap: 39,
  hat: 42,
  tom: 45,
  openhat: 46,
  conga: 48,
  crash: 49,
  shaker: 70,
} as const;

/**
 * Notas MIDI de los graves medidos en las referencias (440 Hz = 69).
 * A1 = 55 Hz es el centro de A; F#1/G1 (46,2/49,0 Hz) y C2 (65,4) los de B.
 */
const N = { Fs1: 30, G1: 31, Gs1: 32, A1: 33, As1: 34, C2: 36, D2: 38, E2: 40, B1: 35 } as const;

/**
 * El limitador de cierre. Todos los sonidos salen normalizados a -1 dBFS, pero
 * eso no es lo mismo que sonar apretado: la referencia B tiene 7,2 dB de
 * cresta y ahí no se llega normalizando, se llega limitando.
 */
function limitador(gainDb = 3): CompiledEffect {
  return efecto('limiter', { gain: gainDb, ceiling: -0.3, release: 0.05 });
}

interface OpcionesBombo {
  /** Nota del cuerpo (la fundamental del bombo). */
  key: number;
  /** Cuánto dura el cuerpo: `decay` del sub808 (τ = decay/4 s). */
  decay: number;
  /** Saturación del propio sub808 (0..1). */
  drive: number;
  /** Corte del sub808: cuánto armónico deja pasar el cuerpo. */
  tone: number;
  /** Barrido de altura del cuerpo: f arranca en key·(1+3·punch). */
  punch: number;
  /** Nivel del click (canal de drums). 0 = sin click. */
  click: number;
  /** Brillo del click (`tone` del kit: 0..1). */
  clickTone?: number;
  /** Cuánto dura el click. */
  clickDecay?: number;
  /** Saturación del máster (0 = ninguna). */
  satura?: number;
  /** Modo del saturador: 0 suave · 1 duro · 2 fold. */
  saturaModo?: number;
  /** Cola de reverb: el "rumble" de la referencia B. 0 = seco. */
  rumble?: number;
  /** Techo del filtro de la cola (Hz): el rumble es GRAVE o es barro. */
  rumbleTecho?: number;
  /** Nota desde la que cae el rumble (slide). Ausente = sin caída. */
  rumbleDesde?: number;
  /** Bits del crusher (ausente = sin crusher). */
  crush?: number;
  /**
   * Nivel de la capa a la octava (0 = ninguna).
   *
   * El `tanh` del sub808 es simétrico, así que solo saca armónicos IMPARES: el
   * bombo sale con un agujero justo en su segundo armónico. Medido, son 14 dB
   * de diferencia con las referencias, que en 80-120 Hz llevan casi tanto como
   * en su fundamental — y esa banda es la que hace que un bombo se oiga en un
   * altavoz pequeño. La capa a la octava es la forma barata de taparlo.
   */
  octava?: number;
}

/**
 * Un bombo de techno, por capas — que es como está hecho el de las dos
 * referencias y como NO está hecho el del kit de trap:
 *
 *   1. el CLICK, del kit de drums, que aporta el repunte de 1,6-3,2 kHz;
 *   2. el CUERPO, un sub808 con barrido de altura (el `punch` arranca la
 *      fundamental tres veces y media arriba y la deja caer en 20 ms);
 *   3. el RUMBLE cuando toca, que es un tercer sub808 cayendo por glide desde
 *      una nota alta hasta el sótano, pasado por reverb y por un techo bajo:
 *      esa es la diagonal descendente que se ve en el espectrograma de B.
 *
 * Las tres capas van a la misma pista y se aprietan juntas al final, porque un
 * bombo que se limita por capas no pega igual.
 */
function bombo(o: OpcionesBombo): () => { project: CompiledProject; tail: number; maxSec: number } {
  return () => {
    const channels: CompiledChannel[] = [];
    const events: CompiledNoteEvent[] = [];

    // 1) Click
    if (o.click > 0) {
      channels.push(
        canal(
          'drums',
          { kit: 0, tone: o.clickTone ?? 0.35, decay: o.clickDecay ?? 0.35, punch: 0.92 },
          {
            volume: o.click,
            fx: [
              efecto('eq', { hpFreq: 110, lowGain: 0, lowFreq: 120, midGain: 2.5,
                midFreq: 2500, midQ: 0.9, highGain: 1, highFreq: 6000, lpFreq: 13000 }),
            ],
          },
        ),
      );
      events.push(nota(0, 0.25, K.kick, { ch: channels.length - 1 }));
    }

    // 2) Cuerpo
    const cuerpo = channels.length;
    channels.push(
      canal(
        'sub808',
        { tune: 0, decay: o.decay, drive: o.drive, glide: 0.005, punch: o.punch, tone: o.tone },
        { volume: 0.95 },
      ),
    );
    events.push(nota(0, 2, o.key, { ch: cuerpo }));

    // 2b) La octava (ver `octava`): tapa el agujero del segundo armónico
    if (o.octava && o.octava > 0) {
      channels.push(
        canal(
          'sub808',
          { tune: 0, decay: o.decay * 0.6, drive: 0.25, glide: 0.005, punch: 0, tone: o.tone },
          { volume: o.octava },
        ),
      );
      events.push(nota(0, 2, o.key + 12, { ch: channels.length - 1 }));
    }

    // 3) Rumble
    if (o.rumble && o.rumble > 0) {
      const techo = o.rumbleTecho ?? 1400;
      channels.push(
        canal(
          'sub808',
          { tune: 0, decay: 0.55, drive: 0.75, glide: 0.12, punch: 0.15, tone: techo },
          {
            volume: 0.75,
            fx: [
              efecto('reverb', { size: 0.5, damp: 0.65, width: 0.6, predelay: 0 }, o.rumble),
              efecto('eq', {
                hpFreq: 28,
                lowGain: 2,
                lowFreq: 60,
                midGain: -4,
                midFreq: 320,
                midQ: 1,
                highGain: 0,
                highFreq: 6000,
                lpFreq: techo,
              }),
            ],
          },
        ),
      );
      const ch = channels.length - 1;
      const desde = o.rumbleDesde ?? o.key + 12;
      events.push(nota(0, 0.05, desde, { ch }));
      events.push(nota(0.05, 2, o.key, { ch, slide: true }));
    }

    const master: CompiledEffect[] = [];
    if (o.crush !== undefined) master.push(efecto('bitcrush', { bits: o.crush, downsample: 1 }, 0.5));
    if (o.satura && o.satura > 0) {
      master.push(
        efecto('distortion', {
          drive: o.satura,
          tone: 3800,
          mode: o.saturaModo ?? 1,
          output: 0.8,
        }),
      );
    }
    master.push(
      efecto('eq', {
        hpFreq: 26,
        lowGain: 1,
        lowFreq: 55,
        midGain: -1.5,
        midFreq: 350,
        midQ: 0.9,
        highGain: 0,
        highFreq: 6000,
        lpFreq: 18000,
      }),
    );
    return {
      project: proyecto({ tempo: 134, lengthBeats: 4, channels, events, masterSlots: master }),
      tail: 1.2,
      maxSec: o.rumble ? 1.4 : 1.1,
    };
  };
}

// ── Especificación ───────────────────────────────────────────────────────────

interface SonidoSpec {
  id: string;
  name: string;
  category: SoundCategory;
  subcategory?: string;
  file: string;
  tags: string[];
  keyRoot?: string;
  bpm?: number;
  gainSuggestion: number;
  build: () => {
    project: CompiledProject;
    tail: number;
    /** Loops: corte exacto en el beat, sin recorte por umbral. */
    exactSamples?: number;
    maxSec?: number;
  };
}

function spec(
  id: string,
  name: string,
  category: SoundCategory,
  tags: string[],
  gainSuggestion: number,
  build: SonidoSpec['build'],
  extra: Partial<Pick<SonidoSpec, 'subcategory' | 'keyRoot' | 'bpm'>> = {},
): SonidoSpec {
  return { id, name, category, file: `${id}.wav`, tags, gainSuggestion, build, ...extra };
}

/** Un golpe suelto del kit, con la cadena de máster que se le quiera poner. */
function golpe(
  key: number,
  p: { tone?: number; decay?: number; punch?: number },
  masterSlots: CompiledEffect[] = [],
  tail = 0.6,
  maxSec = 2.5,
): SonidoSpec['build'] {
  return () => ({
    project: proyecto({
      tempo: 134,
      lengthBeats: 4,
      channels: [
        canal('drums', {
          kit: 0,
          tone: p.tone ?? 0.5,
          decay: p.decay ?? 1,
          punch: p.punch ?? 0.5,
        }),
      ],
      events: [nota(0, 4, key)],
      masterSlots,
    }),
    tail,
    maxSec,
  });
}

interface OpcionesBajo {
  /** `decay` del sub808 (τ = decay/4 s). */
  decay: number;
  /** Saturación del propio sub808 (0..1). */
  drive: number;
  /** Corte del sub808 en Hz: cuánto armónico deja subir. */
  tone: number;
  /** Barrido de altura. En un bajo va bajo: el barrido es cosa del bombo. */
  punch?: number;
  /** Cola de reverb (0 = seco). */
  reverb?: number;
  /** Techo del canal en Hz, para que la cola no ensucie los medios. */
  lpf?: number;
  /** Saturación del máster. */
  satura?: number;
}

/** Un bajo del pack: sub808 con su cadena, sostenido `holdBeats` pulsos. */
function bajo(
  key: number,
  o: OpcionesBajo,
  holdBeats = 4,
): () => { project: CompiledProject; tail: number; maxSec: number } {
  return () => {
    const fx: CompiledEffect[] = [];
    if (o.reverb) fx.push(efecto('reverb', { size: 0.7, damp: 0.5, width: 0.6, predelay: 0 }, o.reverb));
    if (o.lpf !== undefined) {
      fx.push(efecto('eq', { hpFreq: 28, lowGain: 2, lowFreq: 60, midGain: -2, midFreq: 400,
        midQ: 1, highGain: 0, highFreq: 6000, lpFreq: o.lpf }));
    }
    const master: CompiledEffect[] = [];
    if (o.satura) {
      master.push(efecto('distortion', { drive: o.satura, tone: 2600, mode: 0, output: 0.85 }));
    }
    master.push(limitador(2));
    return {
      project: proyecto({
        tempo: 134,
        lengthBeats: holdBeats + 2,
        channels: [
          canal('sub808',
            { tune: 0, decay: o.decay, drive: o.drive, glide: 0.02, punch: o.punch ?? 0.15,
              tone: o.tone },
            { volume: 0.9, ...(fx.length > 0 ? { fx } : {}) }),
        ],
        events: [nota(0, holdBeats, key)],
        masterSlots: master,
      }),
      tail: 1,
      maxSec: 3,
    };
  };
}

// ── Los sonidos ──────────────────────────────────────────────────────────────

/**
 * El pack entero, declarado. Se exporta para que un test pueda mirarlo SIN
 * renderizar: las reglas que puede romper una regresión silenciosa —ids
 * únicos, el archivo que no cuadra con el id, un loop sin BPM declarado, un
 * bombo fuera de `drums`— se comprueban aquí en milisegundos, y renderizar 46
 * sonidos para verlas costaría medio minuto por test.
 */
export const SPECS: SonidoSpec[] = [
  // ── Bombos ─────────────────────────────────────────────────────────────────
  // Los tres primeros son las tres familias medidas; los demás son lo que hace
  // falta para montar un tema con ellas (uno apretado para el clímax, uno sin
  // click para doblar, el sub solo y la cola sola).
  spec('drums/kick-hardgroove-01', 'Kick Hard Groove 01', 'drums',
    ['techno', 'kick', 'hardgroove', 'punchy'], 0.95,
    bombo({ key: N.A1, decay: 0.38, drive: 0.55, tone: 1500, punch: 0.6, click: 0.62,
      clickTone: 0.5, clickDecay: 0.32, satura: 0.4, octava: 0.45 }), { subcategory: 'techno' }),
  spec('drums/kick-hardgroove-02', 'Kick Hard Groove 02', 'drums',
    ['techno', 'kick', 'hardgroove', 'deep', 'long'], 0.95,
    bombo({ key: N.G1, decay: 0.55, drive: 0.5, tone: 1300, punch: 0.52, click: 0.48,
      clickTone: 0.35, clickDecay: 0.34, satura: 0.32, octava: 0.4 }), { subcategory: 'techno' }),
  spec('drums/kick-rumble-01', 'Kick Rumble 01', 'drums',
    ['techno', 'kick', 'rumble', 'dark'], 0.95,
    bombo({ key: N.G1, decay: 0.45, drive: 0.45, tone: 900, punch: 0.48, click: 0.42,
      clickTone: 0.2, clickDecay: 0.3, satura: 0.25, rumble: 0.55, rumbleTecho: 1400, octava: 0.5 }),
    { subcategory: 'techno' }),
  spec('drums/kick-rumble-02', 'Kick Rumble 02', 'drums',
    ['techno', 'kick', 'rumble', 'dark', 'long'], 0.95,
    bombo({ key: N.Fs1, decay: 0.6, drive: 0.4, tone: 800, punch: 0.42, click: 0.32,
      clickTone: 0.15, clickDecay: 0.32, satura: 0.22, rumble: 0.7, rumbleTecho: 1200, octava: 0.3 }),
    { subcategory: 'techno' }),
  spec('drums/kick-raw-01', 'Kick Raw 01', 'drums',
    ['techno', 'kick', 'raw', 'distorted', 'hard'], 0.95,
    bombo({ key: N.A1, decay: 0.36, drive: 0.85, tone: 3400, punch: 0.68, click: 0.6,
      clickTone: 0.6, clickDecay: 0.26, satura: 0.68, crush: 7, octava: 0.48 }), { subcategory: 'techno' }),
  spec('drums/kick-punch-01', 'Kick Punch 01', 'drums',
    ['techno', 'kick', 'tight', 'short'], 0.95,
    bombo({ key: N.As1, decay: 0.26, drive: 0.6, tone: 1800, punch: 0.62, click: 0.78,
      clickTone: 0.55, clickDecay: 0.22, satura: 0.35, octava: 0.5 }), { subcategory: 'techno' }),
  spec('drums/kick-sub-01', 'Kick Sub 01', 'drums',
    ['techno', 'kick', 'sub', 'layer', 'clean'], 0.95,
    bombo({ key: N.Fs1, decay: 0.8, drive: 0.25, tone: 450, punch: 0.35, click: 0 }),
    { subcategory: 'techno' }),

  // La cola sola, sin bombo delante: para doblar CUALQUIER kick y que arrastre.
  // Es la diagonal descendente del espectrograma de la referencia B, aislada.
  spec('drums/kick-tail-01', 'Kick Tail 01', 'drums',
    ['techno', 'kick', 'rumble', 'tail', 'layer'], 0.8, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 4,
        channels: [
          canal('sub808',
            { tune: 0, decay: 0.7, drive: 0.75, glide: 0.14, punch: 0.15, tone: 1300 },
            { volume: 0.9, fx: [
              efecto('reverb', { size: 0.55, damp: 0.6, width: 0.7, predelay: 0 }, 0.55),
              efecto('eq', { hpFreq: 30, lowGain: 2, lowFreq: 60, midGain: -3, midFreq: 300,
                midQ: 1, highGain: 0, highFreq: 6000, lpFreq: 1300 }),
            ] }),
        ],
        events: [nota(0, 0.05, N.A1 + 12), nota(0.05, 3, N.Fs1, { slide: true })],
        masterSlots: [],
      }),
      tail: 1.5,
      maxSec: 1.6,
    }), { subcategory: 'techno' }),

  // ── Percusión ──────────────────────────────────────────────────────────────
  spec('drums/clap-01', 'Clap Warehouse 01', 'drums', ['techno', 'clap', 'room', 'wide'], 0.85,
    golpe(K.clap, { decay: 1.3 }, [
      efecto('eq', { hpFreq: 220, lowGain: 0, lowFreq: 120, midGain: 2, midFreq: 1400, midQ: 1,
        highGain: 3, highFreq: 5000, lpFreq: 14000 }),
      efecto('reverb', { size: 0.6, damp: 0.4, width: 1, predelay: 0.008 }, 0.3),
    ], 1.4, 1.8), { subcategory: 'techno' }),
  spec('drums/clap-02', 'Clap Warehouse 02', 'drums', ['techno', 'clap', 'tight', 'dry'], 0.85,
    golpe(K.clap, { decay: 0.7 }, [
      efecto('distortion', { drive: 0.32, tone: 5000, mode: 0, output: 0.9 }),
      efecto('eq', { hpFreq: 320, lowGain: 0, lowFreq: 120, midGain: 1.5, midFreq: 1800,
        midQ: 1.2, highGain: 2, highFreq: 6000, lpFreq: 15000 }),
    ], 0.7, 1), { subcategory: 'techno' }),
  spec('drums/snare-01', 'Snare Rave 01', 'drums', ['techno', 'rave', 'snare', 'noisy'], 0.85,
    golpe(K.snare, { tone: 0.7, decay: 1.1, punch: 0.5 }, [
      efecto('distortion', { drive: 0.35, tone: 6000, mode: 0, output: 0.9 }),
      efecto('eq', { hpFreq: 180, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1,
        highGain: 2, highFreq: 6000, lpFreq: 15000 }),
    ], 1, 1.4), { subcategory: 'techno' }),
  spec('drums/hat-01', 'Hat Warehouse 01', 'drums', ['techno', 'hat', 'short', 'dark'], 0.5,
    golpe(K.hat, { tone: 0, decay: 0.5 }, [
      efecto('eq', { hpFreq: 20, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1,
        highGain: -3, highFreq: 10000, lpFreq: 11000 }),
    ], 0.4, 0.5), { subcategory: 'techno' }),
  spec('drums/hat-02', 'Hat Warehouse 02', 'drums', ['techno', 'hat', 'bright', 'tight'], 0.5,
    golpe(K.hat, { tone: 0.9, decay: 0.3 }, [], 0.3, 0.4), { subcategory: 'techno' }),

  // El "tick" de la referencia A: su ruido tiene el máximo en 2-3 kHz, no
  // arriba del todo. El kit no tiene ninguna pieza que suene ahí —el hat
  // arranca en 7 kHz—, así que sale de la caja sin su parte tonal: se corta
  // por debajo de 1,2 kHz (el seno de 170 Hz se va entero) y por encima de 7.
  spec('drums/hat-warm-01', 'Hat Warm 01', 'drums', ['techno', 'hat', 'warm', 'noise'], 0.5,
    golpe(K.snare, { tone: 0, decay: 0.35, punch: 0.3 }, [
      efecto('eq', { hpFreq: 1200, lowGain: 0, lowFreq: 200, midGain: 2, midFreq: 2500,
        midQ: 0.8, highGain: -4, highFreq: 8000, lpFreq: 7000 }),
    ], 0.4, 0.6), { subcategory: 'techno' }),
  spec('drums/openhat-01', 'Open Hat 01', 'drums', ['techno', 'openhat', 'offbeat'], 0.55,
    golpe(K.openhat, { tone: 0.1, decay: 0.5 }, [
      efecto('eq', { hpFreq: 20, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1,
        highGain: -3, highFreq: 10000, lpFreq: 12000 }),
    ], 0.7, 1), { subcategory: 'techno' }),
  spec('drums/openhat-02', 'Open Hat 02', 'drums', ['techno', 'openhat', 'long', 'wash'], 0.55,
    golpe(K.openhat, { tone: 0.3, decay: 1.2 }, [
      efecto('eq', { hpFreq: 20, lowGain: 0, lowFreq: 120, midGain: 0, midFreq: 1000, midQ: 1,
        highGain: -2, highFreq: 10000, lpFreq: 13000 }),
      efecto('reverb', { size: 0.5, damp: 0.5, width: 1, predelay: 0.005 }, 0.2),
    ], 1.2, 1.8), { subcategory: 'techno' }),
  spec('drums/ride-01', 'Ride Metal 01', 'drums', ['techno', 'ride', 'metal'], 0.55,
    golpe(K.crash, { tone: 0.8, decay: 0.45 }, [
      efecto('eq', { hpFreq: 4000, lowGain: 0, lowFreq: 200, midGain: 0, midFreq: 1000, midQ: 1,
        highGain: 1, highFreq: 9000, lpFreq: 13000 }),
    ], 1, 1.6), { subcategory: 'techno' }),
  spec('drums/crash-01', 'Crash Warehouse 01', 'drums', ['techno', 'crash', 'long'], 0.65,
    golpe(K.crash, { tone: 0.5, decay: 1.3 }, [
      efecto('eq', { hpFreq: 300, lowGain: 0, lowFreq: 200, midGain: 0, midFreq: 1000, midQ: 1,
        highGain: -2, highFreq: 10000, lpFreq: 13000 }),
      efecto('reverb', { size: 0.75, damp: 0.35, width: 1, predelay: 0.01 }, 0.3),
    ], 2.5, 3), { subcategory: 'techno' }),
  spec('drums/perc-metal-01', 'Perc Metal 01', 'drums',
    ['techno', 'perc', 'metal', 'industrial'], 0.7, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 4,
        channels: [canal('fm', { ratio: 7.5, index: 8, indexDecay: 0.05, attack: 0.001,
          decay: 0.22, sustain: 0, release: 0.12, octave: 0 }, { volume: 0.85 })],
        events: [nota(0, 0.5, 72)],
        masterSlots: [
          efecto('distortion', { drive: 0.3, tone: 7000, mode: 0, output: 0.9 }),
          limitador(2),
        ],
      }),
      tail: 0.5,
      maxSec: 1,
    }), { subcategory: 'techno' }),
  spec('drums/perc-metal-02', 'Perc Metal 02', 'drums', ['techno', 'perc', 'metal', 'low'], 0.7,
    () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 4,
        channels: [canal('fm', { ratio: 11, index: 6, indexDecay: 0.12, attack: 0.001,
          decay: 0.35, sustain: 0, release: 0.15, octave: 0 }, { volume: 0.85 })],
        events: [nota(0, 0.5, 60)],
        masterSlots: [
          efecto('distortion', { drive: 0.35, tone: 5000, mode: 1, output: 0.85 }),
          limitador(2),
        ],
      }),
      tail: 0.6,
      maxSec: 1.2,
    }), { subcategory: 'techno' }),
  spec('drums/rim-01', 'Rim Click 01', 'drums', ['techno', 'rim', 'click', 'short'], 0.6,
    golpe(K.rim, { tone: 0.5, decay: 0.8 }, [
      efecto('distortion', { drive: 0.3, tone: 6000, mode: 0, output: 0.9 }),
    ], 0.4, 0.6), { subcategory: 'techno' }),
  spec('drums/tom-01', 'Tom Industrial 01', 'drums', ['techno', 'tom', 'low', 'industrial'], 0.8,
    golpe(K.tom, { tone: 0.25, decay: 1.2 }, [
      efecto('distortion', { drive: 0.38, tone: 2500, mode: 1, output: 0.85 }),
      efecto('reverb', { size: 0.55, damp: 0.5, width: 0.8, predelay: 0.006 }, 0.2),
    ], 1.2, 1.8), { subcategory: 'techno' }),
  spec('drums/shaker-01', 'Shaker Warehouse 01', 'drums', ['techno', 'shaker', 'texture'], 0.5,
    golpe(K.shaker, { decay: 1.1 }, [], 0.5, 0.8), { subcategory: 'techno' }),

  // ── Bajos ──────────────────────────────────────────────────────────────────
  // El grave de las dos referencias no es un 808 de trap: no cae en glide ni
  // sostiene medio compás. Es corto, saturado y SIEMPRE por debajo de 70 Hz —
  // A en 55 Hz (referencia A), Do en 65 y Fa#/Sol en 46-49 (referencia B)—, y
  // se apoya en el bombo en vez de pelearse con él. De ahí los `decay` cortos
  // y el `punch` bajo: el barrido de altura es cosa del bombo, no del bajo.
  spec('808s/bass-sub-a', 'Bass Sub A', '808s', ['techno', 'bass', 'sub', 'clean'], 0.9,
    bajo(N.A1, { decay: 1.4, drive: 0.3, tone: 700 }), { subcategory: 'techno', keyRoot: 'A' }),
  spec('808s/bass-sub-c', 'Bass Sub C', '808s', ['techno', 'bass', 'sub', 'clean'], 0.9,
    bajo(N.C2, { decay: 1.4, drive: 0.3, tone: 700 }), { subcategory: 'techno', keyRoot: 'C' }),
  spec('808s/bass-sub-fs', 'Bass Sub F#', '808s', ['techno', 'bass', 'sub', 'deep'], 0.9,
    bajo(N.Fs1, { decay: 1.4, drive: 0.3, tone: 650 }), { subcategory: 'techno', keyRoot: 'F#' }),
  spec('808s/bass-sub-g', 'Bass Sub G', '808s', ['techno', 'bass', 'sub', 'deep'], 0.9,
    bajo(N.G1, { decay: 1.4, drive: 0.3, tone: 650 }), { subcategory: 'techno', keyRoot: 'G' }),
  spec('808s/bass-rumble-a', 'Bass Rumble A', '808s',
    ['techno', 'bass', 'rumble', 'dark', 'long'], 0.9,
    bajo(N.A1, { decay: 1.9, drive: 0.45, tone: 900, reverb: 0.3, lpf: 900 }),
    { subcategory: 'techno', keyRoot: 'A' }),
  spec('808s/bass-drive-c', 'Bass Drive C', '808s',
    ['techno', 'bass', 'distorted', 'hard'], 0.9,
    bajo(N.C2, { decay: 1.2, drive: 0.92, tone: 2200, satura: 0.5 }),
    { subcategory: 'techno', keyRoot: 'C' }),
  spec('808s/bass-stab-a', 'Bass Stab A', '808s',
    ['techno', 'bass', 'stab', 'short', 'offbeat'], 0.9,
    bajo(N.A1, { decay: 0.28, drive: 0.6, tone: 1400, punch: 0.45, satura: 0.3 }, 1),
    { subcategory: 'techno', keyRoot: 'A' }),

  // El reese no es un seno saturado: son sierras desafinadas entre sí, y el
  // batido que sale de ese desafine ES el sonido. Va a mono por debajo de
  // 110 Hz porque un grave ancho se desmonta en cuanto alguien lo escucha en
  // un equipo grande, que es exactamente donde va a sonar esto.
  spec('808s/bass-reese-a', 'Bass Reese A', '808s',
    ['techno', 'rave', 'bass', 'reese', 'wide'], 0.85, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 6,
        channels: [
          canal('supersaw',
            { detune: 0.55, blend: 0.9, cutoff: 1400, attack: 0.004, release: 0.25,
              width: 0.55, octave: -1 },
            { volume: 0.8 }),
        ],
        events: [nota(0, 4, 45)],
        masterSlots: [
          efecto('distortion', { drive: 0.35, tone: 2500, mode: 0, output: 0.85 }),
          efecto('eq', { hpFreq: 32, lowGain: 3, lowFreq: 70, midGain: -2, midFreq: 400,
            midQ: 0.9, highGain: 0, highFreq: 6000, lpFreq: 6000 }),
          efecto('stereo', { width: 1.25, gain: 1, monoBelow: 110 }),
          limitador(2),
        ],
      }),
      tail: 0.6,
      maxSec: 2.6,
    }), { subcategory: 'techno', keyRoot: 'A' }),

  // ── FX ─────────────────────────────────────────────────────────────────────
  // El riser de ruido: platos encadenados cada medio pulso (se solapan, así que
  // suena continuo) y un pasa-banda que sube de 400 Hz a 9 kHz en cuatro
  // compases. El barrido es EXPONENCIAL porque el oído oye octavas, no hercios:
  // una rampa lineal se pasa los tres primeros compases sin moverse del sótano.
  spec('fx/riser-noise-01', 'Riser Noise', 'fx',
    ['techno', 'rave', 'fx', 'riser', 'noise', 'sweep'], 0.8, () => {
      const events: CompiledNoteEvent[] = [];
      for (let i = 0; i < 16; i++) {
        const vel = 0.35 + (i / 15) * 0.65;
        events.push(nota(i * 0.5, 0.45, K.crash, { vel }));
        events.push(nota(i * 0.5, 0.45, K.snare, { ch: 1, vel }));
      }
      return {
        project: proyecto({
          tempo: 134,
          lengthBeats: 8,
          channels: [
            canal('drums', { kit: 0, tone: 0.55, decay: 0.8, punch: 0.5 }, { volume: 0.7 }),
            // La caja SIN su parte tonal es la única fuente de ruido del kit
            // que llega a 1,4 kHz: el plato empieza en 4,5 y el barrido se
            // pasaría media subida sin nada que filtrar.
            canal('drums', { kit: 0, tone: 0, decay: 2, punch: 0.3 },
              { volume: 0.55, fx: [
                efecto('eq', { hpFreq: 1200, lowGain: 0, lowFreq: 200, midGain: 0,
                  midFreq: 1000, midQ: 1, highGain: 0, highFreq: 6000, lpFreq: 16000 }),
              ] }),
          ],
          events,
          masterSlots: [
            efecto('autofilter', { type: 2, cutoff: 1200, resonance: 0.5, lfoRate: 0.05,
              lfoAmount: 0, envAmount: 0 }),
            efecto('reverb', { size: 0.7, damp: 0.4, width: 1, predelay: 0 }, 0.25),
            limitador(2),
          ],
          automation: [autoEfecto(0, 'cutoff', rampaExp(1200, 10000, 8))],
        }),
        tail: 1,
        maxSec: 4.2,
      };
    }),
  spec('fx/riser-tonal-01', 'Riser Tonal', 'fx',
    ['techno', 'fx', 'riser', 'supersaw', 'uplifter'], 0.8, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 8,
        channels: [
          canal('supersaw',
            { detune: 0.6, blend: 0.85, cutoff: 14000, attack: 1.4, release: 0.3,
              width: 0.9, octave: 0 },
            { volume: 0.8 }),
        ],
        events: [nota(0, 7.6, 45), nota(0, 7.6, 57, { vel: 0.75 })],
        masterSlots: [
          efecto('autofilter', { type: 0, cutoff: 300, resonance: 0.6, lfoRate: 0.05,
            lfoAmount: 0, envAmount: 0 }),
          efecto('reverb', { size: 0.75, damp: 0.35, width: 1, predelay: 0 }, 0.3),
          limitador(2),
        ],
        automation: [
          autoEfecto(0, 'cutoff', rampaExp(300, 9000, 8)),
          autoBend(0, rampaLin(0, 2, 8)),
        ],
      }),
      tail: 1.2,
      maxSec: 4.4,
    })),
  spec('fx/downlifter-01', 'Downlifter', 'fx',
    ['techno', 'fx', 'downlifter', 'sweep', 'down'], 0.8, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 6,
        channels: [
          canal('supersaw',
            { detune: 0.5, blend: 0.8, cutoff: 14000, attack: 0.01, release: 0.4,
              width: 0.9, octave: 0 },
            { volume: 0.8 }),
        ],
        events: [nota(0, 5.6, 45), nota(0, 5.6, 52, { vel: 0.7 })],
        masterSlots: [
          efecto('autofilter', { type: 0, cutoff: 9000, resonance: 0.55, lfoRate: 0.05,
            lfoAmount: 0, envAmount: 0 }),
          efecto('reverb', { size: 0.7, damp: 0.4, width: 1, predelay: 0 }, 0.3),
          limitador(2),
        ],
        automation: [
          autoEfecto(0, 'cutoff', rampaExp(9000, 300, 6)),
          autoBend(0, rampaLin(0, -24, 6)),
        ],
      }),
      tail: 1.2,
      maxSec: 3.6,
    })),
  spec('fx/impact-01', 'Impact Warehouse', 'fx',
    ['techno', 'fx', 'impact', 'dark', 'reverb'], 0.85, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 4,
        channels: [
          canal('sub808', { tune: 0, decay: 1.2, drive: 0.6, glide: 0.01, punch: 0.8,
            tone: 1200 }, { volume: 0.95 }),
          canal('drums', { kit: 0, tone: 0.4, decay: 1.6, punch: 0.6 }, { volume: 0.55 }),
        ],
        events: [nota(0, 2, N.Fs1), nota(0, 2, K.crash, { ch: 1 })],
        masterSlots: [
          efecto('distortion', { drive: 0.4, tone: 3000, mode: 1, output: 0.85 }),
          efecto('reverb', { size: 0.9, damp: 0.3, width: 1, predelay: 0 }, 0.55),
          limitador(2),
        ],
      }),
      tail: 3,
      maxSec: 3.2,
    })),
  // La sirena de rave: una cuadrada filtrada y la rueda de tono subiendo y
  // bajando una quinta, dos vueltas. La rueda existe justo para esto — mueve
  // la voz VIVA, así que no hay ni un salto de nota en medio.
  spec('fx/siren-01', 'Siren Rave', 'fx',
    ['rave', 'fx', 'siren', 'acid', 'loop'], 0.75, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 8,
        channels: [
          canal('synth',
            { wave: 1, cutoff: 3500, resonance: 0.45, envAmount: 0.2, attack: 0.02,
              decay: 0.3, sustain: 0.85, release: 0.15, unison: 2, detune: 0.08, octave: 0 },
            { volume: 0.7 }),
        ],
        events: [nota(0, 7.8, 64)],
        masterSlots: [
          efecto('delay', { time: 3, feedback: 0.35, pingpong: 1, filter: 4000 }, 0.25),
          efecto('reverb', { size: 0.6, damp: 0.4, width: 1, predelay: 0.01 }, 0.22),
          limitador(2),
        ],
        automation: [
          autoBend(0, [
            ...rampaLin(0, 7, 2),
            ...rampaLin(7, 0, 2).slice(1),
            ...rampaLin(0, 7, 2).slice(1),
            ...rampaLin(7, 0, 2).slice(1),
          ]),
        ],
      }),
      tail: 1,
      maxSec: 4.4,
    })),
  // El hoover: sierras desafinadas a lo bruto y la altura cayendo una cuarta en
  // el primer octavo. Sin esa caída son sierras desafinadas; con ella es 1991.
  spec('fx/hoover-01', 'Hoover Stab', 'fx',
    ['rave', 'fx', 'hoover', 'stab', 'supersaw'], 0.8, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 4,
        channels: [
          canal('supersaw',
            { detune: 0.85, blend: 1, cutoff: 3000, attack: 0.003, release: 0.35,
              width: 0.85, octave: 0 },
            { volume: 0.78 }),
        ],
        events: [nota(0, 2, 45), nota(0, 2, 57, { vel: 0.6 })],
        masterSlots: [
          efecto('phaser', { rate: 0.6, depth: 0.7, stages: 6, feedback: 0.4 }, 0.5),
          efecto('distortion', { drive: 0.3, tone: 4000, mode: 0, output: 0.9 }),
          efecto('reverb', { size: 0.55, damp: 0.45, width: 1, predelay: 0.008 }, 0.2),
          limitador(2),
        ],
        automation: [autoBend(0, [5, 3.2, 1.8, 0.8, 0.3, 0, 0, 0, 0], 0.125)],
      }),
      tail: 1,
      maxSec: 1.8,
    })),
  spec('fx/noise-sweep-down-01', 'Noise Sweep Down', 'fx',
    ['techno', 'fx', 'noise', 'sweep', 'down'], 0.75, () => {
      const events: CompiledNoteEvent[] = [];
      for (let i = 0; i < 8; i++) {
        events.push(nota(i * 0.5, 0.45, K.crash, { vel: 1 - (i / 7) * 0.5 }));
      }
      return {
        project: proyecto({
          tempo: 134,
          lengthBeats: 4,
          channels: [canal('drums', { kit: 0, tone: 0.6, decay: 0.8, punch: 0.5 },
            { volume: 0.75 })],
          events,
          masterSlots: [
            efecto('autofilter', { type: 0, cutoff: 12000, resonance: 0.5, lfoRate: 0.05,
              lfoAmount: 0, envAmount: 0 }),
            efecto('reverb', { size: 0.65, damp: 0.45, width: 1, predelay: 0 }, 0.25),
            limitador(2),
          ],
          automation: [autoEfecto(0, 'cutoff', rampaExp(12000, 300, 4))],
        }),
        tail: 1,
        maxSec: 2.6,
      };
    }),
  // La capa de ruido que suena TODO el rato en la referencia A, con su máximo
  // en 2-3 kHz: no es un efecto, es el aire de la nave. Va larga y floja, para
  // dejarla debajo de todo.
  spec('fx/atmos-noise-01', 'Atmos Warehouse', 'fx',
    ['techno', 'fx', 'atmos', 'noise', 'texture', 'long'], 0.55, () => {
      const events: CompiledNoteEvent[] = [];
      for (let i = 0; i < 16; i++) {
        const vel = 0.5 + 0.15 * Math.sin(i * 0.7);
        events.push(nota(i * 0.5, 0.45, K.snare, { vel }));
        events.push(nota(i * 0.5, 0.45, K.crash, { ch: 1, vel: vel * 0.45 }));
      }
      return {
        project: proyecto({
          tempo: 134,
          lengthBeats: 8,
          channels: [
            // Igual que en el riser: el cuerpo del aire está en 2-3 kHz, y ahí
            // solo llega la caja sin su seno.
            canal('drums', { kit: 0, tone: 0, decay: 2, punch: 0.3 },
              { volume: 0.6, fx: [
                efecto('eq', { hpFreq: 1200, lowGain: 0, lowFreq: 200, midGain: 0,
                  midFreq: 1000, midQ: 1, highGain: 0, highFreq: 6000, lpFreq: 12000 }),
              ] }),
            canal('drums', { kit: 0, tone: 0.3, decay: 1.4, punch: 0.5 }, { volume: 0.35 }),
          ],
          events,
          masterSlots: [
            efecto('autofilter', { type: 2, cutoff: 2500, resonance: 0.35, lfoRate: 0.12,
              lfoAmount: 0.35, envAmount: 0 }),
            efecto('reverb', { size: 0.85, damp: 0.4, width: 1, predelay: 0.02 }, 0.45),
            limitador(1),
          ],
        }),
        tail: 1.5,
        maxSec: 4.6,
      };
    }),
  spec('fx/zap-acid-01', 'Zap Acid', 'fx',
    ['rave', 'fx', 'zap', 'acid', 'short'], 0.75, () => ({
      project: proyecto({
        tempo: 134,
        lengthBeats: 2,
        channels: [
          canal('synth',
            { wave: 0, cutoff: 600, resonance: 0.88, envAmount: 0.95, attack: 0.001,
              decay: 0.12, sustain: 0, release: 0.08, unison: 1, detune: 0, octave: 0 },
            { volume: 0.8 }),
        ],
        events: [nota(0, 0.3, 57)],
        masterSlots: [
          efecto('distortion', { drive: 0.4, tone: 6000, mode: 0, output: 0.9 }),
          efecto('delay', { time: 1, feedback: 0.3, pingpong: 1, filter: 3500 }, 0.2),
          limitador(2),
        ],
      }),
      tail: 0.8,
      maxSec: 1.4,
    })),

  // ── Loops de batería (4 compases exactos) ──────────────────────────────────
  // El groove no es de manual: sale de contar dónde pega cada banda en las
  // referencias. En la A, el bombo cae en el pulso y el ruido llena los 8º; el
  // grave pega en el 16º de ANTES del pulso (el "empuje" del hard groove). En
  // la B, lo que llena los huecos es el hat abierto en cada contratiempo.
  spec('drums/loop-134-hardgroove', 'Loop Hard Groove 134', 'drums',
    ['techno', 'hardgroove', 'loop', 'drums', 'kick'], 0.8, () => {
      const events: CompiledNoteEvent[] = [];
      for (let b = 0; b < 16; b++) {
        events.push(nota(b, 0.25, K.kick, { ch: 0 }));
        events.push(nota(b, 1, N.A1, { ch: 1 }));
        events.push(nota(b + 0.5, 0.2, K.hat, { ch: 2, vel: 0.8 }));
        events.push(nota(b + 0.25, 0.2, K.hat, { ch: 2, vel: 0.4 }));
        events.push(nota(b + 0.75, 0.2, K.hat, { ch: 2, vel: 0.5 }));
        for (const q of [0, 0.25, 0.5, 0.75]) {
          events.push(nota(b + q, 0.2, K.snare, { ch: 4, vel: 0.55 }));
        }
      }
      for (const b of [1, 3, 5, 7, 9, 11, 13, 15]) {
        events.push(nota(b + 0.5, 0.3, K.openhat, { ch: 2, vel: 0.7 }));
      }
      for (const b of [6, 14]) events.push(nota(b, 0.5, K.clap, { ch: 3, vel: 0.9 }));
      for (const b of [2.75, 6.75, 10.75, 14.75]) {
        events.push(nota(b, 0.2, K.rim, { ch: 3, vel: 0.55 }));
      }
      events.push(nota(0, 1, K.crash, { ch: 3, vel: 0.5 }));
      return {
        project: proyecto({
          tempo: 134,
          lengthBeats: 16,
          channels: [
            canal('drums', { kit: 0, tone: 0.45, decay: 0.3, punch: 0.92 }, { volume: 0.5 }),
            canal('sub808', { tune: 0, decay: 0.45, drive: 0.5, glide: 0.005, punch: 0.62,
              tone: 1300 }, { volume: 0.95 }),
            canal('drums', { kit: 0, tone: 0.2, decay: 0.5, punch: 0.5 }, { volume: 0.5 }),
            canal('drums', { kit: 0, tone: 0.5, decay: 1.1, punch: 0.5 }, { volume: 0.6 }),
            canal('drums', { kit: 0, tone: 0, decay: 2, punch: 0.3 },
              { volume: 0.3, fx: [
                efecto('eq', { hpFreq: 1200, lowGain: 0, lowFreq: 200, midGain: 0,
                  midFreq: 1000, midQ: 1, highGain: -3, highFreq: 8000, lpFreq: 12000 }),
              ] }),
          ],
          events,
          masterSlots: [
            efecto('distortion', { drive: 0.25, tone: 4000, mode: 0, output: 0.85 }),
            efecto('eq', { hpFreq: 26, lowGain: 1.5, lowFreq: 55, midGain: -2, midFreq: 350,
              midQ: 0.9, highGain: 1, highFreq: 6000, lpFreq: 17000 }),
            limitador(4),
          ],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 134) * SR),
      };
    }, { subcategory: 'techno', bpm: 134, keyRoot: 'A' }),

  spec('drums/loop-156-rave', 'Loop Rave 156', 'drums',
    ['rave', 'techno', 'loop', 'drums', 'rumble'], 0.8, () => {
      const events: CompiledNoteEvent[] = [];
      for (let b = 0; b < 16; b++) {
        events.push(nota(b, 0.25, K.kick, { ch: 0 }));
        events.push(nota(b, 1, N.G1, { ch: 1 }));
        events.push(nota(b, 1, N.G1, { ch: 2 }));
        events.push(nota(b + 0.5, 0.3, K.openhat, { ch: 3, vel: 0.75 }));
        events.push(nota(b + 0.25, 0.2, K.hat, { ch: 3, vel: 0.35 }));
        events.push(nota(b + 0.75, 0.2, K.hat, { ch: 3, vel: 0.45 }));
        for (const q of [0, 0.25, 0.5, 0.75]) {
          events.push(nota(b + q, 0.2, K.snare, { ch: 5, vel: 0.55 }));
        }
      }
      for (const b of [6, 14]) events.push(nota(b, 0.5, K.clap, { ch: 4, vel: 0.85 }));
      for (const b of [3.5, 11.5]) events.push(nota(b, 0.3, K.rim, { ch: 4, vel: 0.6 }));
      events.push(nota(0, 1, K.crash, { ch: 4, vel: 0.5 }));
      return {
        project: proyecto({
          tempo: 156,
          lengthBeats: 16,
          channels: [
            canal('drums', { kit: 0, tone: 0.25, decay: 0.3, punch: 0.92 }, { volume: 0.38 }),
            canal('sub808', { tune: 0, decay: 0.5, drive: 0.4, glide: 0.005, punch: 0.5,
              tone: 700 }, { volume: 0.95 }),
            canal('sub808',
              { tune: 0, decay: 1.2, drive: 0.3, glide: 0.005, punch: 0.9, tone: 700 },
              { volume: 0.5, fx: [
                efecto('reverb', { size: 0.8, damp: 0.55, width: 0.6, predelay: 0 }, 0.55),
                efecto('eq', { hpFreq: 28, lowGain: 2, lowFreq: 60, midGain: -4, midFreq: 320,
                  midQ: 1, highGain: 0, highFreq: 6000, lpFreq: 700 }),
              ] }),
            canal('drums', { kit: 0, tone: 0.15, decay: 0.5, punch: 0.5 }, { volume: 0.5 }),
            canal('drums', { kit: 0, tone: 0.5, decay: 1.1, punch: 0.5 }, { volume: 0.6 }),
            canal('drums', { kit: 0, tone: 0, decay: 2, punch: 0.3 },
              { volume: 0.26, fx: [
                efecto('eq', { hpFreq: 1200, lowGain: 0, lowFreq: 200, midGain: 0,
                  midFreq: 1000, midQ: 1, highGain: -5, highFreq: 8000, lpFreq: 9000 }),
              ] }),
          ],
          events,
          masterSlots: [
            efecto('distortion', { drive: 0.22, tone: 3500, mode: 0, output: 0.85 }),
            efecto('eq', { hpFreq: 26, lowGain: 2, lowFreq: 55, midGain: -2, midFreq: 350,
              midQ: 0.9, highGain: -2, highFreq: 8000, lpFreq: 15000 }),
            limitador(5),
          ],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 156) * SR),
      };
    }, { subcategory: 'techno', bpm: 156, keyRoot: 'G' }),

  // ── Loops melódicos (4 compases exactos, para montar encima) ───────────────
  spec('melodic-loops/warehouse-134-am', 'Warehouse 134 Am', 'melodic-loops',
    ['techno', 'hardgroove', 'loop', 'bass', 'stab', 'menor'], 0.7, () => {
      // El bajo entra en el 16º de ANTES del pulso, que es donde lo midió la
      // referencia A: así empuja al bombo en vez de taparlo.
      const raiz = [N.A1, N.A1, N.G1, N.E2 - 12];
      const acordes: number[][] = [
        [57, 60, 64],
        [57, 60, 64],
        [55, 59, 62],
        [52, 55, 59],
      ];
      const events: CompiledNoteEvent[] = [];
      for (let b = 0; b < 16; b++) {
        const compas = Math.floor(b / 4);
        events.push(nota(b + 0.75, 0.3, raiz[compas]!, { ch: 0, vel: 0.95 }));
        if (b % 4 === 0) events.push(nota(b, 0.35, raiz[compas]!, { ch: 0, vel: 1 }));
        else if (b % 2 === 0) events.push(nota(b + 0.25, 0.2, raiz[compas]!, { ch: 0, vel: 0.55 }));
      }
      for (let compas = 0; compas < 4; compas++) {
        for (const off of [0, 0.5, 1.5, 2.5, 3.5]) {
          for (const k of acordes[compas]!) {
            events.push(nota(compas * 4 + off, 0.3, k, { ch: 1, vel: off === 0 ? 0.9 : 0.68 }));
          }
        }
      }
      return {
        project: proyecto({
          tempo: 134,
          lengthBeats: 16,
          channels: [
            canal('sub808', { tune: 0, decay: 0.32, drive: 0.55, glide: 0.02, punch: 0.3,
              tone: 1200 }, { volume: 0.9 }),
            canal('supersaw', { detune: 0.35, blend: 0.8, cutoff: 3200, attack: 0.004,
              release: 0.3, width: 0.75, octave: 0 }, { volume: 0.6 }),
          ],
          events,
          masterSlots: [
            efecto('distortion', { drive: 0.2, tone: 4000, mode: 0, output: 0.9 }),
            efecto('reverb', { size: 0.5, damp: 0.45, width: 1, predelay: 0.008 }, 0.22),
            efecto('stereo', { width: 1.1, gain: 1, monoBelow: 110 }),
            limitador(3),
          ],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 134) * SR),
      };
    }, { bpm: 134, keyRoot: 'A' }),

  spec('melodic-loops/rave-156-bm', 'Rave 156 Bm', 'melodic-loops',
    ['rave', 'techno', 'loop', 'bass', 'rolling', 'menor'], 0.7, () => {
      // El grave rodando en 8º sobre Si menor: es la nota que midió la
      // referencia B en su sección de en medio (124 Hz = Si).
      const patron = [N.B1, N.B1, N.B1, N.D2, N.B1, N.B1, N.Fs1, N.B1];
      const events: CompiledNoteEvent[] = [];
      for (let compas = 0; compas < 4; compas++) {
        patron.forEach((k, i) => {
          const nota8 = compas * 4 + i * 0.5;
          events.push(nota(nota8, 0.28, compas === 3 && i >= 6 ? k + 3 : k, {
            ch: 0,
            vel: i % 2 === 0 ? 0.95 : 0.7,
          }));
        });
        for (const off of [0, 2.5]) {
          for (const k of [59, 62, 66]) {
            events.push(nota(compas * 4 + off, 0.45, k, { ch: 1, vel: 0.7 }));
          }
        }
      }
      return {
        project: proyecto({
          tempo: 156,
          lengthBeats: 16,
          channels: [
            canal('sub808', { tune: 0, decay: 0.3, drive: 0.65, glide: 0.02, punch: 0.25,
              tone: 1500 }, { volume: 0.9 }),
            canal('supersaw', { detune: 0.7, blend: 0.95, cutoff: 2600, attack: 0.004,
              release: 0.2, width: 0.85, octave: 0 }, { volume: 0.5 }),
          ],
          events,
          masterSlots: [
            efecto('distortion', { drive: 0.3, tone: 3200, mode: 0, output: 0.85 }),
            efecto('reverb', { size: 0.5, damp: 0.5, width: 1, predelay: 0.006 }, 0.18),
            efecto('stereo', { width: 1.15, gain: 1, monoBelow: 110 }),
            limitador(3),
          ],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 156) * SR),
      };
    }, { bpm: 156, keyRoot: 'B' }),

  spec('melodic-loops/acid-134-am', 'Acid 134 Am', 'melodic-loops',
    ['techno', 'acid', 'loop', 'riff', 'menor'], 0.7, () => {
      // Línea acid en 16º sobre La menor. El acento no es más volumen: es la
      // envolvente abriendo el filtro, que es de donde sale el "miau".
      const base = [45, 45, 57, 45, 48, 45, 60, 52, 45, 57, 45, 52, 55, 48, 52, 45];
      const variante = [45, 45, 57, 45, 48, 45, 60, 52, 50, 62, 50, 57, 55, 52, 48, 45];
      const events: CompiledNoteEvent[] = [];
      for (let compas = 0; compas < 4; compas++) {
        const patron = compas === 3 ? variante : base;
        patron.forEach((k, i) => {
          events.push(nota(compas * 4 + i * 0.25, 0.2, k, { vel: i % 4 === 0 ? 1 : 0.62 }));
        });
      }
      return {
        project: proyecto({
          tempo: 134,
          lengthBeats: 16,
          channels: [
            canal('synth', { wave: 0, cutoff: 480, resonance: 0.86, envAmount: 0.85,
              attack: 0.001, decay: 0.16, sustain: 0.08, release: 0.06, unison: 1,
              detune: 0, octave: 0 }, { volume: 0.7 }),
          ],
          events,
          masterSlots: [
            efecto('distortion', { drive: 0.42, tone: 5000, mode: 0, output: 0.85 }),
            efecto('delay', { time: 1, feedback: 0.28, pingpong: 1, filter: 3500 }, 0.18),
            efecto('reverb', { size: 0.4, damp: 0.5, width: 1, predelay: 0 }, 0.12),
            limitador(3),
          ],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 134) * SR),
      };
    }, { bpm: 134, keyRoot: 'A' }),

  spec('melodic-loops/hoover-156-am', 'Hoover 156 Am', 'melodic-loops',
    ['rave', 'loop', 'hoover', 'stab', 'supersaw', 'menor'], 0.7, () => {
      const events: CompiledNoteEvent[] = [];
      const acordes: number[][] = [
        [45, 57, 60],
        [45, 57, 60],
        [43, 55, 58],
        [40, 52, 55],
      ];
      for (let compas = 0; compas < 4; compas++) {
        for (const off of [0, 1.5, 2.5]) {
          for (const k of acordes[compas]!) {
            events.push(nota(compas * 4 + off, 0.7, k, { vel: off === 0 ? 0.95 : 0.7 }));
          }
        }
      }
      // La caída de altura del hoover, una por pulso: la rueda baja de +5 a 0
      // en medio pulso y se queda ahí hasta el siguiente.
      const bend: number[] = [];
      for (let b = 0; b < 16; b++) bend.push(5, 2.6, 1.1, 0.3, 0, 0, 0, 0);
      bend.push(0);
      return {
        project: proyecto({
          tempo: 156,
          lengthBeats: 16,
          channels: [
            canal('supersaw', { detune: 0.85, blend: 1, cutoff: 3000, attack: 0.003,
              release: 0.22, width: 0.85, octave: 0 }, { volume: 0.62 }),
          ],
          events,
          masterSlots: [
            efecto('phaser', { rate: 0.5, depth: 0.65, stages: 6, feedback: 0.4 }, 0.45),
            efecto('distortion', { drive: 0.3, tone: 4000, mode: 0, output: 0.9 }),
            efecto('reverb', { size: 0.5, damp: 0.45, width: 1, predelay: 0.008 }, 0.18),
            limitador(3),
          ],
          automation: [autoBend(0, bend)],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 156) * SR),
      };
    }, { bpm: 156, keyRoot: 'A' }),
];

// ── Main ─────────────────────────────────────────────────────────────────────

/** `--out <dir>`: dónde dejar el pack. Sin él, la carpeta de packs de la app. */
function destino(): string {
  const i = process.argv.indexOf('--out');
  if (i >= 0 && process.argv[i + 1] !== undefined) return path.resolve(process.argv[i + 1]!);
  return path.join(carpetaDePacks(), PACK_SLUG);
}

export type { SonidoSpec };

function main(): void {
  const dir = destino();
  console.log(`Generando el pack "${PACK_NAME}" en ${dir}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const entries: SoundEntry[] = [];
  const porCategoria = new Map<SoundCategory, number>();
  /** Segundos de silencio con los que arranca cada loop (ver verificación). */
  const arranqueDeLoop = new Map<string, number>();
  let totalBytes = 0;

  SPECS.forEach((s, i) => {
    const { project, tail, exactSamples, maxSec } = s.build();
    const r = renderProject(project, { sampleRate: SR, tailSeconds: tail });
    let l = r.left;
    let rr = r.right;

    if (exactSamples !== undefined) {
      if (l.length < exactSamples) {
        throw new Error(`${s.id}: el render (${l.length}) es más corto que el loop (${exactSamples})`);
      }
      l = l.slice(0, exactSamples);
      rr = rr.slice(0, exactSamples);
      normalizar(l, rr, -1);
    } else {
      normalizar(l, rr, -1);
      [l, rr] = recortarCola(l, rr, SR, -60, 0.05);
      if (maxSec !== undefined && l.length > maxSec * SR) {
        const n = Math.round(maxSec * SR);
        l = l.slice(0, n);
        rr = rr.slice(0, n);
      }
    }
    fadeOut(l, rr, SR, 5);

    if (exactSamples !== undefined) {
      const umbral = Math.pow(10, -50 / 20);
      let i0 = 0;
      while (i0 < l.length && Math.abs(l[i0]!) < umbral && Math.abs(rr[i0]!) < umbral) i0++;
      arranqueDeLoop.set(s.id, i0 / SR);
    }

    const mono = esMono(l, rr);
    const wav = mono ? encodeWavMono(l, SR) : encodeWav(l, rr, SR, 16);
    const ruta = path.join(dir, s.file);
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, wav);
    totalBytes += wav.length;
    porCategoria.set(s.category, (porCategoria.get(s.category) ?? 0) + 1);

    const durationSec = Math.round((l.length / SR) * 1000) / 1000;
    const entry: SoundEntry = {
      id: s.id,
      name: s.name,
      category: s.category,
      file: s.file,
      tags: s.tags,
      durationSec,
      gainSuggestion: s.gainSuggestion,
    };
    if (s.subcategory !== undefined) entry.subcategory = s.subcategory;
    if (s.keyRoot !== undefined) entry.keyRoot = s.keyRoot;
    if (s.bpm !== undefined) entry.bpm = s.bpm;
    entries.push(entry);

    console.log(
      `[${String(i + 1).padStart(2)}/${SPECS.length}] ${s.file.padEnd(36)} ` +
      `${durationSec.toFixed(2)}s ${(wav.length / 1024).toFixed(0).padStart(5)} KB ` +
      `${mono ? 'mono' : 'stereo'}`,
    );
  });

  const manifest: SoundManifest = {
    version: '1.0.0',
    pack: PACK_NAME,
    generatedWith: '@orbit/sound-library warehouse.ts — @orbit/engine renderProject (síntesis determinista)',
    entries,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifestJson, 'utf8');
  totalBytes += Buffer.byteLength(manifestJson);

  // ── Verificación ───────────────────────────────────────────────────────────
  // Lo mismo que comprueba el generador de fábrica, más los dos topes que
  // impone `pack:save` en el main de Electron: si el pack no cabe por ahí, no
  // se puede instalar, y eso hay que saberlo AQUÍ y no al copiarlo.
  const cargado = loadManifest(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  for (const [id, arranque] of arranqueDeLoop) {
    if (arranque > 0.02) {
      throw new Error(`"${id}": el loop empieza con ${(arranque * 1000).toFixed(0)} ms de silencio`);
    }
  }
  const picoPorCategoria = new Map<SoundCategory, number>();
  let archivos = 1; // el manifest
  for (const e of cargado.entries) {
    const ruta = path.join(dir, e.file);
    if (!fs.existsSync(ruta)) throw new Error(`Falta el fichero ${e.file}`);
    archivos++;
    const db = picoDeWavDb(fs.readFileSync(ruta));
    picoPorCategoria.set(e.category, Math.max(picoPorCategoria.get(e.category) ?? -Infinity, db));
  }

  console.log('\nResumen por categoría:');
  for (const [cat, n] of porCategoria) {
    const db = picoPorCategoria.get(cat) ?? -Infinity;
    console.log(`  ${cat.padEnd(16)} ${String(n).padStart(2)} sonidos · pico máx ${db.toFixed(1)} dBFS`);
    if (db <= -20) throw new Error(`Categoría ${cat}: ningún WAV supera -20 dBFS`);
  }
  if (archivos > MAX_ARCHIVOS) {
    throw new Error(`${archivos} archivos: pack:save no admite más de ${MAX_ARCHIVOS}`);
  }
  if (totalBytes > MAX_BYTES) {
    throw new Error(`${(totalBytes / 1024 / 1024).toFixed(2)} MB: pack:save no admite más de 64 MB`);
  }
  console.log(
    `\nTotal: ${cargado.entries.length} sonidos · ${archivos} archivos · ` +
    `${(totalBytes / 1024 / 1024).toFixed(2)} MB de ${MAX_BYTES / 1024 / 1024} · ` +
    `${MAX_ARCHIVOS - archivos} archivos de margen`,
  );
  console.log('Pack generado y verificado.');
}

// Solo cuando se EJECUTA el script. Importarlo (el test del plan) no debe
// escribir 15 MB en la carpeta de packs de nadie.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]).endsWith('warehouse.ts')) {
  main();
}
