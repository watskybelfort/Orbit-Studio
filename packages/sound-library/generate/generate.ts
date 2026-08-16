/**
 * Generador del pack de fábrica "Orbit Essentials".
 *
 * Ejecutar desde la raíz del repo:
 *   npx tsx packages/sound-library/generate/generate.ts
 *
 * Renderiza cada sonido con el motor REAL (@orbit/engine → renderProject,
 * el mismo KernelCore que suena en vivo) a partir de CompiledProject mínimos
 * construidos a mano. Todo es determinista: el motor usa ruido seeded y aquí
 * no hay Math.random — cualquier variación sale de parámetros explícitos.
 *
 * Salida: packages/sound-library/factory/ → WAVs 16-bit 44.1 kHz + manifest.json.
 * Los WAV van normalizados a -1 dBFS, con la cola recortada a -60 dB (+50 ms
 * de margen) y fade-out de 5 ms para evitar clicks. Cuando L==R bit a bit se
 * escribe WAV mono (mitad de tamaño, mismo sonido).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const PACK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'factory');

/** Contador global: única fuente de "variación" (ids estables por orden). */
let contador = 0;

// ── Constructores de proyecto mínimo ─────────────────────────────────────────

function canal(
  kind: InstrumentKind,
  params: Record<string, number>,
  volume = 0.8,
): CompiledChannel {
  return {
    id: `ch-${contador++}`,
    kind,
    params,
    volume,
    pan: 0,
    audible: true,
    mixerTrack: 0,
  };
}

function efecto(kind: EffectKind, params: Record<string, number>, mix = 1): CompiledEffect {
  return { id: `fx-${contador++}`, kind, enabled: true, mix, params };
}

function nota(
  start: number,
  duration: number,
  key: number,
  velocity = 0.9,
  slide = false,
): CompiledNoteEvent {
  return { start, duration, key, velocity, pan: 0, slide, channelIndex: 0 };
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
    mixer: [master],
    mixerOrder: [0],
  };
}

/** Rampa exponencial muestreada (para automatizar cutoff en los sweeps). */
function rampaExp(desde: number, hasta: number, beats: number, step = 0.25): number[] {
  const n = Math.max(1, Math.ceil(beats / step));
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(desde * Math.pow(hasta / desde, i / n));
  return out;
}

// ── Post-procesado ───────────────────────────────────────────────────────────

function pico(l: Float32Array, r: Float32Array): number {
  let p = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]!);
    const b = Math.abs(r[i]!);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

/** Normaliza in-place al pico objetivo (dBFS). */
function normalizar(l: Float32Array, r: Float32Array, objetivoDb = -1): void {
  const p = pico(l, r);
  if (p <= 1e-6) throw new Error('Render en silencio: no se puede normalizar');
  const g = Math.pow(10, objetivoDb / 20) / p;
  for (let i = 0; i < l.length; i++) {
    l[i] = l[i]! * g;
    r[i] = r[i]! * g;
  }
}

/** Recorta el silencio final bajo el umbral, dejando margen. */
function recortarCola(
  l: Float32Array,
  r: Float32Array,
  umbralDb = -60,
  margenSec = 0.05,
): [Float32Array, Float32Array] {
  const umbral = Math.pow(10, umbralDb / 20);
  let ultimo = -1;
  for (let i = l.length - 1; i >= 0; i--) {
    if (Math.abs(l[i]!) > umbral || Math.abs(r[i]!) > umbral) {
      ultimo = i;
      break;
    }
  }
  if (ultimo < 0) throw new Error('Render bajo el umbral de recorte en toda su duración');
  const fin = Math.min(l.length, ultimo + 1 + Math.round(margenSec * SR));
  return [l.slice(0, fin), r.slice(0, fin)];
}

/** Fade-out lineal de `ms` al final (anti-click). */
function fadeOut(l: Float32Array, r: Float32Array, ms = 5): void {
  const n = Math.min(l.length, Math.round((ms / 1000) * SR));
  const desde = l.length - n;
  for (let i = 0; i < n; i++) {
    const g = 1 - (i + 1) / n;
    l[desde + i] = l[desde + i]! * g;
    r[desde + i] = r[desde + i]! * g;
  }
}

/**
 * ¿Contenido mono? El paneo del kernel usa cos/sin(π/4), que difieren en
 * 1 ulp, así que se compara con tolerancia (-100 dB), no bit a bit.
 */
function esMono(l: Float32Array, r: Float32Array): boolean {
  for (let i = 0; i < l.length; i++) {
    if (Math.abs(l[i]! - r[i]!) > 1e-5) return false;
  }
  return true;
}

/** Mezcla L/R a un solo canal (para escribir WAV mono). */
function aMono(l: Float32Array, r: Float32Array): Float32Array {
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = (l[i]! + r[i]!) * 0.5;
  return out;
}

/** WAV 16-bit mono (el encoder del engine solo hace estéreo). */
function encodeWavMono(x: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = x.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < x.length; i++) {
    v.setInt16(off, Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), true);
    off += 2;
  }
  return new Uint8Array(buf);
}

// ── Especificación de sonidos ────────────────────────────────────────────────

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
  /** Proyecto a renderizar y opciones de post. */
  build: () => {
    project: CompiledProject;
    tail: number;
    /** Loops: corte exacto a N samples (sin recorte por umbral). */
    exactSamples?: number;
    /** Tope duro de duración (colas de reverb largas). */
    maxSec?: number;
  };
}

// Teclas del DRUM_MAP (packages/core/src/model/params.ts)
const K = { kick: 36, rim: 37, snare: 38, clap: 39, hat: 42, tom: 45, openhat: 46, conga: 48, crash: 49, shaker: 70 } as const;

/** One-shot de batería: canal 'drums' con kit y variación de params. */
function golpe(
  kit: number,
  key: number,
  p: { tone?: number; decay?: number; punch?: number },
  masterSlots?: CompiledEffect[],
  tail = 0.5,
  maxSec?: number,
): SonidoSpec['build'] {
  return () => {
    const out: ReturnType<SonidoSpec['build']> = {
      project: proyecto({
        tempo: 120,
        lengthBeats: 8, // 4 s: cubre el ring más largo (crash) sin note-off prematuro
        channels: [canal('drums', { kit, tone: p.tone ?? 0.5, decay: p.decay ?? 1, punch: p.punch ?? 0.5 })],
        events: [nota(0, 8, key, 1)],
        ...(masterSlots ? { masterSlots } : {}),
      }),
      tail,
    };
    if (maxSec !== undefined) out.maxSec = maxSec;
    return out;
  };
}

/** One-shot de 808: nota sostenida `hold` beats a 120 BPM. */
function sub(
  key: number,
  p: { decay: number; drive: number; tone?: number; punch?: number },
  hold: number,
): SonidoSpec['build'] {
  return () => ({
    project: proyecto({
      tempo: 120,
      lengthBeats: Math.ceil(hold) + 2,
      channels: [
        canal('sub808', {
          tune: 0,
          decay: p.decay,
          drive: p.drive,
          glide: 0.05,
          punch: p.punch ?? 0.35,
          tone: p.tone ?? 750,
        }),
      ],
      events: [nota(0, hold, key, 1)],
    }),
    tail: 1,
    maxSec: 3,
  });
}

/** Entrada declarativa compacta. */
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

// MIDI estándar (60 = do central): C1=24, D#1=27, F1=29, G1=31, A#1=34.
const SPECS: SonidoSpec[] = [
  // ── drums/trap (kit 0) ─────────────────────────────────────────────────────
  spec('drums/trap/kick-01', 'Kick Trap 01', 'drums', ['trap', 'kick', 'punchy', 'hard'], 0.9,
    golpe(0, K.kick, { tone: 0.25, decay: 0.9, punch: 0.85 }), { subcategory: 'trap' }),
  spec('drums/trap/kick-02', 'Kick Trap 02', 'drums', ['trap', 'kick', 'deep', 'long'], 0.9,
    golpe(0, K.kick, { tone: 0.6, decay: 1.5, punch: 0.45 }), { subcategory: 'trap' }),
  spec('drums/trap/kick-03', 'Kick Trap 03', 'drums', ['trap', 'kick', 'tight', 'short'], 0.9,
    golpe(0, K.kick, { tone: 0.4, decay: 0.55, punch: 0.7 }), { subcategory: 'trap' }),
  spec('drums/trap/snare-01', 'Snare Trap 01', 'drums', ['trap', 'snare', 'sharp'], 0.85,
    golpe(0, K.snare, { tone: 0.35, decay: 1, punch: 0.5 }), { subcategory: 'trap' }),
  spec('drums/trap/snare-02', 'Snare Trap 02', 'drums', ['trap', 'snare', 'bright', 'long'], 0.85,
    golpe(0, K.snare, { tone: 0.75, decay: 1.4, punch: 0.5 }), { subcategory: 'trap' }),
  spec('drums/trap/clap-01', 'Clap Trap 01', 'drums', ['trap', 'clap', 'tight'], 0.85,
    golpe(0, K.clap, { decay: 0.9 }), { subcategory: 'trap' }),
  spec('drums/trap/clap-02', 'Clap Trap 02', 'drums', ['trap', 'clap', 'long'], 0.85,
    golpe(0, K.clap, { decay: 1.5 }), { subcategory: 'trap' }),
  spec('drums/trap/hat-01', 'Hat Trap 01', 'drums', ['trap', 'hat', 'short'], 0.55,
    golpe(0, K.hat, { tone: 0.4, decay: 0.8 }), { subcategory: 'trap' }),
  spec('drums/trap/hat-02', 'Hat Trap 02', 'drums', ['trap', 'hat', 'bright'], 0.55,
    golpe(0, K.hat, { tone: 0.85, decay: 1 }), { subcategory: 'trap' }),
  spec('drums/trap/hat-03', 'Hat Trap 03', 'drums', ['trap', 'hat', 'dark', 'long'], 0.55,
    golpe(0, K.hat, { tone: 0.15, decay: 1.3 }), { subcategory: 'trap' }),
  spec('drums/trap/openhat-01', 'Open Hat Trap 01', 'drums', ['trap', 'openhat'], 0.6,
    golpe(0, K.openhat, { tone: 0.5, decay: 1 }), { subcategory: 'trap' }),
  spec('drums/trap/openhat-02', 'Open Hat Trap 02', 'drums', ['trap', 'openhat', 'long'], 0.6,
    golpe(0, K.openhat, { tone: 0.7, decay: 1.6 }), { subcategory: 'trap' }),
  spec('drums/trap/rim-01', 'Rim Trap 01', 'drums', ['trap', 'rim', 'short'], 0.6,
    golpe(0, K.rim, { tone: 0.5, decay: 1 }), { subcategory: 'trap' }),
  spec('drums/trap/tom-01', 'Tom Trap 01', 'drums', ['trap', 'tom', 'low'], 0.8,
    golpe(0, K.tom, { tone: 0.35, decay: 1 }), { subcategory: 'trap' }),
  spec('drums/trap/tom-02', 'Tom Trap 02', 'drums', ['trap', 'tom', 'high'], 0.8,
    golpe(0, K.tom, { tone: 0.75, decay: 0.9 }), { subcategory: 'trap' }),
  spec('drums/trap/crash-01', 'Crash Trap 01', 'drums', ['trap', 'crash', 'long'], 0.65,
    golpe(0, K.crash, { tone: 0.5, decay: 0.85 }), { subcategory: 'trap' }),

  // ── drums/boombap (kit 1) ──────────────────────────────────────────────────
  spec('drums/boombap/kick-01', 'Kick Boom Bap 01', 'drums', ['boombap', 'kick', 'punchy'], 0.9,
    golpe(1, K.kick, { tone: 0.5, decay: 1, punch: 0.6 }), { subcategory: 'boombap' }),
  spec('drums/boombap/kick-02', 'Kick Boom Bap 02', 'drums', ['boombap', 'kick', 'soft', 'round'], 0.9,
    golpe(1, K.kick, { tone: 0.5, decay: 1.4, punch: 0.3 }), { subcategory: 'boombap' }),
  spec('drums/boombap/snare-01', 'Snare Boom Bap 01', 'drums', ['boombap', 'snare', 'dusty'], 0.85,
    golpe(1, K.snare, { tone: 0.45, decay: 0.9, punch: 0.5 }), { subcategory: 'boombap' }),
  spec('drums/boombap/snare-02', 'Snare Boom Bap 02', 'drums', ['boombap', 'snare', 'bright'], 0.85,
    golpe(1, K.snare, { tone: 0.7, decay: 1.2, punch: 0.5 }), { subcategory: 'boombap' }),
  spec('drums/boombap/hat-01', 'Hat Boom Bap 01', 'drums', ['boombap', 'hat', 'short'], 0.55,
    golpe(1, K.hat, { tone: 0.5, decay: 0.9 }), { subcategory: 'boombap' }),
  spec('drums/boombap/hat-02', 'Hat Boom Bap 02', 'drums', ['boombap', 'hat', 'crisp'], 0.55,
    golpe(1, K.hat, { tone: 0.85, decay: 0.7 }), { subcategory: 'boombap' }),
  spec('drums/boombap/openhat-01', 'Open Hat Boom Bap 01', 'drums', ['boombap', 'openhat'], 0.6,
    golpe(1, K.openhat, { tone: 0.5, decay: 1.2 }), { subcategory: 'boombap' }),
  spec('drums/boombap/rim-01', 'Rim Boom Bap 01', 'drums', ['boombap', 'rim', 'short'], 0.6,
    golpe(1, K.rim, { tone: 0.5, decay: 0.7 }), { subcategory: 'boombap' }),
  spec('drums/boombap/crash-01', 'Crash Boom Bap 01', 'drums', ['boombap', 'crash'], 0.65,
    golpe(1, K.crash, { tone: 0.4, decay: 0.75 }), { subcategory: 'boombap' }),

  // ── percusion-latina (kit 2) ───────────────────────────────────────────────
  spec('percusion-latina/conga-01', 'Conga Baja', 'percusion-latina', ['latin', 'conga', 'low'], 0.8,
    golpe(2, K.conga, { tone: 0.2, decay: 1 })),
  spec('percusion-latina/conga-02', 'Conga Media', 'percusion-latina', ['latin', 'conga', 'mid'], 0.8,
    golpe(2, K.conga, { tone: 0.5, decay: 1 })),
  spec('percusion-latina/conga-03', 'Conga Alta', 'percusion-latina', ['latin', 'conga', 'high'], 0.8,
    golpe(2, K.conga, { tone: 0.8, decay: 1 })),
  spec('percusion-latina/conga-04', 'Conga Slap', 'percusion-latina', ['latin', 'conga', 'slap', 'short'], 0.8,
    golpe(2, K.conga, { tone: 0.95, decay: 0.6 })),
  spec('percusion-latina/rim-01', 'Clave 01', 'percusion-latina', ['latin', 'rim', 'clave'], 0.6,
    golpe(2, K.rim, { tone: 0.5, decay: 1 })),
  spec('percusion-latina/rim-02', 'Clave 02', 'percusion-latina', ['latin', 'rim', 'clave', 'short'], 0.6,
    golpe(2, K.rim, { tone: 0.5, decay: 0.6 })),
  spec('percusion-latina/shaker-01', 'Shaker 01', 'percusion-latina', ['latin', 'shaker', 'short'], 0.55,
    golpe(2, K.shaker, { decay: 0.8 })),
  spec('percusion-latina/shaker-02', 'Shaker 02', 'percusion-latina', ['latin', 'shaker'], 0.55,
    golpe(2, K.shaker, { decay: 1.2 })),
  spec('percusion-latina/shaker-03', 'Shaker 03', 'percusion-latina', ['latin', 'shaker', 'long'], 0.55,
    golpe(2, K.shaker, { decay: 1.6 })),
  spec('percusion-latina/tom-01', 'Timbal Bajo', 'percusion-latina', ['latin', 'tom', 'low'], 0.8,
    golpe(2, K.tom, { tone: 0.3, decay: 1 })),
  spec('percusion-latina/tom-02', 'Timbal Medio', 'percusion-latina', ['latin', 'tom', 'mid'], 0.8,
    golpe(2, K.tom, { tone: 0.6, decay: 0.9 })),
  spec('percusion-latina/tom-03', 'Timbal Alto', 'percusion-latina', ['latin', 'tom', 'high', 'short'], 0.8,
    golpe(2, K.tom, { tone: 0.9, decay: 0.8 })),

  // ── 808s (sub808, notas C1..B1; long/short y drive suave/duro) ────────────
  spec('808s/808-C-long', '808 C long', '808s', ['808', 'sub', 'trap', 'long', 'soft'], 0.9,
    sub(24, { decay: 1.7, drive: 0.35 }, 5), { keyRoot: 'C' }),
  spec('808s/808-C-short', '808 C short', '808s', ['808', 'sub', 'trap', 'short', 'hard'], 0.9,
    sub(24, { decay: 0.7, drive: 0.7 }, 3), { keyRoot: 'C' }),
  spec('808s/808-C-hard', '808 C hard', '808s', ['808', 'sub', 'trap', 'long', 'hard', 'distorted'], 0.9,
    sub(24, { decay: 1.5, drive: 0.95, tone: 1600 }, 5), { keyRoot: 'C' }),
  spec('808s/808-Ds-long', '808 D# long', '808s', ['808', 'sub', 'trap', 'long', 'soft'], 0.9,
    sub(27, { decay: 1.7, drive: 0.35 }, 5), { keyRoot: 'D#' }),
  spec('808s/808-Ds-short', '808 D# short', '808s', ['808', 'sub', 'trap', 'short', 'hard'], 0.9,
    sub(27, { decay: 0.7, drive: 0.7 }, 3), { keyRoot: 'D#' }),
  spec('808s/808-F-long', '808 F long', '808s', ['808', 'sub', 'trap', 'long', 'soft'], 0.9,
    sub(29, { decay: 1.7, drive: 0.35 }, 5), { keyRoot: 'F' }),
  spec('808s/808-F-short', '808 F short', '808s', ['808', 'sub', 'trap', 'short', 'hard'], 0.9,
    sub(29, { decay: 0.7, drive: 0.7 }, 3), { keyRoot: 'F' }),
  spec('808s/808-F-hard', '808 F hard', '808s', ['808', 'sub', 'trap', 'long', 'hard', 'distorted'], 0.9,
    sub(29, { decay: 1.5, drive: 0.95, tone: 1600 }, 5), { keyRoot: 'F' }),
  spec('808s/808-G-long', '808 G long', '808s', ['808', 'sub', 'trap', 'long', 'soft'], 0.9,
    sub(31, { decay: 1.7, drive: 0.35 }, 5), { keyRoot: 'G' }),
  spec('808s/808-G-short', '808 G short', '808s', ['808', 'sub', 'trap', 'short', 'hard'], 0.9,
    sub(31, { decay: 0.7, drive: 0.7 }, 3), { keyRoot: 'G' }),
  spec('808s/808-As-long', '808 A# long', '808s', ['808', 'sub', 'trap', 'long', 'soft'], 0.9,
    sub(34, { decay: 1.7, drive: 0.35 }, 5), { keyRoot: 'A#' }),
  spec('808s/808-As-short', '808 A# short', '808s', ['808', 'sub', 'trap', 'short', 'hard'], 0.9,
    sub(34, { decay: 0.7, drive: 0.7 }, 3), { keyRoot: 'A#' }),

  // ── fx ─────────────────────────────────────────────────────────────────────
  spec('fx/impact-01', 'Impact 01', 'fx', ['fx', 'impact', 'dark', 'reverb'], 0.8,
    golpe(0, K.kick, { tone: 0.15, decay: 1.6, punch: 0.9 },
      [efecto('reverb', { size: 0.85, damp: 0.3, width: 1, predelay: 0 }, 1)], 3.5, 3)),
  spec('fx/impact-02', 'Impact 02', 'fx', ['fx', 'impact', 'tight', 'reverb'], 0.8,
    golpe(0, K.kick, { tone: 0.5, decay: 1.2, punch: 0.7 },
      [efecto('reverb', { size: 0.7, damp: 0.5, width: 1, predelay: 0 }, 1)], 3, 2.4)),
  spec('fx/crash-reverb-01', 'Crash Reverb', 'fx', ['fx', 'crash', 'reverb', 'wash', 'long'], 0.7,
    golpe(0, K.crash, { tone: 0.5, decay: 0.9 },
      [efecto('reverb', { size: 0.8, damp: 0.35, width: 1, predelay: 0.01 }, 0.55)], 3, 2.8)),
  spec('fx/sweep-up-01', 'Sweep Up', 'fx', ['fx', 'riser', 'sweep', 'up', 'supersaw'], 0.8, () => ({
    project: proyecto({
      tempo: 120,
      lengthBeats: 6, // 3 s de subida
      channels: [canal('supersaw', {
        detune: 0.6, blend: 0.85, cutoff: 14000, attack: 1.2, release: 0.3, width: 0.9, octave: 0,
      }, 0.85)],
      events: [nota(0, 5.8, 45, 1), nota(0, 5.8, 57, 0.8)], // A2 + A3
      masterSlots: [
        efecto('autofilter', { type: 0, cutoff: 250, resonance: 0.55, lfoRate: 0.05, lfoAmount: 0, envAmount: 0 }, 1),
        efecto('reverb', { size: 0.8, damp: 0.3, width: 1, predelay: 0 }, 0.35),
      ],
      // Rampa del cutoff del autofilter: 250 Hz → 9 kHz en 6 beats.
      automation: [{
        startBeat: 0,
        step: 0.25,
        values: rampaExp(250, 9000, 6),
        target: { scope: 'effect', trackIndex: 0, slotIndex: 0, key: 'cutoff' },
      }],
    }),
    tail: 1.5,
    maxSec: 3.4,
  })),
  spec('fx/sweep-down-01', 'Sweep Down', 'fx', ['fx', 'downlifter', 'sweep', 'down', 'supersaw'], 0.8, () => ({
    project: proyecto({
      tempo: 120,
      lengthBeats: 6,
      channels: [canal('supersaw', {
        detune: 0.6, blend: 0.85, cutoff: 14000, attack: 0.05, release: 0.4, width: 0.9, octave: 0,
      }, 0.85)],
      events: [nota(0, 5.8, 40, 1), nota(0, 5.8, 52, 0.8)], // E2 + E3
      masterSlots: [
        efecto('autofilter', { type: 0, cutoff: 9000, resonance: 0.55, lfoRate: 0.05, lfoAmount: 0, envAmount: 0 }, 1),
        efecto('reverb', { size: 0.8, damp: 0.3, width: 1, predelay: 0 }, 0.35),
      ],
      automation: [{
        startBeat: 0,
        step: 0.25,
        values: rampaExp(9000, 250, 6),
        target: { scope: 'effect', trackIndex: 0, slotIndex: 0, key: 'cutoff' },
      }],
    }),
    tail: 1.5,
    maxSec: 3.4,
  })),
  spec('fx/subdrop-01', 'Sub Drop', 'fx', ['fx', 'subdrop', '808', 'glide', 'dark'], 0.85, () => ({
    project: proyecto({
      tempo: 120,
      lengthBeats: 8,
      channels: [canal('sub808', { tune: 0, decay: 2.2, drive: 0.5, glide: 0.5, punch: 0.15, tone: 650 })],
      // G2 cae con glide a C1 (nota slide reutiliza la voz activa).
      events: [nota(0, 0.75, 43, 1), nota(0.75, 5.25, 24, 1, true)],
    }),
    tail: 0.8,
    maxSec: 3.2,
  })),
  spec('fx/zap-01', 'Zap FM', 'fx', ['fx', 'zap', 'laser', 'fm', 'short'], 0.75, () => ({
    project: proyecto({
      tempo: 120,
      lengthBeats: 4,
      channels: [canal('fm', {
        ratio: 6.5, index: 7, indexDecay: 0.09, attack: 0.001, decay: 0.3, sustain: 0, release: 0.15, octave: 0,
      })],
      events: [nota(0, 1.5, 79, 1)], // G5
    }),
    tail: 0.5,
  })),

  // ── melodic-loops (4 compases exactos, composiciones originales) ──────────
  spec('melodic-loops/trap-140-fm', 'Trap Loop 140 Fm', 'melodic-loops',
    ['trap', 'loop', 'supersaw', 'dark', 'menor', 'chords'], 0.7, () => {
      // i–VI–III–VII en Fa menor, un acorde por compás.
      const acordes: [number, number[]][] = [
        [0, [53, 56, 60]],   // Fm
        [4, [49, 53, 56]],   // Db
        [8, [44, 48, 51]],   // Ab
        [12, [51, 55, 58]],  // Eb
      ];
      const events = acordes.flatMap(([inicio, keys]) =>
        keys.map((k) => nota(inicio, 3.4, k, 0.85)));
      return {
        project: proyecto({
          tempo: 140,
          lengthBeats: 16,
          channels: [canal('supersaw', {
            detune: 0.5, blend: 0.8, cutoff: 2200, attack: 0.02, release: 0.25, width: 0.85, octave: 0,
          }, 0.7)],
          events,
          masterSlots: [efecto('reverb', { size: 0.5, damp: 0.45, width: 1, predelay: 0.01 }, 0.18)],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 140) * SR),
      };
    }, { bpm: 140, keyRoot: 'F' }),

  spec('melodic-loops/boombap-90-cm', 'Boom Bap Loop 90 Cm', 'melodic-loops',
    ['boombap', 'loop', 'fm', 'keys', 'soul', 'menor'], 0.7, () => {
      // Motivo de teclas FM en Do menor: melodía + raíz grave por compás.
      const melodia: [number, number, number][] = [
        [0, 1.5, 60], [1.5, 0.5, 63], [2, 1.8, 67],
        [4, 1, 58], [5, 1, 60], [6, 1.8, 63],
        [8, 1.5, 56], [9.5, 0.5, 60], [10, 1.8, 65],
        [12, 1, 55], [13, 1, 59], [14, 1.5, 62],
      ];
      const bajos: [number, number][] = [[0, 48], [4, 46], [8, 44], [12, 43]];
      const events = [
        ...melodia.map(([s, d, k]) => nota(s, d, k, 0.9)),
        ...bajos.map(([s, k]) => nota(s, 3.5, k, 0.7)),
      ];
      return {
        project: proyecto({
          tempo: 90,
          lengthBeats: 16,
          channels: [canal('fm', {
            ratio: 2, index: 2.4, indexDecay: 0.3, attack: 0.004, decay: 1.3, sustain: 0, release: 0.3, octave: 0,
          }, 0.75)],
          events,
          masterSlots: [efecto('reverb', { size: 0.6, damp: 0.4, width: 1, predelay: 0.015 }, 0.22)],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 90) * SR),
      };
    }, { bpm: 90, keyRoot: 'C' }),

  spec('melodic-loops/reggaeton-100-am', 'Reggaeton Loop 100 Am', 'melodic-loops',
    ['reggaeton', 'dembow', 'loop', 'pluck', 'menor'], 0.7, () => {
      // Stabs de acorde sobre el patrón dembow: Am–F–Dm–E.
      const barras: number[][] = [
        [57, 60, 64], // Am
        [53, 57, 60], // F
        [50, 53, 57], // Dm
        [52, 56, 59], // E
      ];
      const golpes: [number, number][] = [[0, 0.9], [0.75, 0.75], [1.5, 0.85], [2, 0.9], [2.75, 0.75], [3.5, 0.8]];
      const events: CompiledNoteEvent[] = [];
      barras.forEach((keys, bar) => {
        for (const [off, vel] of golpes) {
          for (const k of keys) events.push(nota(bar * 4 + off, 0.35, k, vel));
        }
      });
      return {
        project: proyecto({
          tempo: 100,
          lengthBeats: 16,
          channels: [canal('supersaw', {
            detune: 0.35, blend: 0.75, cutoff: 4000, attack: 0.004, release: 0.15, width: 0.7, octave: 0,
          }, 0.7)],
          events,
          masterSlots: [efecto('reverb', { size: 0.45, damp: 0.5, width: 1, predelay: 0.01 }, 0.15)],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 100) * SR),
      };
    }, { bpm: 100, keyRoot: 'A' }),

  spec('melodic-loops/hardtek-174-em', 'Hardtek Loop 174 Em', 'melodic-loops',
    ['hardtek', 'acid', 'loop', 'riff', 'menor'], 0.7, () => {
      // Riff acid en Mi menor a 1/16; el compás 4 varía (derivado del índice, no random).
      const base = [40, 40, 52, 40, 43, 40, 55, 43, 40, 52, 40, 47, 50, 43, 47, 40];
      const variante = [40, 40, 52, 40, 43, 40, 55, 43, 45, 57, 45, 52, 50, 47, 43, 40];
      const events: CompiledNoteEvent[] = [];
      for (let bar = 0; bar < 4; bar++) {
        const patron = bar === 3 ? variante : base;
        patron.forEach((k, i) => {
          events.push(nota(bar * 4 + i * 0.25, 0.22, k, i % 4 === 0 ? 0.95 : 0.7));
        });
      }
      return {
        project: proyecto({
          tempo: 174,
          lengthBeats: 16,
          channels: [canal('synth', {
            wave: 0, cutoff: 750, resonance: 0.7, envAmount: 0.75, attack: 0.001,
            decay: 0.15, sustain: 0.1, release: 0.06, unison: 1, detune: 0, octave: 0,
          }, 0.75)],
          events,
          masterSlots: [efecto('reverb', { size: 0.35, damp: 0.5, width: 1, predelay: 0 }, 0.1)],
        }),
        tail: 0,
        exactSamples: Math.round(16 * (60 / 174) * SR),
      };
    }, { bpm: 174, keyRoot: 'E' }),
];

// ── Verificación: lee el pico real desde el WAV en disco ─────────────────────

function picoDeWavDb(buf: Buffer): number {
  const ascii = (off: number, n: number) => buf.toString('ascii', off, off + n);
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('No es un WAV RIFF');
  let off = 12;
  let bits = 16;
  let peak = 0;
  while (off + 8 <= buf.length) {
    const id = ascii(off, 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`Se esperaba 16-bit, hay ${bits}`);
      const fin = Math.min(buf.length, off + 8 + size);
      for (let i = off + 8; i + 1 < fin; i += 2) {
        const s = Math.abs(buf.readInt16LE(i)) / 32768;
        if (s > peak) peak = s;
      }
    }
    off += 8 + size + (size % 2);
  }
  return peak <= 0 ? -Infinity : 20 * Math.log10(peak);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log(`Generando pack "Orbit Essentials" en ${PACK_DIR}`);
  fs.rmSync(PACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(PACK_DIR, { recursive: true });

  const entries: SoundEntry[] = [];
  let totalBytes = 0;
  const porCategoria = new Map<SoundCategory, number>();

  SPECS.forEach((s, i) => {
    const { project, tail, exactSamples, maxSec } = s.build();
    const r = renderProject(project, { sampleRate: SR, tailSeconds: tail });
    let l = r.left;
    let rr = r.right;

    if (exactSamples !== undefined) {
      // Loop: duración exacta de 4 compases al BPM dado, sin cola.
      if (l.length < exactSamples) {
        throw new Error(`${s.id}: el render (${l.length}) es más corto que el loop (${exactSamples})`);
      }
      l = l.slice(0, exactSamples);
      rr = rr.slice(0, exactSamples);
      normalizar(l, rr, -1);
    } else {
      normalizar(l, rr, -1);
      [l, rr] = recortarCola(l, rr, -60, 0.05);
      if (maxSec !== undefined && l.length > maxSec * SR) {
        const n = Math.round(maxSec * SR);
        l = l.slice(0, n);
        rr = rr.slice(0, n);
      }
    }
    fadeOut(l, rr, 5);

    const mono = esMono(l, rr);
    const wav = mono ? encodeWavMono(l, SR) : encodeWav(l, rr, SR, 16);
    const ruta = path.join(PACK_DIR, s.file);
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
      `[${String(i + 1).padStart(2)}/${SPECS.length}] ${s.file.padEnd(40)} ` +
      `${durationSec.toFixed(2)}s ${(wav.length / 1024).toFixed(0).padStart(5)} KB ${mono ? 'mono' : 'stereo'}`,
    );
  });

  const manifest: SoundManifest = {
    version: '1.0.0',
    pack: 'Orbit Essentials',
    generatedWith: '@orbit/sound-library generate.ts — @orbit/engine renderProject (síntesis determinista)',
    entries,
  };
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(path.join(PACK_DIR, 'manifest.json'), manifestJson, 'utf8');
  totalBytes += Buffer.byteLength(manifestJson);

  // Verificación: manifest parseable + ficheros presentes + pico > -20 dBFS.
  const cargado = loadManifest(fs.readFileSync(path.join(PACK_DIR, 'manifest.json'), 'utf8'));
  const picoPorCategoria = new Map<SoundCategory, number>();
  for (const e of cargado.entries) {
    const ruta = path.join(PACK_DIR, e.file);
    if (!fs.existsSync(ruta)) throw new Error(`Falta el fichero ${e.file}`);
    const db = picoDeWavDb(fs.readFileSync(ruta));
    picoPorCategoria.set(e.category, Math.max(picoPorCategoria.get(e.category) ?? -Infinity, db));
  }

  console.log('\nResumen por categoría:');
  for (const [cat, n] of porCategoria) {
    const db = picoPorCategoria.get(cat) ?? -Infinity;
    console.log(`  ${cat.padEnd(18)} ${String(n).padStart(2)} sonidos · pico máx ${db.toFixed(1)} dBFS`);
    if (db <= -20) throw new Error(`Categoría ${cat}: ningún WAV supera -20 dBFS`);
  }
  console.log(`\nTotal: ${cargado.entries.length} sonidos · ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (totalBytes > 15 * 1024 * 1024) {
    throw new Error('El pack supera los 15 MB: recorta colas o duraciones');
  }
  console.log('Pack generado y verificado.');
}

main();
