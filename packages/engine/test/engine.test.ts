import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createPattern,
  newId,
  type Note,
  type Project,
} from '@orbit/core';
import { compileProject, topoOrder } from '../src/compile';
import { renderProject } from '../src/render/offline';
import { analyzeMix } from '../src/render/analysis';
import { encodeWav } from '../src/render/wav';

function note(start: number, duration: number, key: number, extra: Partial<Note> = {}): Note {
  return { id: newId(), start, duration, key, velocity: 0.9, pan: 0, slide: false, ...extra };
}

/** Proyecto demo trap: 808 con slide, drums, supersaw, sidechain y limiter. */
function demoProject(): Project {
  const p = createEmptyProject('Demo trap');
  p.tempo = 140;
  const patternId = p.patternOrder[0]!;

  const sub = createChannel('sub808', 0, 'Sub');
  sub.mixerTrack = 1;
  const drums = createChannel('drums', 1, 'Drums');
  drums.mixerTrack = 2;
  const saw = createChannel('supersaw', 2, 'Saw');
  saw.mixerTrack = 3;
  saw.volume = 0.5;

  applyCommand(p, { type: 'addChannel', channel: sub });
  applyCommand(p, { type: 'addChannel', channel: drums });
  applyCommand(p, { type: 'addChannel', channel: saw });

  // 808: F1 con slide a Ab1
  applyCommand(p, {
    type: 'addNotes', patternId, channelId: sub.id,
    notes: [
      note(0, 1.5, 29),
      note(1.5, 0.5, 32, { slide: true }),
      note(2, 2, 27),
    ],
  });
  // Drums: kick (36), clap (39), hats (42)
  applyCommand(p, {
    type: 'addNotes', patternId, channelId: drums.id,
    notes: [
      note(0, 0.2, 36), note(2, 0.2, 36),
      note(1, 0.2, 39), note(3, 0.2, 39),
      // Hats a 1/16 (el swing FL desplaza los 1/16 impares).
      ...Array.from({ length: 16 }, (_, i) => note(i * 0.25, 0.1, 42, { velocity: 0.5 })),
    ],
  });
  // Saw: acorde
  applyCommand(p, {
    type: 'addNotes', patternId, channelId: saw.id,
    notes: [note(0, 4, 53), note(0, 4, 56), note(0, 4, 60)],
  });

  // Mixer: compresor sidechain (fuente drums) en la pista del saw, limiter en master
  applyCommand(p, {
    type: 'setEffect', trackIndex: 3, slotIndex: 0,
    slot: {
      id: 'slot-sc', kind: 'compressor', enabled: true, mix: 1,
      params: { threshold: -30, ratio: 8, attack: 0.002, release: 0.12, knee: 3, makeup: 0 },
      sidechainSource: 2,
    },
  });
  applyCommand(p, {
    type: 'setEffect', trackIndex: 0, slotIndex: 0,
    slot: {
      id: 'slot-lim', kind: 'limiter', enabled: true, mix: 1,
      params: { gain: 3, ceiling: -0.5, release: 0.05 },
    },
  });

  // Clip en la playlist para modo song
  const trackId = Object.keys(p.playlistTracks)[0]!;
  applyCommand(p, {
    type: 'addClips',
    clips: [{
      id: newId(), kind: 'pattern', playlistTrackId: trackId,
      start: 0, length: 8, muted: false, patternId,
    }],
  });
  return p;
}

describe('compilador', () => {
  it('topoOrder: fuentes antes que destinos, master al final', () => {
    const order = topoOrder([
      { routeTo: null, sends: [] },      // 0 master
      { routeTo: 0, sends: [{ target: 2 }] }, // 1 → master + send a 2
      { routeTo: 0, sends: [] },         // 2 → master
    ]);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2));
    expect(order[order.length - 1]).toBe(0);
  });

  it('song mode: recorta notas a la ventana del clip y aplica swing', () => {
    const p = demoProject();
    p.swing = 0.5;
    const c = compileProject(p, { mode: 'song' });
    expect(c.events.length).toBeGreaterThan(10);
    expect(c.lengthBeats).toBe(8);
    // Los 1/16 impares del hat van desplazados por el swing (los pares, no).
    const hats = c.events.filter((e) => e.key === 42).sort((a, b) => a.start - b.start);
    expect(hats[0]!.start).toBeCloseTo(0, 5);
    expect(hats[1]!.start).toBeCloseTo(0.25 + 0.5 * 0.125, 5);
    expect(hats[2]!.start).toBeCloseTo(0.5, 5);
  });

  it('pattern mode: longitud redondeada a compás', () => {
    const p = demoProject();
    const c = compileProject(p, { mode: 'pattern', patternId: p.patternOrder[0]! });
    expect(c.lengthBeats).toBe(4);
  });

  it('mute de canal lo saca del render (audible=false)', () => {
    const p = demoProject();
    const chId = p.channelOrder[2]!;
    applyCommand(p, { type: 'patchChannel', channelId: chId, patch: { mute: true } });
    const c = compileProject(p, { mode: 'song' });
    expect(c.channels[2]!.audible).toBe(false);
  });
});

describe('render offline', () => {
  it('suena, sin NaN, sin clipping, y es determinista', () => {
    const p = demoProject();
    const compiled = compileProject(p, { mode: 'song' });
    const a = renderProject(compiled, { sampleRate: 44100, tailSeconds: 0.5 });
    const b = renderProject(compiled, { sampleRate: 44100, tailSeconds: 0.5 });

    expect(a.left.length).toBeGreaterThan(44100 * 3);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < a.left.length; i++) {
      const s = a.left[i]!;
      expect(Number.isNaN(s)).toBe(false);
      peak = Math.max(peak, Math.abs(s));
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / a.left.length);
    expect(peak).toBeGreaterThan(0.05); // hay señal
    expect(peak).toBeLessThanOrEqual(1.0); // limiter en master
    expect(rms).toBeGreaterThan(0.005);

    // Determinismo byte a byte.
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
    expect(Buffer.from(a.right.buffer).equals(Buffer.from(b.right.buffer))).toBe(true);
  });

  it('el sidechain agacha el saw cuando golpea el kick', () => {
    const p = demoProject();
    // Sin limiter en master: compensaría el ducking y taparía la medida.
    applyCommand(p, { type: 'setEffect', trackIndex: 0, slotIndex: 0, slot: null });
    const withSc = renderProject(compileProject(p, { mode: 'song' }), {
      sampleRate: 44100, tailSeconds: 0,
    });
    // Sin sidechain: mismo proyecto con el slot desactivado.
    applyCommand(p, {
      type: 'patchEffect', trackIndex: 3, slotIndex: 0, patch: { enabled: false },
    });
    const without = renderProject(compileProject(p, { mode: 'song' }), {
      sampleRate: 44100, tailSeconds: 0,
    });
    const rms = (x: Float32Array, from: number, to: number) => {
      let s = 0;
      for (let i = from; i < to; i++) s += x[i]! * x[i]!;
      return Math.sqrt(s / (to - from));
    };
    // Ventana justo tras el kick del beat 0 (~0..60 ms).
    const win = Math.floor(0.06 * 44100);
    expect(rms(withSc.left, 0, win)).toBeLessThan(rms(without.left, 0, win));
  });

  it('analyzeMix devuelve LUFS y bandas coherentes', () => {
    const p = demoProject();
    const r = renderProject(compileProject(p, { mode: 'song' }), { sampleRate: 44100 });
    const m = analyzeMix(r.left, r.right, 44100);
    expect(m.lufsIntegrated).toBeGreaterThan(-40);
    expect(m.lufsIntegrated).toBeLessThan(0);
    expect(m.peakDb).toBeLessThanOrEqual(0);
    expect(m.bands.low).toBeGreaterThan(-30); // hay low-end (808)
    expect(Math.abs(m.stereoCorrelation)).toBeLessThanOrEqual(1);
  });

  it('encodeWav produce un RIFF válido', () => {
    const l = new Float32Array(1000).fill(0.5);
    const wav = encodeWav(l, l, 44100, 16);
    expect(wav.length).toBe(44 + 1000 * 4);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
  });
});
