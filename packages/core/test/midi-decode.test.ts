import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  newId,
  type Note,
} from '../src/index';
import { encodeMidi } from '../src/midi/encode';
import { decodeMidi } from '../src/midi/decode';

// ── Helpers de construcción ──────────────────────────────────────────────────

function makeNote(start: number, duration: number, key: number, velocity = 0.8): Note {
  return { id: newId(), start, duration, key, velocity, pan: 0, slide: false };
}

function u16(v: number): number[] {
  return [(v >> 8) & 0xff, v & 0xff];
}

function u32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/** SMF a mano: cabecera MThd + un chunk MTrk por cada lista de bytes. */
function smf(format: number, division: number, tracks: number[][]): Uint8Array {
  const out = [
    0x4d, 0x54, 0x68, 0x64, // 'MThd'
    ...u32(6),
    ...u16(format),
    ...u16(tracks.length),
    ...u16(division),
  ];
  for (const t of tracks) out.push(0x4d, 0x54, 0x72, 0x6b, ...u32(t.length), ...t);
  return Uint8Array.from(out);
}

const EOT = [0x00, 0xff, 0x2f, 0x00];

// ── Tolerancias ──────────────────────────────────────────────────────────────

const TICK = 1 / 96; // timing: 1 tick a 96 PPQ
const VEL = 1 / 127; // velocity: 1 paso MIDI

/** Compara notas por (start, key) con tolerancia de timing y velocity. */
function expectNotesClose(actual: Note[], expected: Note[]): void {
  const byStart = (a: Note, b: Note): number => a.start - b.start || a.key - b.key;
  const as = [...actual].sort(byStart);
  const es = [...expected].sort(byStart);
  expect(as.length).toBe(es.length);
  for (let i = 0; i < es.length; i++) {
    const a = as[i]!;
    const e = es[i]!;
    expect(a.key).toBe(e.key);
    expect(Math.abs(a.start - e.start)).toBeLessThanOrEqual(TICK);
    expect(Math.abs(a.duration - e.duration)).toBeLessThanOrEqual(TICK);
    expect(Math.abs(a.velocity - e.velocity)).toBeLessThanOrEqual(VEL);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('decodeMidi: round-trip con encodeMidi', () => {
  it('recupera notas, tempo, compás, nombres y el canal de percusión', () => {
    const p = createEmptyProject('Demo');
    applyCommand(p, { type: 'setTempo', tempo: 87 });
    applyCommand(p, { type: 'setTimeSig', timeSig: { num: 6, den: 8 } });
    const drums = createChannel('drums', 0, 'Kit');
    const lead = createChannel('synth', 1, 'Lead');
    applyCommand(p, { type: 'addChannel', channel: drums });
    applyCommand(p, { type: 'addChannel', channel: lead });
    const patternId = p.patternOrder[0]!;
    const drumNotes = [
      makeNote(0, 0.25, 36),
      makeNote(1, 0.25, 38, 0.9),
      makeNote(2.5, 0.25, 42, 0.45),
    ];
    const leadNotes = [
      makeNote(0, 4, 48, 0.3), // nota larga
      makeNote(0.5, 0.5, 60, 0.6),
      makeNote(1.25, 0.75, 64, 1),
    ];
    applyCommand(p, { type: 'addNotes', patternId, channelId: drums.id, notes: drumNotes });
    applyCommand(p, { type: 'addNotes', patternId, channelId: lead.id, notes: leadNotes });

    const decoded = decodeMidi(encodeMidi(p, { mode: 'pattern', patternId }));

    // Conductor: título, tempo y compás sobreviven.
    expect(decoded.name).toBe('Demo');
    expect(decoded.tempo).toBeCloseTo(87, 3);
    expect(decoded.timeSig).toEqual({ num: 6, den: 8 });

    // Una pista por canal; drums vuelve como canal MIDI 9.
    expect(decoded.tracks.length).toBe(2);
    const drumTrack = decoded.tracks.find((t) => t.midiChannel === 9);
    const leadTrack = decoded.tracks.find((t) => t.midiChannel !== 9);
    expect(drumTrack?.name).toBe('Kit');
    expect(leadTrack?.name).toBe('Lead');
    expectNotesClose(drumTrack!.notes, drumNotes);
    expectNotesClose(leadTrack!.notes, leadNotes);

    // Ids nuevos y únicos (no se reutilizan los del proyecto).
    const sourceIds = new Set([...drumNotes, ...leadNotes].map((n) => n.id));
    const decodedIds = decoded.tracks.flatMap((t) => t.notes.map((n) => n.id));
    expect(new Set(decodedIds).size).toBe(decodedIds.length);
    for (const id of decodedIds) expect(sourceIds.has(id)).toBe(false);
  });
});

describe('decodeMidi: lectura de eventos', () => {
  it('soporta running status (note-on encadenados sin status byte)', () => {
    const track = [
      0x00, 0x90, 60, 100, // on 60 @0
      0x00, 64, 100, // running status: on 64 @0
      0x60, 60, 0, // running status: vel 0 = off 60 @96
      0x00, 64, 0, // running status: off 64 @96
      ...EOT,
    ];
    const d = decodeMidi(smf(0, 96, [track]));
    expect(d.tracks.length).toBe(1);
    expectNotesClose(d.tracks[0]!.notes, [
      makeNote(0, 1, 60, 100 / 127),
      makeNote(0, 1, 64, 100 / 127),
    ]);
  });

  it('note-on con velocity 0 cierra la nota', () => {
    const track = [
      0x00, 0x90, 60, 100,
      0x81, 0x40, 0x90, 60, 0, // delta 192 (VLQ multibyte), vel 0 = note-off
      ...EOT,
    ];
    const d = decodeMidi(smf(0, 96, [track]));
    expectNotesClose(d.tracks[0]!.notes, [makeNote(0, 2, 60, 100 / 127)]);
  });

  it('nota sin note-off se cierra al final de la pista', () => {
    const track = [
      0x00, 0x90, 60, 100, // on sin off
      0x60, 0xff, 0x2f, 0x00, // End of Track @96
    ];
    const d = decodeMidi(smf(0, 96, [track]));
    expectNotesClose(d.tracks[0]!.notes, [makeNote(0, 1, 60, 100 / 127)]);
  });

  it('duración <= 0 no se pierde: clamp a 1/96 de beat', () => {
    const track = [
      0x00, 0x90, 60, 100,
      0x00, 0x80, 60, 0, // off en el mismo tick
      ...EOT,
    ];
    const d = decodeMidi(smf(0, 96, [track]));
    const note = d.tracks[0]!.notes[0]!;
    expect(note.duration).toBe(1 / 96);
  });

  it('respeta la división del archivo (beats = ticks / división)', () => {
    const track = [
      0x00, 0x90, 60, 100,
      0x81, 0x70, 0x80, 60, 0, // delta 240 ticks a 480 PPQ = 0.5 beats
      ...EOT,
    ];
    const d = decodeMidi(smf(0, 480, [track]));
    expectNotesClose(d.tracks[0]!.notes, [makeNote(0, 0.5, 60, 100 / 127)]);
  });

  it('eventos ignorados (CC, program change, pitch bend, sysex, metas raros) no descarrilan', () => {
    const track = [
      0x00, 0xc0, 5, // program change
      0x00, 0x90, 60, 100, // on 60 @0
      0x00, 0xb0, 7, 100, // CC volumen
      0x10, 0xe0, 0x00, 0x40, // pitch bend @16
      0x00, 0xf0, 3, 1, 2, 3, // sysex de 3 bytes
      0x50, 0x80, 60, 64, // off 60 @96
      0x00, 0xff, 0x54, 5, 0, 0, 0, 0, 0, // meta desconocido (SMPTE offset)
      0x00, 0x90, 62, 90, // on 62 @96
      0x30, 0x80, 62, 0, // off 62 @144
      ...EOT,
    ];
    const d = decodeMidi(smf(0, 96, [track]));
    expectNotesClose(d.tracks[0]!.notes, [
      makeNote(0, 1, 60, 100 / 127),
      makeNote(1, 0.5, 62, 90 / 127),
    ]);
  });
});

describe('decodeMidi: formatos y metas', () => {
  it('formato 0 con dos canales → dos DecodedMidiTrack', () => {
    const track = [
      0x00, 0x99, 42, 90, // on hat, canal 9
      0x00, 0x90, 60, 100, // on, canal 0
      0x60, 0x89, 42, 64, // off canal 9 @96
      0x00, 0x80, 60, 64, // off canal 0 @96
      ...EOT,
    ];
    const d = decodeMidi(smf(0, 96, [track]));
    expect(d.tracks.map((t) => t.midiChannel)).toEqual([0, 9]);
    expectNotesClose(d.tracks[0]!.notes, [makeNote(0, 1, 60, 100 / 127)]);
    expectNotesClose(d.tracks[1]!.notes, [makeNote(0, 1, 42, 90 / 127)]);
  });

  it('formato 1: conductor → name/tempo, pista con notas → su track name', () => {
    const conductor = [
      0x00, 0xff, 0x03, 4, 0x53, 0x6f, 0x6e, 0x67, // name 'Song'
      0x00, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, // tempo 1_000_000 µs = 60 BPM
      0x00, 0xff, 0x58, 4, 3, 2, 24, 8, // compás 3/4
      ...EOT,
    ];
    const bass = [
      0x00, 0xff, 0x03, 4, 0x42, 0x61, 0x6a, 0x6f, // name 'Bajo'
      0x00, 0x91, 40, 100, // canal 1
      0x60, 0x81, 40, 0,
      ...EOT,
    ];
    const d = decodeMidi(smf(1, 96, [conductor, bass]));
    expect(d.name).toBe('Song');
    expect(d.tempo).toBeCloseTo(60, 6);
    expect(d.timeSig).toEqual({ num: 3, den: 4 });
    expect(d.tracks.length).toBe(1); // el conductor no tiene notas
    expect(d.tracks[0]!.name).toBe('Bajo');
    expect(d.tracks[0]!.midiChannel).toBe(1);
  });

  it('sin metas: tempo 120, compás 4/4, nombre vacío y "Pista N"', () => {
    const track = [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, ...EOT];
    const d = decodeMidi(smf(1, 96, [track]));
    expect(d.name).toBe('');
    expect(d.tempo).toBe(120);
    expect(d.timeSig).toEqual({ num: 4, den: 4 });
    expect(d.tracks[0]!.name).toBe('Pista 1');
  });
});

describe('decodeMidi: errores legibles', () => {
  it('división SMPTE → Error', () => {
    expect(() => decodeMidi(smf(0, 0xe250, [[...EOT]]))).toThrowError(/SMPTE/);
  });

  it('cabecera corrupta → Error', () => {
    const bad = smf(0, 96, [[...EOT]]);
    bad[3] = 0x58; // 'MThd' → 'MThX'
    expect(() => decodeMidi(bad)).toThrowError(/MThd/);
  });

  it('archivo truncado → Error', () => {
    const good = smf(0, 96, [[0x00, 0x90, 60, 100, ...EOT]]);
    expect(() => decodeMidi(good.subarray(0, good.length - 3))).toThrowError(/truncado/);
  });

  it('formato 2 → Error', () => {
    expect(() => decodeMidi(smf(2, 96, [[...EOT]]))).toThrowError(/formato SMF 2/);
  });
});
