/**
 * Codificador de MIDI multipista (Standard MIDI File, formato 1).
 *
 * Convierte un `Project` de Orbit Studio a bytes .mid reproducibles en
 * cualquier DAW. Solo depende de los tipos de @orbit/core (nada de engine).
 *
 * Decisiones:
 * - División fija de 96 PPQ (`PPQ` del modelo): tick = round(beat * 96).
 * - Formato 1: track 0 = conductor (nombre, tempo, compás), después una
 *   pista por canal del proyecto que tenga notas en el resultado.
 * - Sin running status: cada evento lleva su status byte (más compatible).
 * - Canal MIDI: los canales `kind === 'drums'` van al canal 9 (percusión GM);
 *   el resto se reparte secuencialmente por 0..8,10..15 (módulo 15).
 * - Empates de tick: note-off antes que note-on para que una nota repetida
 *   se suelte antes de re-dispararse.
 * - `mode: 'song'` replica la semántica de clips del motor (compile.ts):
 *   solo el arrangement activo, se saltan clips y pistas muteadas, cada nota
 *   se desplaza por el inicio del clip y se recorta a la ventana
 *   [patternOffset, patternOffset + length). El swing NO se aplica al export.
 */

import type { Note, Project } from '../model/types';
import { PPQ } from '../model/types';

export interface EncodeMidiOptions {
  mode: 'song' | 'pattern';
  /** Requerido cuando mode === 'pattern'. */
  patternId?: string;
}

// ── Utilidades de bytes ──────────────────────────────────────────────────────

class ByteWriter {
  private bytes: number[] = [];

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  u16(v: number): void {
    this.bytes.push((v >>> 8) & 0xff, v & 0xff);
  }

  u32(v: number): void {
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }

  /** Delta time en variable-length quantity (7 bits útiles por byte). */
  vlq(value: number): void {
    let v = Math.max(0, Math.floor(value));
    const out: number[] = [v & 0x7f];
    v >>>= 7;
    while (v > 0) {
      out.unshift((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    this.bytes.push(...out);
  }

  raw(data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.bytes.push(data[i]! & 0xff);
  }

  get length(): number {
    return this.bytes.length;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function metaText(w: ByteWriter, type: number, text: string): void {
  const data = new TextEncoder().encode(text);
  w.vlq(0); // delta
  w.u8(0xff);
  w.u8(type);
  w.vlq(data.length);
  w.raw(data);
}

function endOfTrack(w: ByteWriter): void {
  w.vlq(0);
  w.u8(0xff);
  w.u8(0x2f);
  w.u8(0x00);
}

function trackChunk(out: ByteWriter, body: ByteWriter): void {
  out.raw([0x4d, 0x54, 0x72, 0x6b]); // 'MTrk'
  out.u32(body.length);
  out.raw(body.toUint8Array());
}

// ── Recolección de notas ─────────────────────────────────────────────────────

/** Nota ya resuelta a tiempo absoluto del resultado (beats). */
interface NoteSpan {
  start: number;
  duration: number;
  key: number;
  velocity: number;
}

/** Ventana de recorte de un clip (beats relativos al patrón). */
interface ClipWindow {
  offset: number;
  length: number;
}

/**
 * Añade las notas de un patrón a `byChannel`, desplazadas `atBeat` y
 * recortadas a `window` (misma semántica que compile.ts del motor).
 */
function collectPatternNotes(
  project: Project,
  patternId: string,
  atBeat: number,
  window: ClipWindow | null,
  byChannel: Map<string, NoteSpan[]>,
): void {
  const pattern = project.patterns[patternId];
  if (!pattern) return;
  for (const [channelId, notes] of Object.entries(pattern.notes)) {
    if (!project.channels[channelId]) continue;
    for (const note of notes as Note[]) {
      let start = note.start;
      let duration = note.duration;
      if (window) {
        const winEnd = window.offset + window.length;
        const noteEnd = note.start + note.duration;
        if (noteEnd <= window.offset || note.start >= winEnd) continue;
        const clippedStart = Math.max(note.start, window.offset);
        const clippedEnd = Math.min(noteEnd, winEnd);
        start = clippedStart - window.offset;
        duration = clippedEnd - clippedStart;
      }
      if (duration <= 0) continue;
      let spans = byChannel.get(channelId);
      if (!spans) {
        spans = [];
        byChannel.set(channelId, spans);
      }
      spans.push({
        start: atBeat + start,
        duration,
        key: note.key,
        velocity: note.velocity,
      });
    }
  }
}

/** Notas del resultado, agrupadas por canal del proyecto. */
function collectNotes(project: Project, opts: EncodeMidiOptions): Map<string, NoteSpan[]> {
  const byChannel = new Map<string, NoteSpan[]>();

  if (opts.mode === 'pattern') {
    if (!opts.patternId) {
      throw new Error("encodeMidi: mode 'pattern' requiere patternId");
    }
    if (!project.patterns[opts.patternId]) {
      throw new Error(`encodeMidi: patrón desconocido ${opts.patternId}`);
    }
    collectPatternNotes(project, opts.patternId, 0, null, byChannel);
    return byChannel;
  }

  // mode 'song': clips de patrón del arrangement activo, sin muteados.
  const activeTracks = new Set(
    Object.values(project.playlistTracks)
      .filter((t) => t.arrangementId === project.activeArrangementId && !t.muted)
      .map((t) => t.id),
  );
  for (const clip of Object.values(project.clips)) {
    if (clip.kind !== 'pattern' || !clip.patternId) continue;
    if (clip.muted || !activeTracks.has(clip.playlistTrackId)) continue;
    collectPatternNotes(project, clip.patternId, clip.start, {
      offset: clip.patternOffset ?? 0,
      length: clip.length,
    }, byChannel);
  }
  return byChannel;
}

// ── Codificación de pistas ───────────────────────────────────────────────────

const NOTE_OFF = 0; // ordena antes que note-on en empates de tick
const NOTE_ON = 1;

interface MidiEvent {
  tick: number;
  kind: typeof NOTE_OFF | typeof NOTE_ON;
  key: number;
  velocity: number; // byte MIDI ya resuelto (note-off = 0)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 0..1 → 1..127 (round(v*126)+1 con clamp). */
function velocityByte(velocity: number): number {
  return clamp(Math.round(velocity * 126) + 1, 1, 127);
}

function beatToTick(beat: number): number {
  return Math.round(beat * PPQ);
}

/** Canales MIDI melódicos: todos menos el 9 (reservado a percusión GM). */
const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15] as const;

function encodeChannelTrack(
  name: string,
  midiChannel: number,
  spans: NoteSpan[],
): ByteWriter {
  const events: MidiEvent[] = [];
  for (const span of spans) {
    const key = clamp(Math.round(span.key), 0, 127);
    const onTick = beatToTick(span.start);
    // Garantiza al menos 1 tick de duración para no soltar antes de sonar.
    const offTick = Math.max(onTick + 1, beatToTick(span.start + span.duration));
    events.push({ tick: onTick, kind: NOTE_ON, key, velocity: velocityByte(span.velocity) });
    events.push({ tick: offTick, kind: NOTE_OFF, key, velocity: 0 });
  }
  events.sort((a, b) => a.tick - b.tick || a.kind - b.kind || a.key - b.key);

  const w = new ByteWriter();
  metaText(w, 0x03, name);
  let lastTick = 0;
  for (const ev of events) {
    w.vlq(ev.tick - lastTick);
    lastTick = ev.tick;
    w.u8((ev.kind === NOTE_ON ? 0x90 : 0x80) | (midiChannel & 0x0f));
    w.u8(ev.key);
    w.u8(ev.velocity);
  }
  endOfTrack(w);
  return w;
}

/** Tempo meta 0x51: microsegundos por negra. */
function tempoBytes(bpm: number): number[] {
  const us = clamp(Math.round(60_000_000 / bpm), 1, 0xffffff);
  return [0xff, 0x51, 0x03, (us >>> 16) & 0xff, (us >>> 8) & 0xff, us & 0xff];
}

/** Compás meta 0x58: nn dd(pot. de 2) cc=24 clocks/click bb=8 fusas por negra. */
function timeSigBytes(num: number, den: number): number[] {
  const denPow = clamp(Math.round(Math.log2(den)), 0, 7);
  return [0xff, 0x58, 0x04, clamp(num, 1, 255), denPow, 24, 8];
}

function encodeConductorTrack(project: Project, includeMarkers: boolean): ByteWriter {
  const w = new ByteWriter();
  const title = project.meta.title.trim() !== '' ? project.meta.title : 'Orbit Studio';
  metaText(w, 0x03, title);

  const events: { tick: number; bytes: number[] }[] = [
    { tick: 0, bytes: tempoBytes(project.tempo) },
    { tick: 0, bytes: timeSigBytes(project.timeSig.num, project.timeSig.den) },
  ];

  // Cambios de tempo/compás de los marcadores del timeline. El motor los honra
  // (compile.ts arma un mapa de tempo/compás); sin esto el .mid exportado sonaba
  // TODO al tempo inicial, desincronizado de lo que el usuario oye en Orbit.
  // Solo en song: en pattern las notas son relativas al patrón y los marcadores
  // del timeline de canción no aplican.
  if (includeMarkers) {
    const markers = Object.values(project.markers)
      .filter((m) => m.tempo !== undefined || m.timeSigNum !== undefined)
      .sort((a, b) => a.time - b.time);
    for (const m of markers) {
      const tick = Math.max(0, Math.round(m.time * PPQ));
      if (m.tempo !== undefined) events.push({ tick, bytes: tempoBytes(m.tempo) });
      if (m.timeSigNum !== undefined) {
        events.push({ tick, bytes: timeSigBytes(m.timeSigNum, project.timeSig.den) });
      }
    }
  }

  // Estable por tick (Array.sort lo es): en el mismo tick, tempo antes que compás
  // por el orden en que se empujaron.
  events.sort((a, b) => a.tick - b.tick);
  let lastTick = 0;
  for (const ev of events) {
    w.vlq(ev.tick - lastTick);
    lastTick = ev.tick;
    w.raw(ev.bytes);
  }

  endOfTrack(w);
  return w;
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Codifica el proyecto como Standard MIDI File (formato 1, 96 PPQ).
 * - `mode: 'pattern'`: las notas de `patternId`, con start relativo al patrón.
 * - `mode: 'song'`: los clips de patrón del arrangement activo.
 */
export function encodeMidi(project: Project, opts: EncodeMidiOptions): Uint8Array {
  const byChannel = collectNotes(project, opts);

  // Pistas en el orden de canales del proyecto; solo canales con notas.
  const tracks: ByteWriter[] = [encodeConductorTrack(project, opts.mode === 'song')];
  let melodicIndex = 0;
  for (const channelId of project.channelOrder) {
    const channel = project.channels[channelId];
    const spans = byChannel.get(channelId);
    if (!channel || !spans || spans.length === 0) continue;
    const midiChannel =
      channel.kind === 'drums'
        ? 9
        : MELODIC_CHANNELS[melodicIndex++ % MELODIC_CHANNELS.length]!;
    tracks.push(encodeChannelTrack(channel.name, midiChannel, spans));
  }

  const out = new ByteWriter();
  out.raw([0x4d, 0x54, 0x68, 0x64]); // 'MThd'
  out.u32(6);
  out.u16(1); // formato 1
  out.u16(tracks.length);
  out.u16(PPQ); // división: ticks por negra
  for (const track of tracks) trackChunk(out, track);
  return out.toUint8Array();
}
