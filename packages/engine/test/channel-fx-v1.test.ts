/**
 * Inserts POR CANAL (`Channel.fx`, CHANNEL_SLOTS = 4).
 *
 * La cadena de un canal suena entre sus voces y su pista de mixer, y existe
 * justo para poder tratar UN sonido a solas sin arrastrar a los demás canales
 * que compartan pista. Eso es lo que se vigila aquí:
 *
 * - un canal SIN cadena sigue entrando por el camino rápido de siempre, bit a
 *   bit igual que antes de que existiera la funcionalidad;
 * - el volumen y el pan del canal mandan DESPUÉS de la cadena (el fader está
 *   detrás de los inserts, no dentro);
 * - un slot en bypass o con `mix` a 0 no toca el audio;
 * - las perillas en vivo (`channelEffectParam` / `channelEffectState`) llegan
 *   al efecto sin recompilar el proyecto;
 * - la automatización con destino `channelFx` mueve el parámetro;
 * - y dos canales con cadenas distintas NO se contaminan aunque compartan
 *   pista de mixer — que es el motivo de existir de todo esto.
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_SLOTS,
  applyCommand,
  createChannel,
  createChannelFx,
  createEmptyProject,
  defaultEffectParams,
  newId,
  type EffectKind,
  type EffectSlot,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import { renderProject } from '../src/render/offline';
import type { CompiledProject } from '../src/protocol';

const SR = 44100;

// ── Utilidades ───────────────────────────────────────────────────────────────

function note(start: number, duration: number, key: number): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false };
}

function fxSlot(
  kind: EffectKind,
  params: Record<string, number> = {},
  extra: Partial<EffectSlot> = {},
): EffectSlot {
  return {
    id: newId(),
    kind,
    enabled: true,
    mix: 1,
    params: { ...defaultEffectParams(kind), ...params },
    ...extra,
  };
}

/**
 * Efecto LINEAL exacto: Orbit Stereo con ancho 1 y sin mono en graves es una
 * ganancia pura. Con él se puede afirmar aritmética sobre la salida.
 */
function gainSlot(gain: number, extra: Partial<EffectSlot> = {}): EffectSlot {
  return fxSlot('stereo', { gain, width: 1, monoBelow: 0 }, extra);
}

interface ChannelSpec {
  /** Slots de la cadena; los huecos van a null. */
  slots?: (EffectSlot | null)[];
  volume?: number;
  pan?: number;
  keys?: number[];
  /** Duración de las notas en beats (por defecto media vuelta del patrón). */
  noteBeats?: number;
  mixerTrack?: number;
  /** Canal de un .orbit anterior a v1.1: sin el campo `fx` siquiera. */
  dropFx?: boolean;
  /** Silencia el canal (para renderizar cada uno por separado). */
  mute?: boolean;
}

interface Built {
  project: Project;
  patternId: string;
  channelIds: string[];
}

/** Proyecto de N canales de sinte, cada uno con su cadena de inserts. */
function build(specs: ChannelSpec[], tempo = 240): Built {
  const project = createEmptyProject('Inserts');
  project.tempo = tempo;
  const patternId = project.patternOrder[0]!;
  const channelIds: string[] = [];
  specs.forEach((spec, i) => {
    const ch = createChannel('synth', i, `Canal ${i + 1}`);
    ch.mixerTrack = spec.mixerTrack ?? 1;
    ch.volume = spec.volume ?? 0.78;
    ch.pan = spec.pan ?? 0;
    ch.mute = spec.mute ?? false;
    // Envolvente corta y sin cola: la nota entra y sale limpia.
    Object.assign(ch.params, { attack: 0.002, decay: 0.3, sustain: 0.7, release: 0.05 });
    if (spec.dropFx) delete ch.fx;
    applyCommand(project, { type: 'addChannel', channel: ch });
    channelIds.push(ch.id);
    (spec.slots ?? []).forEach((slot, slotIndex) => {
      if (slot) {
        applyCommand(project, {
          type: 'setChannelEffect',
          channelId: ch.id,
          slotIndex,
          slot,
        });
      }
    });
    applyCommand(project, {
      type: 'addNotes',
      patternId,
      channelId: ch.id,
      notes: (spec.keys ?? [60]).map((k) => note(0, spec.noteBeats ?? 2, k)),
    });
  });
  return { project, patternId, channelIds };
}

function compiled(built: Built): CompiledProject {
  return compileProject(built.project, { mode: 'pattern', patternId: built.patternId });
}

/** Render de un proyecto de inserts (siempre con la misma cola). */
function render(specs: ChannelSpec[]): { left: Float32Array; right: Float32Array } {
  return renderProject(compiled(build(specs)), { tailSeconds: 0.2, sampleRate: SR });
}

function rms(xs: Float32Array, from = 0, to = xs.length): number {
  let s = 0;
  const end = Math.min(to, xs.length);
  for (let i = from; i < end; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, end - from));
}

function peak(xs: Float32Array): number {
  let m = 0;
  for (let i = 0; i < xs.length; i++) {
    const a = Math.abs(xs[i]!);
    if (a > m) m = a;
  }
  return m;
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

function firstBadSample(xs: Float32Array): number {
  for (let i = 0; i < xs.length; i++) if (!Number.isFinite(xs[i]!)) return i;
  return -1;
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

// ── Compilación: el camino rápido no se toca ─────────────────────────────────

describe('inserts de canal · compilación', () => {
  it('un canal sin efectos no manda cadena al kernel', () => {
    const vacio = compiled(build([{}]));
    const viejo = compiled(build([{ dropFx: true }]));
    expect(vacio.channels[0]!.fx, 'una cadena de solo huecos no debe viajar').toBeUndefined();
    expect(viejo.channels[0]!.fx).toBeUndefined();
  });

  it('un canal con un slot manda la cadena entera, huecos incluidos', () => {
    const built = build([{ slots: [null, gainSlot(1)] }]);
    const c = compiled(built);
    const fx = c.channels[0]!.fx;
    expect(fx).toBeDefined();
    expect(fx!.length).toBe(CHANNEL_SLOTS);
    expect(fx![0]).toBeNull();
    expect(fx![1]!.kind).toBe('stereo');
    // Params COPIADOS, no compartidos con el modelo: el kernel los escribe
    // (automatización, perillas en vivo) y no puede tocar el proyecto.
    const enModelo = built.project.channels[built.channelIds[0]!]!.fx![1]!;
    expect(fx![1]!.id).toBe(enModelo.id);
    expect(fx![1]!.params).toEqual(enModelo.params);
    expect(fx![1]!.params).not.toBe(enModelo.params);
  });

  it('la cadena vacía de fábrica tiene CHANNEL_SLOTS huecos', () => {
    expect(CHANNEL_SLOTS).toBe(4);
    expect(createChannelFx()).toEqual([null, null, null, null]);
  });

  it('un canal SIN cadena suena bit a bit igual que antes de la v1.1', () => {
    // El proyecto viejo (sin el campo) y el nuevo (cadena de huecos) tienen que
    // dar EXACTAMENTE el mismo audio: el camino rápido no se ha movido.
    const nuevo = render([{}]);
    const viejo = render([{ dropFx: true }]);
    expect(rms(nuevo.left)).toBeGreaterThan(0.01);
    expect(sameBits(nuevo.left, viejo.left), 'el camino seco cambió de audio').toBe(true);
    expect(sameBits(nuevo.right, viejo.right), 'el camino seco cambió de audio').toBe(true);
  });
});

// ── La cadena suena ──────────────────────────────────────────────────────────

describe('inserts de canal · la cadena suena', () => {
  it('un canal con efecto suena DISTINTO que el mismo canal sin él', () => {
    const seco = render([{}]);
    const sucio = render([{ slots: [fxSlot('bitcrush', { bits: 3, downsample: 12 })] }]);
    expect(rms(sucio.left)).toBeGreaterThan(0.001);
    expect(firstBadSample(sucio.left)).toBe(-1);
    expect(maxDiff(seco.left, sucio.left), 'el insert del canal no hizo nada').toBeGreaterThan(
      0.01,
    );
  });

  it('los cuatro slots se encadenan en serie', () => {
    const seco = render([{}]);
    const conCadena = render([{ slots: [gainSlot(1.2), gainSlot(1.2), gainSlot(1.2), gainSlot(1.2)] }]);
    const esperado = Math.pow(1.2, 4); // 2.0736
    const ratio = rms(conCadena.left) / rms(seco.left);
    expect(ratio, 'los cuatro slots no se aplicaron uno detrás de otro').toBeCloseTo(esperado, 3);
  });

  it('un slot con plugin sin registrar deja pasar el audio (degradación amable)', () => {
    const seco = render([{}]);
    const conPlugin = render([{ slots: [fxSlot('plugin', {}, { pluginId: 'no-existe' })] }]);
    expect(rms(conPlugin.left)).toBeGreaterThan(0.01);
    expect(maxDiff(seco.left, conPlugin.left)).toBeLessThan(1e-6);
  });
});

// ── Fader y pan DESPUÉS de la cadena ─────────────────────────────────────────

describe('inserts de canal · volumen y pan van detrás', () => {
  it('doblar el volumen del canal dobla la salida (efecto lineal)', () => {
    const flojo = render([{ slots: [gainSlot(1)], volume: 0.4 }]);
    const fuerte = render([{ slots: [gainSlot(1)], volume: 0.8 }]);
    expect(rms(flojo.left)).toBeGreaterThan(0.001);
    // El fader está DETRÁS de la cadena: la relación es exacta, no aproximada.
    expect(rms(fuerte.left) / rms(flojo.left)).toBeCloseTo(2, 5);
    expect(peak(fuerte.left) / peak(flojo.left)).toBeCloseTo(2, 5);
  });

  it('el pan del canal sobrevive a un efecto que colapsa a mono', () => {
    // Orbit Stereo con ancho 0 deja L y R idénticos. Si el pan se aplicara
    // ANTES de la cadena, el colapso lo borraría; como va después, la nota
    // sigue pegada a la izquierda.
    const res = render([{ slots: [fxSlot('stereo', { width: 0, gain: 1, monoBelow: 0 })], pan: -1 }]);
    expect(rms(res.left), 'el canal paneado a la izquierda no suena').toBeGreaterThan(0.01);
    expect(peak(res.right), 'el pan del canal se perdió dentro de la cadena').toBe(0);
  });
});

// ── Bypass y mix ─────────────────────────────────────────────────────────────

describe('inserts de canal · bypass y mix', () => {
  it('un slot en bypass no altera el audio', () => {
    const seco = render([{}]);
    const bypass = render([
      { slots: [fxSlot('bitcrush', { bits: 2, downsample: 20 }, { enabled: false })] },
    ]);
    expect(rms(bypass.left)).toBeGreaterThan(0.01);
    // No es bit a bit: con cadena las voces pasan por un buffer intermedio de
    // float32 antes del fader, así que hay UN redondeo más (≈ 6e-8, un ULP).
    // Lo que se exige es que no haya nada más que eso.
    expect(maxDiff(seco.left, bypass.left), 'un slot apagado cambió el sonido').toBeLessThan(1e-6);
  });

  it('mix a 0 tampoco altera el audio', () => {
    const seco = render([{}]);
    const sinMezcla = render([
      { slots: [fxSlot('bitcrush', { bits: 2, downsample: 20 }, { mix: 0 })] },
    ]);
    expect(maxDiff(seco.left, sinMezcla.left), 'un slot con mix 0 cambió el sonido').toBeLessThan(
      1e-6,
    );
  });

  it('mix a la mitad queda entre el seco y el mojado', () => {
    const seco = render([{}]);
    const medio = render([{ slots: [gainSlot(3, { mix: 0.5 })] }]);
    // 50 % de seco (×1) + 50 % de mojado (×3) = ×2.
    expect(rms(medio.left) / rms(seco.left)).toBeCloseTo(2, 3);
  });

  it('un canal con TODOS los slots en bypass sigue reservando su buffer', () => {
    // El slot existe aunque esté apagado: si no se le reservara sitio, volver
    // a encenderlo en vivo dejaría el canal sin buffer donde sonar.
    const c = compiled(build([{ slots: [gainSlot(2, { enabled: false })] }]));
    expect(c.channels[0]!.fx).toBeDefined();
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: c });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 40);
    const antes = core.meterFrame().rms[1]!;
    expect(antes).toBeGreaterThan(0);
    // Encenderlo en vivo (sin recompilar) tiene que subir el nivel.
    core.handleMessage({
      type: 'channelEffectState',
      channelIndex: 0,
      slotIndex: 0,
      enabled: true,
      mix: 1,
    });
    runBlocks(core, 40);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(antes * 1.5);
  });
});

// ── Mensajes en vivo ─────────────────────────────────────────────────────────

describe('inserts de canal · perillas en vivo', () => {
  /** Kernel tocando un canal con un insert, ya sonando. */
  function playing(slots: (EffectSlot | null)[]): KernelCore {
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: compiled(build([{ slots }])) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 40);
    return core;
  }

  it('channelEffectParam llega al efecto sin recompilar', () => {
    const core = playing([gainSlot(1)]);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
    core.handleMessage({
      type: 'channelEffectParam',
      channelIndex: 0,
      slotIndex: 0,
      key: 'gain',
      value: 0,
    });
    runBlocks(core, 40);
    expect(core.meterFrame().rms[1]!, 'la perilla del insert no llegó al efecto').toBe(0);
  });

  it('channelEffectState apaga y enciende el slot en vivo', () => {
    const core = playing([gainSlot(0)]); // el efecto empieza matando la señal
    expect(core.meterFrame().rms[1]!).toBe(0);
    core.handleMessage({
      type: 'channelEffectState',
      channelIndex: 0,
      slotIndex: 0,
      enabled: false,
      mix: 1,
    });
    runBlocks(core, 40);
    expect(core.meterFrame().rms[1]!, 'el bypass en vivo no devolvió el audio').toBeGreaterThan(0);
  });

  it('un mensaje a un slot que no existe no rompe nada', () => {
    const core = playing([gainSlot(1)]);
    core.handleMessage({
      type: 'channelEffectParam',
      channelIndex: 9,
      slotIndex: 3,
      key: 'gain',
      value: 0,
    });
    core.handleMessage({
      type: 'channelEffectState',
      channelIndex: 0,
      slotIndex: 3,
      enabled: false,
      mix: 0,
    });
    runBlocks(core, 20);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
  });
});

// ── Automatización ───────────────────────────────────────────────────────────

describe('inserts de canal · automatización', () => {
  it('el destino channelFx se compila con canal y slot', () => {
    const built = build([{ slots: [gainSlot(1)] }]);
    addAutomation(built, 0, 0, 'gain', [
      { time: 0, value: 0 },
      { time: 4, value: 1 },
    ]);
    const c = compileProject(built.project, { mode: 'song' });
    expect(c.automation.length).toBe(1);
    expect(c.automation[0]!.target).toEqual({
      scope: 'channelFx',
      channelIndex: 0,
      slotIndex: 0,
      key: 'gain',
    });
    // Valores REALES ya desnormalizados con el spec del efecto (gain 0..2).
    expect(c.automation[0]!.values[0]).toBeCloseTo(0, 6);
    expect(c.automation[0]!.values[c.automation[0]!.values.length - 1]).toBeCloseTo(2, 6);
  });

  it('la curva mueve de verdad la perilla del insert', () => {
    // La nota dura el clip entero: así el nivel solo lo mueve la curva.
    const built = build([{ slots: [gainSlot(1)], noteBeats: 4 }]);
    addAutomation(built, 0, 0, 'gain', [
      { time: 0, value: 0 },
      { time: 4, value: 1 },
    ]);
    const res = renderProject(compileProject(built.project, { mode: 'song' }), {
      tailSeconds: 0,
      sampleRate: SR,
    });
    const cuarto = Math.floor(res.left.length / 4);
    const alPrincipio = rms(res.left, Math.floor(cuarto * 0.2), cuarto);
    const alFinal = rms(res.left, cuarto * 2, cuarto * 3);
    expect(alPrincipio).toBeGreaterThan(0);
    expect(alFinal, 'la automatización de channelFx no subió la ganancia').toBeGreaterThan(
      alPrincipio * 2,
    );
  });

  it('una curva sobre un slot vacío no mueve nada ni tumba el render', () => {
    const built = build([{ slots: [gainSlot(1)] }]);
    addAutomation(built, 0, 3, 'gain', [
      { time: 0, value: 0 },
      { time: 4, value: 1 },
    ]);
    const c = compileProject(built.project, { mode: 'song' });
    // El slot 3 está vacío: el destino viaja igual (sin spec, en 0..1) y el
    // kernel lo ignora al no encontrar slot. Lo que no puede es reventar.
    expect(c.automation[0]!.target).toMatchObject({ scope: 'channelFx', slotIndex: 3 });
    const res = renderProject(c, { tailSeconds: 0, sampleRate: SR });
    expect(firstBadSample(res.left)).toBe(-1);
    expect(rms(res.left)).toBeGreaterThan(0);
    // Y el insert que SÍ existe se queda con su valor de siempre.
    expect(c.channels[0]!.fx![0]!.params['gain']).toBe(1);
  });
});

/** Añade un clip de automatización sobre un insert del canal. */
function addAutomation(
  built: Built,
  channel: number,
  slotIndex: number,
  param: string,
  points: { time: number; value: number }[],
  length = 4,
): void {
  const { project } = built;
  const trackId = Object.values(project.playlistTracks).find(
    (t) => t.arrangementId === project.activeArrangementId,
  )!.id;
  const otra = Object.values(project.playlistTracks)
    .filter((t) => t.arrangementId === project.activeArrangementId)
    .sort((a, b) => a.order - b.order)[1]!.id;
  applyCommand(project, {
    type: 'addClips',
    clips: [
      {
        id: newId(),
        kind: 'pattern',
        playlistTrackId: trackId,
        start: 0,
        length,
        muted: false,
        patternId: built.patternId,
      },
      {
        id: newId(),
        kind: 'automation',
        playlistTrackId: otra,
        start: 0,
        length,
        muted: false,
        target: {
          kind: 'channelFx',
          channelId: built.channelIds[channel]!,
          slotIndex,
          param,
        },
        points: points.map((p) => ({ id: newId(), time: p.time, value: p.value, tension: 0 })),
      },
    ],
  });
}

// ── Independencia entre canales ──────────────────────────────────────────────

describe('inserts de canal · dos canales no se contaminan', () => {
  it('la cadena de un canal no toca al vecino aunque compartan pista', () => {
    // Los dos canales van a la MISMA pista de mixer; el primero lleva un
    // destructor de señal y el segundo entra seco.
    const crusher = () => fxSlot('bitcrush', { bits: 2, downsample: 24 });
    const juntos = render([
      { slots: [crusher()], keys: [48] },
      { keys: [72] },
    ]);
    // Cada uno por separado (el otro muteado).
    const soloA = render([
      { slots: [crusher()], keys: [48] },
      { keys: [72], mute: true },
    ]);
    const soloB = render([
      { slots: [crusher()], keys: [48], mute: true },
      { keys: [72] },
    ]);

    expect(rms(soloA.left)).toBeGreaterThan(0.001);
    expect(rms(soloB.left)).toBeGreaterThan(0.001);
    // La suma tiene que cuadrar: si el audio del vecino hubiera entrado en el
    // crusher (buffer compartido), esto no daría ni de lejos.
    const n = Math.min(juntos.left.length, soloA.left.length, soloB.left.length);
    let peor = 0;
    for (let i = 0; i < n; i++) {
      peor = Math.max(peor, Math.abs(juntos.left[i]! - (soloA.left[i]! + soloB.left[i]!)));
    }
    expect(peor, 'las cadenas de los dos canales se mezclaron').toBeLessThan(1e-5);
  });

  it('cada canal se queda con SU cadena (dos efectos distintos a la vez)', () => {
    const dos = render([
      { slots: [gainSlot(2)], keys: [48] },
      { slots: [fxSlot('bitcrush', { bits: 2, downsample: 24 })], keys: [72] },
    ]);
    const soloA = render([
      { slots: [gainSlot(2)], keys: [48] },
      { slots: [fxSlot('bitcrush', { bits: 2, downsample: 24 })], keys: [72], mute: true },
    ]);
    const soloB = render([
      { slots: [gainSlot(2)], keys: [48], mute: true },
      { slots: [fxSlot('bitcrush', { bits: 2, downsample: 24 })], keys: [72] },
    ]);
    const n = Math.min(dos.left.length, soloA.left.length, soloB.left.length);
    let peor = 0;
    for (let i = 0; i < n; i++) {
      peor = Math.max(peor, Math.abs(dos.left[i]! - (soloA.left[i]! + soloB.left[i]!)));
    }
    expect(peor).toBeLessThan(1e-5);
  });

  /**
   * BUG (no arreglado aquí, ver informe): el bucle que pasa las cadenas de
   * canal por sus efectos (kernel-core.ts:948-989) NO mira `ch.audible`. Con
   * un efecto que se inventa señal —Orbit Vinyl es el caso claro: crackle y
   * ruido de superficie con la entrada en silencio— un canal MUTEADO sigue
   * metiendo ruido en su pista de mixer. Mutear tiene que ser silencio.
   *
   * Repro: canal muteado con un insert de vinyl (noise/crackle a 1) y
   * renderizar: sale ruido en el master.
   */
  it('un canal muteado no mete nada en la pista, ni con un insert que genera ruido', () => {
    const res = render([
      {
        slots: [fxSlot('vinyl', { noise: 1, crackle: 1, wow: 0, flutter: 0 })],
        mute: true,
      },
    ]);
    expect(peak(res.left), 'un canal muteado sigue sonando por su cadena').toBe(0);
  });

  it('un canal con cadena y otro sin ella conviven en la misma pista', () => {
    const res = render([{ slots: [gainSlot(1.5)], keys: [48] }, { keys: [72] }]);
    expect(firstBadSample(res.left)).toBe(-1);
    expect(rms(res.left)).toBeGreaterThan(0.01);
  });

  it('el buffer del canal se limpia entre bloques (nada de colas fantasma)', () => {
    // Un canal con cadena que deja de tocar tiene que callar del todo: si el
    // buffer intermedio no se limpiara, se oiría el último bloque en bucle.
    const built = build([{ slots: [gainSlot(1)], keys: [60] }]);
    const c = compiled(built);
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: c });
    core.handleMessage({ type: 'setLoop', start: 0, end: c.lengthBeats, enabled: false });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, Math.ceil((2 * SR) / MAX_BLOCK));
    core.meterFrame(); // vacía los acumuladores
    runBlocks(core, 40);
    expect(core.meterFrame().rms[1]!, 'el canal siguió sonando después de la nota').toBe(0);
  });
});
