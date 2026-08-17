/**
 * Kernel v1: pitch-shift de clips de audio y plugins JS de instrumento.
 * (Los dos comparten motor con cosas ya probadas en engine.test.ts —
 * grains del time-stretch y sandbox de plugins— así que aquí se prueba lo
 * nuevo: que el tono suba SIN mover la duración y que una voz de plugin
 * suene, y que la que revienta no se lleve el audio por delante.)
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  newId,
  type Channel,
  type Note,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { KernelCore, MAX_BLOCK } from '../src/kernel-core';
import { renderProject } from '../src/render/offline';
import type { CompiledProject } from '../src/protocol';

const SR = 44100;

function note(start: number, duration: number, key: number, extra: Partial<Note> = {}): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false, ...extra };
}

function runBlocks(core: KernelCore, blocks: number): void {
  const l = new Float32Array(MAX_BLOCK);
  const r = new Float32Array(MAX_BLOCK);
  for (let i = 0; i < blocks; i++) core.process(l, r, MAX_BLOCK);
}

function rms(xs: Float32Array, from: number, to: number): number {
  let s = 0;
  const end = Math.min(to, xs.length);
  for (let i = from; i < end; i++) s += xs[i]! * xs[i]!;
  return Math.sqrt(s / Math.max(1, end - from));
}

/** Frecuencia estimada por cruces por cero ascendentes (mismo truco que engine.test). */
function estimateFreq(xs: Float32Array, from: number, to: number, sr: number): number {
  let crossings = 0;
  const end = Math.min(to, xs.length);
  for (let i = from + 1; i < end; i++) {
    if (xs[i - 1]! <= 0 && xs[i]! > 0) crossings++;
  }
  return crossings / ((end - from) / sr);
}

// ── Pitch-shift de clips de audio ────────────────────────────────────────────

describe('kernel: pitch-shift de clips de audio', () => {
  /** Tono de 440 Hz de 0.5 s con micro-fades (evita clicks en los bordes). */
  function toneSample(): Map<string, { left: Float32Array; right: Float32Array; rate: number }> {
    const n = Math.round(0.5 * SR);
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 200) * Math.min(1, (n - i) / 200);
      left[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) * env;
    }
    return new Map([['tone', { left, right: left.slice(), rate: SR }]]);
  }

  /**
   * Un clip de audio de 2 beats a 120 BPM (= 1 s) con el tono dentro.
   * `pitch === null` significa "sin el campo" (el caso de siempre).
   */
  function clipProject(pitch: number | null, stretch = false): CompiledProject {
    const p = createEmptyProject('Pitch');
    p.tempo = 120; // 0.5 s por beat
    const trackId = Object.values(p.playlistTracks).find(
      (t) => t.arrangementId === p.activeArrangementId,
    )!.id;
    applyCommand(p, {
      type: 'registerSample',
      sample: { id: 'tone', name: 'tone', path: 'qa:tone', hash: 'x', duration: 0.5 },
    });
    applyCommand(p, {
      type: 'addClips',
      clips: [
        {
          id: 'clip1',
          kind: 'audio',
          playlistTrackId: trackId,
          start: 0,
          length: 2,
          muted: false,
          sampleId: 'tone',
          audioStretch: stretch,
          ...(pitch === null ? {} : { audioPitch: pitch }),
        },
      ],
    });
    return compileProject(p, { mode: 'song' });
  }

  it('+12 st sube una octava (~880 Hz) y NO acorta el clip', () => {
    const res = renderProject(clipProject(12), { samples: toneSample(), tailSeconds: 0 });
    const sr = res.sampleRate;

    // Duración intacta: leído a 2× sin compensar, el sample se habría agotado a
    // los 0.25 s; con el stretch inverso sigue sonando hasta los 0.5 s.
    expect(rms(res.left, Math.round(0.05 * sr), Math.round(0.2 * sr))).toBeGreaterThan(0.05);
    expect(rms(res.left, Math.round(0.3 * sr), Math.round(0.45 * sr))).toBeGreaterThan(0.05);
    expect(rms(res.left, Math.round(0.65 * sr), Math.round(0.9 * sr))).toBeLessThan(0.01);

    // Y una octava arriba.
    const f = estimateFreq(res.left, Math.round(0.1 * sr), Math.round(0.4 * sr), sr);
    expect(f).toBeGreaterThan(830);
    expect(f).toBeLessThan(930);
  });

  it('-12 st baja una octava (~220 Hz) y tampoco mueve la duración', () => {
    const res = renderProject(clipProject(-12), { samples: toneSample(), tailSeconds: 0 });
    const sr = res.sampleRate;
    expect(rms(res.left, Math.round(0.3 * sr), Math.round(0.45 * sr))).toBeGreaterThan(0.05);
    const f = estimateFreq(res.left, Math.round(0.1 * sr), Math.round(0.4 * sr), sr);
    expect(f).toBeGreaterThan(200);
    expect(f).toBeLessThan(240);
  });

  it('pitch 0 es EXACTAMENTE lo mismo que no ponerlo (lectura directa)', () => {
    // El compilador ni siquiera manda el campo cuando vale 0.
    expect(clipProject(0).audioClips[0]!.pitch).toBeUndefined();
    expect(clipProject(null).audioClips[0]!.pitch).toBeUndefined();

    const a = renderProject(clipProject(0), { samples: toneSample(), tailSeconds: 0 });
    const b = renderProject(clipProject(null), { samples: toneSample(), tailSeconds: 0 });
    expect(a.left.length).toBe(b.left.length);
    let maxDiff = 0;
    for (let i = 0; i < a.left.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a.left[i]! - b.left[i]!), Math.abs(a.right[i]! - b.right[i]!));
    }
    expect(maxDiff).toBe(0);
  });

  it('pitch y stretch conviven: llena el clip Y suena una octava arriba', () => {
    // Sample de 0.5 s estirado a 1 s (stretch) y transpuesto +12.
    const res = renderProject(clipProject(12, true), { samples: toneSample(), tailSeconds: 0 });
    const sr = res.sampleRate;
    // Sin stretch esta ventana sería silencio.
    expect(rms(res.left, Math.round(0.7 * sr), Math.round(0.9 * sr))).toBeGreaterThan(0.05);
    const f = estimateFreq(res.left, Math.round(0.2 * sr), Math.round(0.9 * sr), sr);
    expect(f).toBeGreaterThan(830);
    expect(f).toBeLessThan(930);
  });
});

// ── Plugins JS de instrumento ────────────────────────────────────────────────

/** Instrumento JS de prueba: seno con la altura de la nota y release corto. */
const TONE_INSTRUMENT = `
function createInstrument(sr) {
  let phase = 0, amp = 0, freq = 440, on = false, gain = 1;
  return {
    setParams(p) { gain = p.level === undefined ? 1 : p.level; },
    noteOn(key, velocity) {
      freq = 440 * Math.pow(2, (key - 69) / 12);
      amp = velocity;
      on = true;
    },
    noteOff() { on = false; },
    render(l, r, from, to, gl, gr) {
      for (let i = from; i < to; i++) {
        phase += freq / sr;
        if (phase >= 1) phase -= 1;
        const s = Math.sin(2 * Math.PI * phase) * amp * gain;
        l[i] += s * gl;
        r[i] += s * gr;
        if (!on) amp *= 0.999;
      }
      return on || amp > 0.001;
    },
  };
}
`;

describe('kernel: plugins JS de instrumento', () => {
  /** Canal con instrumento JS (pista 1) + canal interno de control (pista 2). */
  function pluginChannelProject(pluginId: string | null, withControl: boolean): CompiledProject {
    const p = createEmptyProject('Instrumento JS');
    p.tempo = 120;
    const patternId = p.patternOrder[0]!;

    const ch = createChannel('synth', 0, 'JS');
    ch.mixerTrack = 1;
    // El modelo aún no declara el campo: se pone igual que lo leerá compile.ts.
    if (pluginId) (ch as Channel & { instrumentPluginId?: string }).instrumentPluginId = pluginId;
    applyCommand(p, { type: 'addChannel', channel: ch });
    applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes: [note(0, 2, 69)] });

    if (withControl) {
      const other = createChannel('synth', 1, 'Interno');
      other.mixerTrack = 2;
      applyCommand(p, { type: 'addChannel', channel: other });
      applyCommand(p, { type: 'addNotes', patternId, channelId: other.id, notes: [note(0, 2, 60)] });
    }
    return compileProject(p, { mode: 'pattern', patternId });
  }

  it('compile lleva el id del plugin de instrumento al canal compilado', () => {
    expect(pluginChannelProject('tone', false).channels[0]!.instrumentPluginId).toBe('tone');
    expect(pluginChannelProject(null, false).channels[0]!.instrumentPluginId).toBeUndefined();
  });

  it('un instrumento JS registrado suena con la altura de la nota (~440 Hz)', () => {
    const res = renderProject(pluginChannelProject('tone', false), {
      tailSeconds: 0,
      plugins: new Map([['tone', TONE_INSTRUMENT]]),
    });
    const sr = res.sampleRate;
    expect(rms(res.left, Math.round(0.1 * sr), Math.round(0.8 * sr))).toBeGreaterThan(0.05);
    const f = estimateFreq(res.left, Math.round(0.1 * sr), Math.round(0.8 * sr), sr);
    expect(f).toBeGreaterThan(430);
    expect(f).toBeLessThan(450);
  });

  it('el mensaje registerInstrument registra igual que registerPlugin', () => {
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'registerInstrument', pluginId: 'tone', code: TONE_INSTRUMENT });
    core.handleMessage({ type: 'snapshot', project: pluginChannelProject('tone', false) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 60);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
  });

  it('un instrumento que LANZA no tumba el audio (solo enmudece su canal)', () => {
    const core = new KernelCore(SR);
    core.handleMessage({
      type: 'registerInstrument',
      pluginId: 'boom',
      code: 'function createInstrument(sr){ return { noteOn(){}, noteOff(){}, render(){ throw new Error("boom"); } }; }',
    });
    core.handleMessage({ type: 'snapshot', project: pluginChannelProject('boom', true) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 60);
    const frame = core.meterFrame();
    expect(frame.rms[1]!).toBe(0); // el canal del plugin roto: mudo
    expect(frame.rms[2]!).toBeGreaterThan(0); // el canal interno: intacto
    expect(frame.masterRms[0]).toBeGreaterThan(0); // y el master sigue vivo
  });

  it('una fábrica que revienta al nacer deja al canal en su motor interno', () => {
    const core = new KernelCore(SR);
    core.handleMessage({
      type: 'registerInstrument',
      pluginId: 'boom',
      code: 'function createInstrument(){ throw new Error("boom"); }',
    });
    core.handleMessage({ type: 'snapshot', project: pluginChannelProject('boom', false) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 60);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
  });

  it('un plugin de instrumento sin registrar tampoco calla el canal', () => {
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'snapshot', project: pluginChannelProject('no-existe', false) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 60);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
  });

  it('channelParam llega a las voces vivas del instrumento (setParams)', () => {
    const core = new KernelCore(SR);
    core.handleMessage({ type: 'registerInstrument', pluginId: 'tone', code: TONE_INSTRUMENT });
    core.handleMessage({ type: 'snapshot', project: pluginChannelProject('tone', false) });
    core.handleMessage({ type: 'play', fromBeat: 0 });
    runBlocks(core, 20);
    expect(core.meterFrame().rms[1]!).toBeGreaterThan(0);
    // `level` a 0 en mitad de la nota: la voz ya creada tiene que enterarse.
    core.handleMessage({ type: 'channelParam', channelIndex: 0, key: 'level', value: 0 });
    runBlocks(core, 20);
    expect(core.meterFrame().rms[1]!).toBe(0);
  });
});
