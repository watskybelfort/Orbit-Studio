/**
 * El tempo de RUNTIME es una sola verdad.
 *
 * Un clip de automatización (o un LFO) sobre el tempo cambiaba `this.tempo` en
 * el kernel, pero los efectos sincronizados seguían con el tempo del snapshot
 * —`updateEffectTempos()` solo corría desde `applyMaps()`, que además revertía
 * `this.tempo` al valor del mapa— y los clips de audio se leían con la
 * integral del tempoMap estático, no con la curva que estaba sonando.
 *
 * Medido antes del arreglo: un delay 1/4 a 200 BPM automatizado sobre base 120
 * repetía cada 22 050 muestras (esperado 13 230) y un clip de audio leía 14 620
 * en t = 0.2 s (natural 8 820).
 */

import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  defaultEffectParams,
  newId,
  type Note,
} from '@orbit/core';
import { compileProject } from '../src/compile';
import { renderProject } from '../src/render/offline';
import { LFO_LUT_STEPS } from '../src/protocol';
import type {
  CompiledAutomationEvent,
  CompiledLfo,
  CompiledProject,
} from '../src/protocol';
import type { SampleData } from '../src/dsp/voices';

const SR = 44100;

function note(start: number, duration: number, key: number, velocity = 1): Note {
  return { id: newId(), start, duration, key, velocity, pan: 0, slide: false };
}

/** Automatización de tempo a `bpm` durante `beats` beats desde el 0. */
function tempoAutomation(bpm: number, beats: number): CompiledAutomationEvent {
  const step = 1 / 32;
  const n = Math.max(2, Math.ceil(beats / step));
  return {
    startBeat: 0,
    step,
    values: new Array<number>(n).fill(bpm),
    target: { scope: 'transport', key: 'tempo' },
  };
}

/** Master neutro: la salida es exactamente lo que suena en las pistas. */
function neutralMaster(compiled: CompiledProject): void {
  const m = compiled.mixer[0]!;
  m.volume = 1;
  m.pan = 0;
  m.stereoWidth = 1;
  m.eqLow = 0;
  m.eqMid = 0;
  m.eqHigh = 0;
  m.slots = [];
}

/**
 * Un LFO de tempo sintético que escribe 220 BPM constante durante medio ciclo
 * largo (cuadrada, rateBeats 64). La LUT va de 100 a 300 BPM: con el tempo base
 * 120 el LFO parte de la norma 0.1 y con amount 0.5 escribe 0.6 → 220.
 */
const LFO_BPM = 220;
function tempoLfo(): CompiledLfo {
  const lut = new Float32Array(LFO_LUT_STEPS + 1);
  for (let i = 0; i <= LFO_LUT_STEPS; i++) lut[i] = 100 + (i / LFO_LUT_STEPS) * 200;
  return {
    target: { scope: 'transport', key: 'tempo' },
    shape: 3,
    rateBeats: 64,
    amount: 0.5,
    phase: 0,
    baseNorm: 0.5,
    lut,
  };
}

/** Muestras en las que arranca cada ráfaga (los ecos van separados). */
function onsets(xs: Float32Array, gate: number): number[] {
  const found: number[] = [];
  let quiet = xs.length;
  for (let i = 0; i < xs.length; i++) {
    if (Math.abs(xs[i]!) >= gate) {
      if (quiet > 1000) found.push(i);
      quiet = 0;
    } else {
      quiet++;
    }
  }
  return found;
}

/** Un click de un sample y un delay 1/4 (time = 5) en su pista. */
function delayProject(
  bpm: number,
  lfo = false,
): {
  compiled: CompiledProject;
  samples: Map<string, SampleData>;
} {
  const p = createEmptyProject('DelayTempo');
  p.tempo = 120;
  const patternId = p.patternOrder[0]!;
  const ch = createChannel('sampler', 0, 'Click');
  ch.sampleId = 'click';
  ch.mixerTrack = 1;
  ch.volume = 1;
  // Ataque 0: con el ataque por defecto (1 ms) el click de un sample se queda
  // dentro de la rampa y sale a ~0.02, por debajo del umbral de detección.
  ch.params['attack'] = 0;
  ch.params['release'] = 0.01;
  applyCommand(p, { type: 'addChannel', channel: ch });
  applyCommand(p, {
    type: 'addNotes',
    patternId,
    channelId: ch.id,
    notes: [note(0, 0.25, 60)],
  });
  applyCommand(p, {
    type: 'setEffect',
    trackIndex: 1,
    slotIndex: 0,
    slot: {
      id: 'fx-delay',
      kind: 'delay',
      enabled: true,
      mix: 1,
      params: {
        ...defaultEffectParams('delay'),
        time: 5, // 1/4
        feedback: 0.9,
        pingpong: 0,
        filter: 12000,
      },
    },
  });
  const track = p.mixer[1]!;
  track.volume = 1;
  track.pan = 0;
  track.stereoWidth = 1;
  track.eqLow = 0;
  track.eqMid = 0;
  track.eqHigh = 0;
  const compiled = compileProject(p, { mode: 'pattern', patternId });
  neutralMaster(compiled);
  compiled.lengthBeats = 8;
  compiled.automation = [tempoAutomation(bpm, 8)];
  if (lfo) compiled.lfos = [tempoLfo()];
  const left = new Float32Array(256);
  for (let i = 0; i < left.length; i++) left[i] = 0.9 * (1 - i / left.length);
  const right = left.slice();
  return { compiled, samples: new Map([['click', { left, right, rate: SR }]]) };
}

describe('tempo automatizado: efectos sincronizados', () => {
  it('el delay 1/4 repite cada 60/200 s (13 230), no cada 60/120 (22 050)', () => {
    const { compiled, samples } = delayProject(200);
    const res = renderProject(compiled, { sampleRate: SR, samples, tailSeconds: 2 });
    const found = onsets(res.left, 0.05);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const gap = found[1]! - found[0]!;
    expect(gap).toBeGreaterThan(13230 - 128);
    expect(gap).toBeLessThan(13230 + 128);
  });

  it('sin automatización el delay sigue repitiendo al tempo base (control)', () => {
    const { compiled, samples } = delayProject(120);
    compiled.automation = [];
    const res = renderProject(compiled, { sampleRate: SR, samples, tailSeconds: 2 });
    const found = onsets(res.left, 0.05);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const gap = found[1]! - found[0]!;
    expect(gap).toBeGreaterThan(22050 - 128);
    expect(gap).toBeLessThan(22050 + 128);
  });

  it('un LFO sobre el tempo también llega al delay (220 BPM → 12 027)', () => {
    const { compiled, samples } = delayProject(120, true);
    compiled.automation = [];
    const res = renderProject(compiled, { sampleRate: SR, samples, tailSeconds: 2 });
    const found = onsets(res.left, 0.05);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const gap = found[1]! - found[0]!;
    const expected = Math.round((60 / LFO_BPM) * SR); // 12 027
    expect(gap).toBeGreaterThan(expected - 128);
    expect(gap).toBeLessThan(expected + 128);
  });
});

describe('tempo automatizado: lectura de clips de audio', () => {
  /** Un clip de rampa de 8 beats en el master, con el tempo que se le ponga. */
  function clipProject(): { compiled: CompiledProject; samples: Map<string, SampleData> } {
    const p = createEmptyProject('ClipTempo');
    p.tempo = 120;
    const trackId = Object.values(p.playlistTracks).find(
      (t) => t.arrangementId === p.activeArrangementId,
    )!.id;
    applyCommand(p, {
      type: 'registerSample',
      sample: { id: 'ramp', name: 'ramp', path: 'qa:ramp', hash: 'x', duration: 4 },
    });
    applyCommand(p, {
      type: 'addClips',
      clips: [
        {
          id: 'clip1',
          kind: 'audio',
          playlistTrackId: trackId,
          start: 0,
          length: 8,
          muted: false,
          sampleId: 'ramp',
        },
      ],
    });
    const compiled = compileProject(p, { mode: 'song' });
    neutralMaster(compiled);
    const ramp = new Float32Array(SR * 4);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i;
    return { compiled, samples: new Map([['ramp', { left: ramp, right: ramp, rate: SR }]]) };
  }

  /** En t = 0.2 s la rampa vale 8 820 si se lee a tiempo real. */
  function expectRealTimeRead(compiled: CompiledProject, samples: Map<string, SampleData>): void {
    const res = renderProject(compiled, { sampleRate: SR, samples, tailSeconds: 0 });
    const at = Math.round(0.2 * SR);
    expect(Math.abs(res.left[at]! - at)).toBeLessThan(300);
  }

  it('un clip lee a tiempo real: en t = 0.2 s está en la muestra 8 820', () => {
    const { compiled, samples } = clipProject();
    compiled.automation = [tempoAutomation(200, 8)];
    // Con el bug leía ~14 620 (0.2 s × 200/120 de tiempo de timeline).
    expectRealTimeRead(compiled, samples);
  });

  it('un clip también sigue un LFO sobre el tempo', () => {
    const { compiled, samples } = clipProject();
    compiled.lfos = [tempoLfo()];
    expectRealTimeRead(compiled, samples);
  });
});
