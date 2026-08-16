import { describe, expect, it } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  newId,
  type Channel,
  type InstrumentKind,
  type Note,
  type Project,
} from '../src/index';
import { encodeMidi } from '../src/midi/encode';

// ── Helpers de construcción ──────────────────────────────────────────────────

function makeNote(start: number, duration: number, key: number, velocity = 0.8): Note {
  return { id: newId(), start, duration, key, velocity, pan: 0, slide: false };
}

/** Proyecto con un canal y notas en el primer patrón. */
function projectWith(
  notes: Note[],
  kind: InstrumentKind = 'synth',
  name = 'Lead',
): { p: Project; ch: Channel; patternId: string } {
  const p = createEmptyProject('Demo');
  applyCommand(p, { type: 'setTempo', tempo: 120 });
  const ch = createChannel(kind, 0, name);
  applyCommand(p, { type: 'addChannel', channel: ch });
  const patternId = p.patternOrder[0]!;
  applyCommand(p, { type: 'addNotes', patternId, channelId: ch.id, notes });
  return { p, ch, patternId };
}

function addClip(
  p: Project,
  patternId: string,
  start: number,
  length: number,
  muted = false,
): string {
  const trackId = Object.keys(p.playlistTracks)[0]!;
  const id = newId();
  applyCommand(p, {
    type: 'addClips',
    clips: [{ id, kind: 'pattern', playlistTrackId: trackId, start, length, muted, patternId }],
  });
  return id;
}

// ── Helpers de parseo SMF ────────────────────────────────────────────────────

interface Chunk {
  type: string;
  data: Uint8Array;
}

function readChunks(bytes: Uint8Array): Chunk[] {
  const chunks: Chunk[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const len =
      (bytes[pos + 4]! << 24) | (bytes[pos + 5]! << 16) | (bytes[pos + 6]! << 8) | bytes[pos + 7]!;
    chunks.push({ type, data: bytes.subarray(pos + 8, pos + 8 + len) });
    pos += 8 + len;
  }
  return chunks;
}

function readVlq(data: Uint8Array, pos: number): { value: number; next: number } {
  let value = 0;
  for (;;) {
    const byte = data[pos++]!;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: pos };
  }
}

interface ParsedEvent {
  tick: number;
  /** Bytes del evento sin el delta (status + datos, o meta completo). */
  bytes: number[];
}

/** Decodifica una pista (sin running status, como escribe el encoder). */
function parseTrack(data: Uint8Array): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  let pos = 0;
  let tick = 0;
  while (pos < data.length) {
    const delta = readVlq(data, pos);
    tick += delta.value;
    pos = delta.next;
    const status = data[pos]!;
    if (status === 0xff) {
      const type = data[pos + 1]!;
      const len = readVlq(data, pos + 2);
      const end = len.next + len.value;
      events.push({ tick, bytes: [...data.subarray(pos, end)] });
      pos = end;
    } else {
      expect(status).toBeGreaterThanOrEqual(0x80); // sin running status
      events.push({ tick, bytes: [...data.subarray(pos, pos + 3)] });
      pos += 3;
    }
  }
  return events;
}

/** Solo eventos de nota: [tick, status, key, velocity]. */
function noteEvents(data: Uint8Array): number[][] {
  return parseTrack(data)
    .filter((e) => e.bytes[0]! < 0xf0)
    .map((e) => [e.tick, ...e.bytes]);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('encodeMidi: cabecera y conductor', () => {
  it('MThd correcta: formato 1, nTracks, división 96', () => {
    const { p, patternId } = projectWith([makeNote(0, 1, 60)]);
    const bytes = encodeMidi(p, { mode: 'pattern', patternId });

    expect([...bytes.subarray(0, 4)]).toEqual([0x4d, 0x54, 0x68, 0x64]); // 'MThd'
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 6]);
    expect([...bytes.subarray(8, 10)]).toEqual([0, 1]); // formato 1
    expect([...bytes.subarray(10, 12)]).toEqual([0, 2]); // conductor + 1 canal
    expect([...bytes.subarray(12, 14)]).toEqual([0, 96]); // PPQ 96
  });

  it('conductor: nombre del proyecto, tempo y compás', () => {
    const { p, patternId } = projectWith([makeNote(0, 1, 60)]);
    const chunks = readChunks(encodeMidi(p, { mode: 'pattern', patternId }));
    expect(chunks.map((c) => c.type)).toEqual(['MThd', 'MTrk', 'MTrk']);

    const events = parseTrack(chunks[1]!.data);
    // Track name = título 'Demo'.
    expect(events[0]!.bytes).toEqual([0xff, 0x03, 4, 0x44, 0x65, 0x6d, 0x6f]);
    // Tempo 120 BPM → 500000 µs/negra = 0x07A120.
    expect(events[1]!.bytes).toEqual([0xff, 0x51, 3, 0x07, 0xa1, 0x20]);
    // Compás 4/4 → nn=4 dd=2 cc=24 bb=8.
    expect(events[2]!.bytes).toEqual([0xff, 0x58, 4, 4, 2, 24, 8]);
    // End of Track.
    expect(events[3]!.bytes).toEqual([0xff, 0x2f, 0]);
  });
});

describe('encodeMidi: mode pattern', () => {
  it('dos notas → note-on/note-off con deltas exactos', () => {
    const { p, patternId } = projectWith([
      makeNote(0, 1, 60), // ticks 0..96
      makeNote(1, 0.5, 62), // ticks 96..144
    ]);
    const chunks = readChunks(encodeMidi(p, { mode: 'pattern', patternId }));
    const data = chunks[2]!.data;

    // Nombre del canal 'Lead' y después los bytes crudos de los eventos.
    expect([...data]).toEqual([
      0x00, 0xff, 0x03, 0x04, 0x4c, 0x65, 0x61, 0x64, // delta 0, name 'Lead'
      0x00, 0x90, 60, 102, // delta 0: on 60 (vel 0.8 → 102)
      0x60, 0x80, 60, 0, // delta 96: off 60
      0x00, 0x90, 62, 102, // delta 0: on 62 (off antes que on en el empate)
      0x30, 0x80, 62, 0, // delta 48: off 62
      0x00, 0xff, 0x2f, 0x00, // End of Track
    ]);
  });

  it('velocity 0..1 → 1..127 con clamps', () => {
    const { p, patternId } = projectWith([
      makeNote(0, 1, 60, 0), // → 1
      makeNote(1, 1, 61, 0.5), // round(63)+1 → 64
      makeNote(2, 1, 62, 1), // → 127
      makeNote(3, 1, 63, 2), // fuera de rango → clamp 127
    ]);
    const chunks = readChunks(encodeMidi(p, { mode: 'pattern', patternId }));
    const ons = noteEvents(chunks[2]!.data).filter((e) => (e[1]! & 0xf0) === 0x90);
    expect(ons.map((e) => e[3])).toEqual([1, 64, 127, 127]);
  });

  it('VLQ multi-byte para deltas > 127 ticks', () => {
    const { p, patternId } = projectWith([makeNote(2, 1, 60)]); // tick 192
    const chunks = readChunks(encodeMidi(p, { mode: 'pattern', patternId }));
    const data = chunks[2]!.data;

    // Tras el name meta 'Lead' (8 bytes) viene el delta 192 = 0x81 0x40.
    expect([...data.subarray(8, 12)]).toEqual([0x81, 0x40, 0x90, 60]);
    const events = noteEvents(data);
    expect(events).toEqual([
      [192, 0x90, 60, 102],
      [288, 0x80, 60, 0],
    ]);
  });

  it('canal drums → canal MIDI 9; melódico → canal 0', () => {
    const drums = projectWith([makeNote(0, 1, 36)], 'drums', 'Kit');
    const drumTrack = readChunks(encodeMidi(drums.p, { mode: 'pattern', patternId: drums.patternId }))[2]!;
    expect(noteEvents(drumTrack.data)[0]![1]).toBe(0x99);

    const synth = projectWith([makeNote(0, 1, 60)]);
    const synthTrack = readChunks(encodeMidi(synth.p, { mode: 'pattern', patternId: synth.patternId }))[2]!;
    expect(noteEvents(synthTrack.data)[0]![1]).toBe(0x90);
  });
});

describe('encodeMidi: mode song', () => {
  it('desplaza por el inicio del clip y recorta al largo', () => {
    const { p, patternId } = projectWith([
      makeNote(1, 2, 60), // → beats 9..11
      makeNote(3, 4, 62), // excede el clip → se acorta a beats 11..12
      makeNote(5, 1, 64), // empieza fuera de la ventana → no va
    ]);
    addClip(p, patternId, 8, 4);

    const chunks = readChunks(encodeMidi(p, { mode: 'song' }));
    expect(chunks.length).toBe(3); // MThd + conductor + 1 canal
    expect(noteEvents(chunks[2]!.data)).toEqual([
      [864, 0x90, 60, 102], // beat 9
      [1056, 0x80, 60, 0], // beat 11 (off antes que on en el empate)
      [1056, 0x90, 62, 102], // beat 11
      [1152, 0x80, 62, 0], // beat 12: recortada al final del clip
    ]);
  });

  it('clip muted no suena (canal sin notas → sin pista)', () => {
    const { p, patternId } = projectWith([makeNote(0, 1, 60)]);
    addClip(p, patternId, 0, 4, true);

    const bytes = encodeMidi(p, { mode: 'song' });
    expect([...bytes.subarray(10, 12)]).toEqual([0, 1]); // solo el conductor
    expect(readChunks(bytes).map((c) => c.type)).toEqual(['MThd', 'MTrk']);
  });
});
