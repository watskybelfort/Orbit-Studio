/**
 * Orbit Prisma v1: el instrumento grande de presets (capas, macros, rangos de
 * tecla y pool de cuerdas pulsadas).
 *
 * Lo que se vigila aquí es lo que rompería el motor de verdad:
 * - que un canal Prisma suene, y que un preset que no existe lo deje en el
 *   sinte básico en vez de dejarlo mudo;
 * - que dos renders del mismo proyecto den EXACTAMENTE el mismo audio (el
 *   motor usa hashes en vez de `Math.random()` justo para esto);
 * - que los nueve motores de capa den señal sin NaN ni infinitos;
 * - que las macros y los rangos de tecla manden sobre el sonido;
 * - que la envolvente TERMINE (nada de voces zombis sonando para siempre);
 * - y que las líneas de retardo prestadas al pool de la cuerda pulsada
 *   vuelvan siempre, mueran solas o las roben.
 *
 * Los tests no se atan a ningún preset concreto: el catálogo lo están
 * escribiendo a la vez, así que lo que se afirma vale para cualquiera.
 */

import { describe, expect, it } from 'vitest';
import {
  PRISMA_PRESETS,
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultInstrumentParams,
  newId,
  prismaPresetParams,
  type Note,
  type PrismaPreset,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import { renderProject } from '../src/render/offline';
import { Fft } from '../src/dsp/fft';
import {
  PrismaVoice,
  pluckLinesFree,
  type PrismaDef,
  type PrismaLayerDef,
} from '../src/dsp/prisma-voice';
import type { CompiledProject } from '../src/protocol';

const SR = 44100;

/** Motores de capa que entiende el kernel (espejo de PRISMA_ENGINES en core). */
const ENGINES = [
  'wt',
  'pulse',
  'noise',
  'fm',
  'pluck',
  'organ',
  'bell',
  'formant',
  'sub',
] as const;

/** Líneas libres del pool al cargar el archivo: nadie ha pedido nada todavía. */
const POOL_FULL = pluckLinesFree();

// ── Utilidades ───────────────────────────────────────────────────────────────

function note(start: number, duration: number, key: number, extra: Partial<Note> = {}): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false, ...extra };
}

/** Capa sintética con todos los campos puestos (espejo de `layer()` en core). */
function layerDef(engine: string, extra: Partial<PrismaLayerDef> = {}): PrismaLayerDef {
  return {
    engine,
    wave: 0.5,
    level: 1,
    pan: 0,
    semi: 0,
    fine: 0,
    attackMul: 1,
    decayMul: 1,
    releaseMul: 1,
    sustainAdd: 0,
    cutoffOct: 0,
    keyLo: 0,
    keyHi: 127,
    velTrack: 1,
    phase: 0,
    params: {},
    ...extra,
  };
}

/** Preset del catálogo → definición para el kernel (lo mismo que hace compile). */
function defOf(preset: PrismaPreset): PrismaDef {
  return {
    layers: preset.layers.map((l) => ({ ...l, params: { ...l.params } })),
    macros: preset.macros.map((m) => ({ targets: m.targets.map((t) => ({ ...t })) })),
  };
}

/** Perillas del canal: los defaults del instrumento con los retoques dados. */
function chanParams(patch: Record<string, number> = {}): Record<string, number> {
  return { ...defaultInstrumentParams('prisma'), ...patch };
}

/** ¿Suena este preset en esa tecla, según su ficha? */
function cubre(preset: PrismaPreset, key: number): boolean {
  return preset.layers.some((l) => l.level > 0 && key >= l.keyLo && key <= l.keyHi);
}

/**
 * Primer preset del catálogo que toca todas esas teclas. Los tests no se atan
 * a ningún id: el catálogo lo están escribiendo mientras esto corre.
 */
function presetFor(keys: number[]): PrismaPreset {
  const found = PRISMA_PRESETS.find((p) => keys.every((k) => cubre(p, k)));
  expect(found, `ningún preset del catálogo toca las teclas ${keys.join(', ')}`).toBeDefined();
  return found!;
}

interface VoiceRender {
  left: Float32Array;
  right: Float32Array;
  /** true si la voz seguía viva al acabar el render. */
  alive: boolean;
  /** Sample en el que devolvió false por primera vez (-1 si nunca). */
  diedAt: number;
}

/**
 * Renderiza UNA voz de Prisma en bloques de 128, como el kernel. Siempre
 * llama a `dispose()`: el pool de cuerdas es global al módulo y un test que
 * se deje una línea prestada le cambia el timbre al siguiente.
 */
function renderVoice(
  def: PrismaDef,
  params: Record<string, number>,
  key: number,
  opts: { seconds?: number; holdSeconds?: number; velocity?: number; order?: number } = {},
): VoiceRender {
  const seconds = opts.seconds ?? 0.25;
  const n = Math.round(seconds * SR);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const hold = Math.round((opts.holdSeconds ?? seconds) * SR);
  const voice = new PrismaVoice(
    0,
    key,
    opts.order ?? 0,
    opts.velocity ?? 0.9,
    params,
    { sr: SR, samples: new Map() },
    def,
  );
  let alive = true;
  let diedAt = -1;
  let released = false;
  try {
    for (let off = 0; off < n && alive; off += MAX_BLOCK) {
      if (!released && off >= hold) {
        voice.noteOff();
        released = true;
      }
      alive = voice.render(left, right, off, Math.min(n, off + MAX_BLOCK), 1, 1);
      if (!alive) diedAt = off;
    }
  } finally {
    voice.dispose();
  }
  return { left, right, alive, diedAt };
}

function peak(xs: Float32Array): number {
  let m = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = Math.abs(xs[i]!);
    if (a > m) m = a;
  }
  return m;
}

function rms(xs: Float32Array, from = 0, to = xs.length): number {
  let s = 0;
  const end = Math.min(to, xs.length);
  for (let i = from; i < end; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, end - from));
}

/**
 * Brillo relativo: energía de la diferencia de primer orden partida por la
 * energía de la señal. Sube con los agudos y no depende del volumen, así que
 * sirve para comparar dos ajustes de filtro.
 */
function brillo(xs: Float32Array): number {
  let d = 0;
  let e = 0;
  for (let i = 1; i < xs.length; i++) {
    const diff = xs[i]! - xs[i - 1]!;
    d += diff * diff;
    e += xs[i]! * xs[i]!;
  }
  return e > 0 ? d / e : 0;
}

/** Índice de la primera muestra no finita (-1 si están todas bien). */
function firstBadSample(xs: Float32Array): number {
  for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i]!)) return i;
  return -1;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer).equals(Buffer.from(b.buffer));
}

/** Proyecto de un canal Prisma tocando las teclas dadas. */
function prismaProject(opts: {
  presetId?: string;
  keys?: number[];
  params?: Record<string, number>;
  tempo?: number;
  duration?: number;
}): CompiledProject {
  const p = createEmptyProject('Prisma');
  p.tempo = opts.tempo ?? 240; // rápido: 4 beats = 1 s de render
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('prisma', 0, 'Prisma');
  ch.mixerTrack = 1;
  if (opts.presetId !== undefined) ch.prismaPreset = opts.presetId;
  Object.assign(ch.params, opts.params ?? {});
  applyCommand(p, { type: 'addChannel', channel: ch });
  const keys = opts.keys ?? [60];
  applyCommand(p, {
    type: 'addNotes',
    patternId,
    channelId: ch.id,
    notes: keys.map((k, i) => note(i * 0.5, opts.duration ?? 0.45, k)),
  });
  return compileProject(p, { mode: 'pattern', patternId });
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

// ── Canal, preset y determinismo ─────────────────────────────────────────────

describe('Orbit Prisma · canal y preset', () => {
  it('el preset del canal viaja compilado al kernel (capas y macros)', () => {
    const preset = presetFor([60]);
    const compiled = prismaProject({ presetId: preset.id });
    const prisma = compiled.channels[0]!.prisma;
    expect(prisma, `el preset ${preset.id} no llegó compilado al canal`).toBeDefined();
    expect(prisma!.layers.length).toBe(preset.layers.length);
    expect(prisma!.macros.length).toBe(preset.macros.length);
    // Copias, no el preset del catálogo: dos canales con el mismo sonido no
    // se pueden pisar las capas entre sí.
    expect(prisma!.layers[0]).not.toBe(preset.layers[0]);
  });

  it('un canal con preset suena, sin NaN y sin reventar el master', () => {
    const preset = presetFor([60, 64]);
    const res = renderProject(prismaProject({ presetId: preset.id, keys: [60, 64] }), {
      tailSeconds: 0.2,
    });
    expect(firstBadSample(res.left)).toBe(-1);
    expect(firstBadSample(res.right)).toBe(-1);
    expect(peak(res.left)).toBeGreaterThan(0.01);
    // El master no lleva limitador: un canal solo, a volumen de fábrica, no
    // puede salirse del techo él solito.
    expect(peak(res.left), `${preset.id} satura el master él solo`).toBeLessThanOrEqual(1);
  });

  it('un preset que no existe NO deja mudo el canal: cae al sinte básico', () => {
    const compiled = prismaProject({ presetId: 'no/existe-ni-existirá', keys: [60] });
    expect(compiled.channels[0]!.prisma).toBeUndefined();
    const res = renderProject(compiled, { tailSeconds: 0.1 });
    expect(rms(res.left)).toBeGreaterThan(0);
    expect(firstBadSample(res.left)).toBe(-1);
  });

  it('un preset SIN capas tampoco calla el canal', () => {
    // Caso raro pero posible (proyecto de otra versión): el kernel recibe una
    // definición vacía y tiene que caer al sinte básico igual.
    const c = prismaProject({ presetId: presetFor([60]).id, keys: [60] });
    c.channels[0]!.prisma = { layers: [], macros: [] };
    const res = renderProject(c, { tailSeconds: 0.1 });
    expect(rms(res.left)).toBeGreaterThan(0);
    expect(firstBadSample(res.left)).toBe(-1);
  });

  it('es determinista: dos renders del mismo proyecto dan el MISMO audio', () => {
    const id = presetFor([48, 60, 67]).id;
    const a = renderProject(prismaProject({ presetId: id, keys: [48, 60, 67] }), {
      tailSeconds: 0.3,
    });
    const b = renderProject(prismaProject({ presetId: id, keys: [48, 60, 67] }), {
      tailSeconds: 0.3,
    });
    expect(rms(a.left)).toBeGreaterThan(0);
    expect(sameBits(a.left, b.left), 'el canal izquierdo cambió entre dos renders iguales').toBe(
      true,
    );
    expect(sameBits(a.right, b.right), 'el canal derecho cambió entre dos renders iguales').toBe(
      true,
    );
  });

  /**
   * BUG (no arreglado aquí, ver informe): la perilla `voiceMode`
   * (Poly/Mono/Legato) existe en INSTRUMENT_PARAMS.prisma (params.ts:139) y 25
   * presets del catálogo la ponen a Mono o Legato —los bajos y los leads, que
   * es donde importa— pero NO la lee nadie: `grep voiceMode packages/engine`
   * no devuelve nada. El canal es siempre polifónico y solo hace glide en las
   * notas marcadas como slide.
   *
   * Repro: el mismo proyecto con voiceMode 0 y con voiceMode 1 da EXACTAMENTE
   * el mismo audio (dos notas encabalgadas suenan a la vez en los dos casos).
   */
  it('el modo Mono corta la voz anterior en vez de apilarla', () => {
    const id = presetFor([48]).id;
    const notas = { keys: [48, 48], duration: 1.5 };
    const poly = renderProject(prismaProject({ presetId: id, params: { voiceMode: 0 }, ...notas }), {
      tailSeconds: 0.2,
    });
    const mono = renderProject(prismaProject({ presetId: id, params: { voiceMode: 1 }, ...notas }), {
      tailSeconds: 0.2,
    });
    expect(rms(poly.left)).toBeGreaterThan(0);
    expect(sameBits(poly.left, mono.left), 'Modo Poly y Modo Mono suenan idénticos').toBe(false);
  });

  it('dos voces seguidas del mismo motor con fase aleatoria NO son iguales', () => {
    // `phase: -1` pide fase por hash del número de nota: la segunda voz tiene
    // que sonar distinta (ancho natural) pero de forma reproducible.
    const def: PrismaDef = { layers: [layerDef('wt', { phase: -1 })], macros: [] };
    const params = chanParams({ resonance: 0 });
    const a = renderVoice(def, params, 60, { order: 0, seconds: 0.1 });
    const b = renderVoice(def, params, 60, { order: 1, seconds: 0.1 });
    const a2 = renderVoice(def, params, 60, { order: 0, seconds: 0.1 });
    expect(maxDiff(a.left, b.left)).toBeGreaterThan(1e-4);
    expect(sameBits(a.left, a2.left), 'la misma nota no dio el mismo audio').toBe(true);
  });
});

// ── Motores de capa ──────────────────────────────────────────────────────────

describe('Orbit Prisma · los nueve motores de capa', () => {
  it.each(ENGINES)('el motor %s da señal y no saca NaN ni infinitos', (engine) => {
    const def: PrismaDef = { layers: [layerDef(engine)], macros: [] };
    const res = renderVoice(def, chanParams({ resonance: 0, sustain: 0.9 }), 57, {
      seconds: 0.3,
    });
    expect(firstBadSample(res.left), `muestra no finita en el motor ${engine}`).toBe(-1);
    expect(firstBadSample(res.right), `muestra no finita en el motor ${engine}`).toBe(-1);
    expect(peak(res.left), `el motor ${engine} no dio señal`).toBeGreaterThan(0.005);
    // Una capa sola no puede reventar el bus: el techo de la casa es 1.
    expect(peak(res.left), `el motor ${engine} se pasa de nivel`).toBeLessThan(2);
  });

  it.each(ENGINES)('el motor %s responde a `wave` (la perilla hace algo)', (engine) => {
    const params = chanParams({ resonance: 0, sustain: 0.9 });
    const bajo = renderVoice(
      { layers: [layerDef(engine, { wave: 0.05 })], macros: [] },
      params,
      57,
      { seconds: 0.2 },
    );
    const alto = renderVoice(
      { layers: [layerDef(engine, { wave: 0.95 })], macros: [] },
      params,
      57,
      { seconds: 0.2 },
    );
    expect(
      maxDiff(bajo.left, alto.left),
      `el motor ${engine} suena igual con wave 0.05 que con 0.95`,
    ).toBeGreaterThan(1e-3);
  });

  it('una nota muy aguda no dispara la energía (tablas band-limited por mips)', () => {
    const params = chanParams({ resonance: 0, sustain: 0.9 });
    const def: PrismaDef = { layers: [layerDef('wt', { wave: 0.5 })], macros: [] }; // sierra
    const medio = renderVoice(def, params, 60, { seconds: 0.2 });
    const agudo = renderVoice(def, params, 108, { seconds: 0.2 });
    expect(firstBadSample(agudo.left)).toBe(-1);
    // Misma envolvente y misma tabla: el pico no puede dispararse por subir la
    // nota (si lo hace, el alias se está sumando en fase).
    expect(peak(agudo.left)).toBeLessThan(peak(medio.left) * 1.5);
    expect(peak(agudo.left)).toBeGreaterThan(0.01);
  });

  it('la sierra aguda casi no trae energía por debajo de su fundamental', () => {
    // Alias = parciales plegados por debajo del fundamental. Con la tabla
    // band-limited esa banda tiene que estar prácticamente vacía.
    const def: PrismaDef = { layers: [layerDef('wt', { wave: 0.5 })], macros: [] };
    const res = renderVoice(def, chanParams({ resonance: 0, sustain: 0.9 }), 96, {
      seconds: 0.25,
    });
    const f0 = 440 * Math.pow(2, (96 - 69) / 12); // ~2093 Hz
    expect(lowBandRatio(res.left, Math.round(0.05 * SR), f0 * 0.7)).toBeLessThan(0.02);
  });
});

/** Fracción de energía por debajo de `hz` (ventana Hann + FFT de 4096). */
function lowBandRatio(xs: Float32Array, from: number, hz: number): number {
  const n = 4096;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = (xs[from + i] ?? 0) * w;
  }
  new Fft(n).forward(re, im);
  let low = 0;
  let total = 0;
  for (let k = 1; k < n / 2; k++) {
    const mag = re[k]! * re[k]! + im[k]! * im[k]!;
    total += mag;
    if ((k * SR) / n < hz) low += mag;
  }
  return total > 0 ? low / total : 0;
}

// ── Capas, macros y envolvente ───────────────────────────────────────────────

describe('Orbit Prisma · capas, macros y envolvente', () => {
  it('una macro mueve el sonido: el mismo preset a 0 y a 1 no suena igual', () => {
    // Macro 1 sobre el nivel de la capa: a 0 casi no se oye, a 1 suena entera.
    const def: PrismaDef = {
      layers: [layerDef('wt')],
      macros: [{ targets: [{ layer: 0, param: 'level', min: 0, max: 1 }] }],
    };
    const cerrada = renderVoice(def, chanParams({ macro1: 0, resonance: 0 }), 60, {
      seconds: 0.15,
    });
    const abierta = renderVoice(def, chanParams({ macro1: 1, resonance: 0 }), 60, {
      seconds: 0.15,
    });
    expect(rms(cerrada.left)).toBeLessThan(1e-6);
    expect(rms(abierta.left)).toBeGreaterThan(0.01);
  });

  it('una macro sobre una perilla del canal también manda', () => {
    const def: PrismaDef = {
      layers: [layerDef('wt', { wave: 0.5 })],
      macros: [{ targets: [{ layer: -1, param: 'cutoff', min: 200, max: 16000 }] }],
    };
    const params = chanParams({ resonance: 0.1, sustain: 0.9 });
    const oscura = renderVoice(def, { ...params, macro1: 0 }, 60, { seconds: 0.2 });
    const abierta = renderVoice(def, { ...params, macro1: 1 }, 60, { seconds: 0.2 });
    // Con el corte en 200 Hz una sierra de C5 pierde casi todo su brillo.
    expect(brillo(oscura.left)).toBeLessThan(brillo(abierta.left) * 0.5);
  });

  it('las macros del catálogo mueven audio de verdad', () => {
    // Sin atarse a un preset: basta con que las macros de los presets que las
    // declaran hagan algo audible en una tecla que toquen.
    const conMacros = PRISMA_PRESETS.filter(
      (p) => (p.macros[0]?.targets.length ?? 0) > 0 && cubre(p, 60),
    );
    expect(conMacros.length, 'ningún preset del catálogo declara macros').toBeGreaterThan(0);
    const muestra = conMacros.slice(0, 8);
    let mueven = 0;
    for (const preset of muestra) {
      const params = prismaPresetParams(preset);
      const a = renderVoice(defOf(preset), { ...params, macro1: 0 }, 60, { seconds: 0.15 });
      const b = renderVoice(defOf(preset), { ...params, macro1: 1 }, 60, { seconds: 0.15 });
      if (maxDiff(a.left, b.left) > 1e-4) mueven++;
    }
    expect(mueven, `ninguna macro 1 de ${muestra.length} presets cambió el audio`).toBeGreaterThan(
      muestra.length / 2,
    );
  });

  it('una capa fuera de su rango de teclas no suena', () => {
    const def: PrismaDef = {
      layers: [layerDef('wt', { keyLo: 60, keyHi: 72 })],
      macros: [],
    };
    const params = chanParams({ resonance: 0 });
    const dentro = renderVoice(def, params, 64, { seconds: 0.1 });
    const fuera = renderVoice(def, params, 48, { seconds: 0.1 });
    expect(rms(dentro.left)).toBeGreaterThan(0.01);
    expect(peak(fuera.left), 'una capa fuera de rango sonó igual').toBe(0);
    // Sin capas audibles la voz se muere en el primer bloque, no se queda
    // ocupando sitio en el pool de voces.
    expect(fuera.alive).toBe(false);
    expect(fuera.diedAt).toBe(0);
  });

  it('cada capa suena solo en su tramo del teclado (split real)', () => {
    const bajo = layerDef('sub', { keyLo: 0, keyHi: 59 });
    const alto = layerDef('bell', { keyLo: 60, keyHi: 127 });
    const split: PrismaDef = { layers: [bajo, alto], macros: [] };
    const params = chanParams({ resonance: 0, sustain: 0.9 });

    const grave = renderVoice(split, params, 40, { seconds: 0.2 });
    const agudo = renderVoice(split, params, 84, { seconds: 0.2 });
    expect(rms(grave.left)).toBeGreaterThan(0);
    expect(rms(agudo.left)).toBeGreaterThan(0);

    // Y en cada mitad suena EXACTAMENTE la capa que toca, ni una muestra de la
    // otra: comparado con el preset de una sola capa, es el mismo audio.
    const soloBajo = renderVoice({ layers: [bajo], macros: [] }, params, 40, { seconds: 0.2 });
    const soloAlto = renderVoice({ layers: [alto], macros: [] }, params, 84, { seconds: 0.2 });
    expect(sameBits(grave.left, soloBajo.left), 'la capa aguda se coló en la nota grave').toBe(true);
    expect(sameBits(agudo.left, soloAlto.left), 'la capa grave se coló en la nota aguda').toBe(true);
  });

  it('la voz muere tras el note-off (nada de voces zombis)', () => {
    const def: PrismaDef = { layers: [layerDef('wt')], macros: [] };
    const params = chanParams({ attack: 0.005, decay: 0.1, sustain: 0.8, release: 0.1 });
    const res = renderVoice(def, params, 60, { seconds: 3, holdSeconds: 0.2 });
    expect(res.alive, 'la voz seguía viva 3 s después del note-off').toBe(false);
    expect(res.diedAt).toBeGreaterThan(0);
    // Con release de 0.1 s no puede tardar un segundo en apagarse.
    expect(res.diedAt / SR).toBeLessThan(1);
  });

  it('sustain 0 mata la voz sola, sin note-off', () => {
    const def: PrismaDef = { layers: [layerDef('wt')], macros: [] };
    const params = chanParams({ attack: 0.001, decay: 0.05, sustain: 0, release: 0.05 });
    const res = renderVoice(def, params, 60, { seconds: 2, holdSeconds: 2 });
    expect(res.alive, 'una voz con sustain 0 se quedó sonando').toBe(false);
  });

  it('cuatro capas con unísono no se pasan del techo de osciladores', () => {
    const def: PrismaDef = {
      layers: [layerDef('wt'), layerDef('pulse'), layerDef('organ'), layerDef('bell')],
      macros: [],
    };
    const res = renderVoice(def, chanParams({ unison: 8, resonance: 0, sustain: 0.9 }), 60, {
      seconds: 0.2,
    });
    expect(firstBadSample(res.left)).toBe(-1);
    expect(peak(res.left)).toBeGreaterThan(0.01);
    // Cuatro capas × unísono 8 = 32 osciladores pedidos, pero el techo por voz
    // es 12: si el reparto fallara, esto se dispararía de nivel.
    expect(peak(res.left)).toBeLessThan(4);
  });
});

// ── Slide / glide (nota ligada) ──────────────────────────────────────────────

describe('Orbit Prisma · slide', () => {
  /** Voz de seno pura y sostenida: lo más fácil de medir por cruces por cero. */
  function sineVoice(key: number): PrismaVoice {
    const def: PrismaDef = { layers: [layerDef('wt', { wave: 0 })], macros: [] };
    const params = chanParams({
      attack: 0.001,
      decay: 0.01,
      sustain: 1,
      release: 0.5,
      resonance: 0,
      glide: 0, // salto instantáneo: la medición no espera a ningún portamento
    });
    return new PrismaVoice(0, key, 0, 0.9, params, { sr: SR, samples: new Map() }, def);
  }

  /** Renderiza `seconds` en la voz y devuelve su frecuencia estimada. */
  function freqOf(voice: PrismaVoice, seconds = 0.5): number {
    const n = Math.round(seconds * SR);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let off = 0; off < n; off += MAX_BLOCK) {
      voice.render(l, r, off, Math.min(n, off + MAX_BLOCK), 1, 1);
    }
    // Cruces por cero ascendentes, saltándose el arranque (ataque + salto).
    const from = Math.round(0.05 * SR);
    let crossings = 0;
    for (let i = from + 1; i < n; i++) if (l[i - 1]! <= 0 && l[i]! > 0) crossings++;
    return crossings / ((n - from) / SR);
  }

  const hz = (key: number): number => 440 * Math.pow(2, (key - 69) / 12);

  /** El estimador cuenta cruces enteros: se compara en relativo, no al Hz. */
  function expectFreq(got: number, key: number, what: string): void {
    expect(got / hz(key), `${what}: ${got.toFixed(1)} Hz en vez de ${hz(key).toFixed(1)} Hz`)
      .toBeGreaterThan(0.97);
    expect(got / hz(key), `${what}: ${got.toFixed(1)} Hz en vez de ${hz(key).toFixed(1)} Hz`)
      .toBeLessThan(1.03);
  }

  it('un slide lleva la voz a la altura de la nota nueva', () => {
    const voice = sineVoice(40);
    try {
      expectFreq(freqOf(voice), 40, 'la nota de nacimiento');
      voice.glideTo(45, 0.9);
      expectFreq(freqOf(voice), 45, 'el primer slide');
    } finally {
      voice.dispose();
    }
  });

  /**
   * BUG (no arreglado aquí, ver informe): `glideTo` recalcula la relación
   * tono/tecla con `this.key`, que a partir del segundo slide YA es la tecla
   * del slide anterior (`super.glideTo` la machacó). Desde ahí la voz aplica
   * el intervalo anterior como desafinación y se queda clavada en la nota del
   * primer slide.
   *
   * Repro: cadena 40 → 45 → 50 (lo normal en un 808 con slides). La tercera
   * altura sale ~110 Hz (la del 45) en vez de ~146.8 Hz.
   * Fuente: packages/engine/src/dsp/prisma-voice.ts:851-857.
   */
  it('una cadena de slides sigue clavando cada altura', () => {
    const voice = sineVoice(40);
    try {
      voice.glideTo(45, 0.9);
      expectFreq(freqOf(voice), 45, 'el primer slide');
      voice.glideTo(50, 0.9);
      expectFreq(freqOf(voice), 50, 'el segundo slide');
    } finally {
      voice.dispose();
    }
  });
});

// ── Catálogo completo ────────────────────────────────────────────────────────

describe('Orbit Prisma · el catálogo entero suena', () => {
  it('todos los presets dan señal en alguna tecla y ninguno saca NaN', () => {
    const mudos: string[] = [];
    const rotos: string[] = [];
    const salvajes: string[] = [];
    for (const preset of PRISMA_PRESETS) {
      // Exactamente lo que carga un canal al elegir el preset: base + macros.
      const params = prismaPresetParams(preset);
      let sono = false;
      for (const key of [60, 48, 72, 36, 84, 96]) {
        const res = renderVoice(defOf(preset), params, key, { seconds: 0.12 });
        if (firstBadSample(res.left) >= 0 || firstBadSample(res.right) >= 0) {
          rotos.push(`${preset.id} (tecla ${key})`);
          break;
        }
        const p = Math.max(peak(res.left), peak(res.right));
        // Una voz sola no puede salir a un nivel absurdo: eso es un preset con
        // el nivel mal puesto, y en la mezcla se lo lleva todo por delante.
        if (p > 4) salvajes.push(`${preset.id} (tecla ${key}, pico ${p.toFixed(2)})`);
        if (p > 1e-4) {
          sono = true;
          break;
        }
      }
      if (!sono) mudos.push(preset.id);
    }
    expect(salvajes, 'presets que salen a un nivel absurdo').toEqual([]);
    expect(rotos, 'presets con muestras no finitas').toEqual([]);
    expect(mudos, 'presets que no suenan en ninguna tecla').toEqual([]);
  });
});

// ── Pool de líneas de la cuerda pulsada ──────────────────────────────────────

describe('Orbit Prisma · pool de la cuerda pulsada', () => {
  const pluckDef = (layers = 1): PrismaDef => ({
    layers: Array.from({ length: layers }, () => layerDef('pluck', { params: { damp: 0.4 } })),
    macros: [],
  });

  it('una voz pluck coge una línea y la devuelve al morir', () => {
    expect(pluckLinesFree()).toBe(POOL_FULL);
    const params = chanParams({ attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 });
    const res = renderVoice(pluckDef(), params, 60, { seconds: 2, holdSeconds: 2 });
    expect(res.alive).toBe(false);
    expect(pluckLinesFree(), 'la voz murió sin devolver su línea').toBe(POOL_FULL);
  });

  it('el pool se agota con gracia: sin línea, la capa cae a la tabla', () => {
    const params = chanParams({ sustain: 0.9 });
    const ctx = { sr: SR, samples: new Map() };
    const vivas: PrismaVoice[] = [];
    // Más voces que líneas hay en el pool.
    for (let i = 0; i < POOL_FULL + 8; i++) {
      vivas.push(new PrismaVoice(0, 60, i, 0.9, params, ctx, pluckDef()));
    }
    expect(pluckLinesFree()).toBe(0);
    const l = new Float32Array(MAX_BLOCK);
    const r = new Float32Array(MAX_BLOCK);
    // Las que se quedaron sin línea siguen sonando (con otro timbre), no callan.
    const ultima = vivas[vivas.length - 1]!;
    ultima.render(l, r, 0, MAX_BLOCK, 1, 1);
    expect(peak(l), 'una voz sin línea de retardo se quedó muda').toBeGreaterThan(0);
    expect(firstBadSample(l)).toBe(-1);
    for (const v of vivas) v.dispose();
    expect(pluckLinesFree(), 'el pool no volvió a su tamaño tras soltar las voces').toBe(POOL_FULL);
  });

  it('dispose es idempotente: una línea no se devuelve dos veces', () => {
    const voice = new PrismaVoice(0, 60, 0, 0.9, chanParams(), { sr: SR, samples: new Map() }, pluckDef());
    expect(pluckLinesFree()).toBe(POOL_FULL - 1);
    voice.dispose();
    voice.dispose();
    voice.dispose();
    expect(pluckLinesFree()).toBe(POOL_FULL);
  });

  /** Proyecto denso de plucks: 96 notas apiladas, dos capas de cuerda por voz. */
  function densePluckProject(params: Record<string, number>): CompiledProject {
    const p = createEmptyProject('Plucks');
    p.tempo = 240;
    const patternId = p.patternOrder[0]!;
    const ch = createChannel('prisma', 0, 'Prisma');
    ch.mixerTrack = 1;
    Object.assign(ch.params, params);
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, {
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: Array.from({ length: 96 }, (_, i) => note((i % 8) * 0.25, 0.2, 40 + (i % 40))),
    });
    const compiled = compileProject(p, { mode: 'pattern', patternId });
    // El def se pone a mano: así el test vale aunque el catálogo cambie.
    compiled.channels[0]!.prisma = pluckDef(2);
    return compiled;
  }

  it('el kernel devuelve las líneas de las voces robadas y de las que mueren', () => {
    expect(pluckLinesFree()).toBe(POOL_FULL);
    // 96 notas apiladas: el kernel roba voces (MAX_VOICES = 64) y luego las
    // deja morir. En los dos caminos tiene que soltar la línea prestada.
    const compiled = densePluckProject({
      attack: 0.001,
      decay: 0.08,
      sustain: 0,
      release: 0.02,
    });
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: compiled });
    core.handleMessage({ type: 'setLoop', start: 0, end: compiled.lengthBeats, enabled: false });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    // Medio pasaje: el pool TIENE que estar tocado (si no, el test no estaría
    // probando nada).
    runBlocks(core, Math.ceil((0.4 * SR) / MAX_BLOCK));
    expect(pluckLinesFree(), 'el pasaje no llegó a pedir líneas').toBeLessThan(POOL_FULL);
    runBlocks(core, Math.ceil((0.8 * SR) / MAX_BLOCK)); // el patrón dura 1 s
    expect(core.meterFrame().rms[1]!, 'el pasaje de plucks no sonó').toBeGreaterThan(0);
    core.handleMessage({ type: 'stop' });
    runBlocks(core, Math.ceil((1 * SR) / MAX_BLOCK)); // cola: todas se apagan
    expect(pluckLinesFree(), 'el pool no volvió a su tamaño tras el pasaje denso').toBe(POOL_FULL);
  });

  /**
   * BUG (no arreglado aquí, ver informe): el pool vive en el módulo, pero un
   * `KernelCore` que se tira con voces vivas NO las suelta — no hay teardown
   * en ningún sitio. `renderProject()` crea un kernel por render y lo suelta
   * en cuanto se acaba la cola, así que cada render offline que termina con
   * cuerdas sonando se queda con sus líneas PARA SIEMPRE: tras unos cuantos
   * exports el pool global (48) se agota, las capas 'pluck' caen a la tabla de
   * ondas y el mismo proyecto deja de sonar igual (y de ser determinista).
   *
   * Repro: renderizar dos veces seguidas un proyecto de plucks con
   * `tailSeconds: 0` (o con release más larga que la cola) y comparar
   * `pluckLinesFree()` antes y después.
   */
  it('un render offline que acaba con voces vivas devuelve el pool', () => {
    const antes = pluckLinesFree();
    renderProject(densePluckProject({ attack: 0.001, decay: 1.5, sustain: 0.6, release: 2 }), {
      tailSeconds: 0,
    });
    expect(pluckLinesFree(), 'el render offline se quedó líneas del pool').toBe(antes);
  });
});
