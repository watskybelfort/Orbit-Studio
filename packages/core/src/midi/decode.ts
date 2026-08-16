/**
 * Decodificador de MIDI (Standard MIDI File, formatos 0 y 1).
 *
 * Contraparte de encode.ts: convierte bytes .mid en notas del modelo de
 * Orbit Studio (start/duration en beats, velocity 0..1, ids nuevos).
 * Está pensado para archivos de terceros (FL Studio, etc.), no solo los
 * nuestros: soporta running status, y los eventos que no interesan
 * (program change, CC, pitch bend, sysex, metas desconocidos) se saltan
 * con corrección de longitud sin descarrilar el parser.
 *
 * Decisiones:
 * - Solo división ticks-por-negra; SMPTE lanza Error. beats = ticks / división.
 * - Note-on con velocity 0 = note-off (convención MIDI). El emparejamiento
 *   on/off es FIFO por (canal, key); las notas sin off se cierran al final
 *   de la pista. Duraciones <= 0 no se pierden: se clampan a 1/96 de beat.
 * - Metas leídos: 0x51 tempo (el primero del archivo), 0x58 compás (el
 *   primero), 0x03 nombre de pista, 0x2F fin de pista.
 * - Formato 0: la única pista se separa lógicamente en una DecodedMidiTrack
 *   por canal MIDI usado; su track name va a DecodedMidi.name.
 * - Formato 1: una DecodedMidiTrack por pista con notas; midiChannel es el
 *   canal dominante (más notas; empate → el más bajo).
 */

import { newId } from '../ids';
import type { Note } from '../model/types';

// ── API pública ──────────────────────────────────────────────────────────────

export interface DecodedMidiTrack {
  /** Meta track name (0x03), o 'Pista N'. */
  name: string;
  /** Canal MIDI dominante de la pista (0-15; 9 = percusión GM). */
  midiChannel: number;
  /** Notas en beats según la división del archivo; velocity 0..1; ids nuevos. */
  notes: Note[];
}

export interface DecodedMidi {
  /** Track name del conductor, o ''. */
  name: string;
  /** BPM del primer meta tempo, o 120. */
  tempo: number;
  /** Primer meta time signature, o 4/4. */
  timeSig: { num: number; den: number };
  /** Solo pistas con notas. */
  tracks: DecodedMidiTrack[];
}

// ── Lectura de bytes ─────────────────────────────────────────────────────────

class ByteReader {
  private pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get atEnd(): boolean {
    return this.pos >= this.bytes.length;
  }

  private need(count: number): void {
    if (this.pos + count > this.bytes.length) {
      throw new Error('decodeMidi: archivo MIDI truncado (se esperaban más bytes)');
    }
  }

  u8(): number {
    this.need(1);
    return this.bytes[this.pos++]!;
  }

  /** Mira el siguiente byte sin consumirlo. */
  peek(): number {
    this.need(1);
    return this.bytes[this.pos]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0;
  }

  /** Variable-length quantity (7 bits útiles por byte, máximo 4 bytes). */
  vlq(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('decodeMidi: VLQ inválido (más de 4 bytes)');
  }

  slice(length: number): Uint8Array {
    this.need(length);
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  skip(length: number): void {
    this.need(length);
    this.pos += length;
  }
}

// ── Parseo de una pista ──────────────────────────────────────────────────────

/** Nota emparejada, todavía en ticks del archivo. */
interface RawNote {
  startTick: number;
  endTick: number;
  key: number;
  /** Byte MIDI 1..127. */
  velocity: number;
  channel: number;
}

interface ParsedTrack {
  name: string | null;
  /** BPM del primer meta 0x51 de la pista. */
  tempo: number | null;
  timeSig: { num: number; den: number } | null;
  notes: RawNote[];
}

/**
 * Bytes de datos de los eventos system common/realtime 0xF0..0xFF que no
 * tratamos aparte (F0/F7 sysex y FF meta se manejan antes de llegar aquí).
 */
const SYSTEM_DATA_BYTES = [0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as const;

function parseTrack(data: Uint8Array): ParsedTrack {
  const r = new ByteReader(data);
  /** Colas FIFO de note-on abiertos, por slot canal*128 + key. */
  const open = new Map<number, { startTick: number; velocity: number }[]>();
  const notes: RawNote[] = [];
  let name: string | null = null;
  let tempo: number | null = null;
  let timeSig: { num: number; den: number } | null = null;
  let tick = 0;
  let runningStatus: number | null = null;

  const closeNote = (channel: number, key: number): void => {
    const started = open.get(channel * 128 + key)?.shift();
    // Note-off sin note-on previo: se ignora.
    if (!started) return;
    notes.push({
      startTick: started.startTick,
      endTick: tick,
      key,
      velocity: started.velocity,
      channel,
    });
  };

  parse: while (!r.atEnd) {
    tick += r.vlq();
    let status = r.peek();
    if (status >= 0x80) {
      r.u8();
      // Sysex y meta cancelan el running status; los de canal lo fijan.
      runningStatus = status < 0xf0 ? status : null;
    } else {
      // Running status: byte de datos, se reutiliza el último status de canal.
      if (runningStatus === null) {
        throw new Error('decodeMidi: byte de datos sin status previo (running status inválido)');
      }
      status = runningStatus;
    }

    if (status === 0xff) {
      const type = r.u8();
      const body = r.slice(r.vlq());
      switch (type) {
        case 0x2f: // End of Track
          break parse;
        case 0x03:
          if (name === null) name = new TextDecoder().decode(body);
          break;
        case 0x51:
          if (tempo === null && body.length >= 3) {
            const usPerQuarter = (body[0]! << 16) | (body[1]! << 8) | body[2]!;
            if (usPerQuarter > 0) tempo = 60_000_000 / usPerQuarter;
          }
          break;
        case 0x58:
          if (timeSig === null && body.length >= 2) {
            timeSig = { num: body[0]!, den: 2 ** body[1]! };
          }
          break;
        default:
          break; // meta desconocido: ya saltado por la longitud
      }
      continue;
    }

    if (status === 0xf0 || status === 0xf7) {
      r.skip(r.vlq()); // sysex: longitud + datos
      continue;
    }

    const kind = status & 0xf0;
    const channel = status & 0x0f;
    switch (kind) {
      case 0x90: {
        const key = r.u8() & 0x7f;
        const velocity = r.u8() & 0x7f;
        if (velocity === 0) {
          closeNote(channel, key); // note-on con velocity 0 = note-off
          break;
        }
        const slot = channel * 128 + key;
        let queue = open.get(slot);
        if (!queue) {
          queue = [];
          open.set(slot, queue);
        }
        queue.push({ startTick: tick, velocity });
        break;
      }
      case 0x80: {
        const key = r.u8() & 0x7f;
        r.u8(); // release velocity: no nos interesa
        closeNote(channel, key);
        break;
      }
      case 0xa0: // aftertouch polifónico
      case 0xb0: // control change
      case 0xe0: // pitch bend
        r.skip(2);
        break;
      case 0xc0: // program change
      case 0xd0: // aftertouch de canal
        r.skip(1);
        break;
      default:
        // System common/realtime 0xF1..0xFE (no deberían aparecer en un SMF).
        r.skip(SYSTEM_DATA_BYTES[status - 0xf0] ?? 0);
        break;
    }
  }

  // Notas sin note-off: se cierran al final de la pista.
  for (const [slot, queue] of open) {
    const channel = Math.floor(slot / 128);
    const key = slot % 128;
    for (const started of queue) {
      notes.push({ startTick: started.startTick, endTick: tick, key, velocity: started.velocity, channel });
    }
  }

  return { name, tempo, timeSig, notes };
}

// ── Ensamblado del resultado ─────────────────────────────────────────────────

/** Duración mínima de una nota decodificada (1/96 de beat). */
const MIN_NOTE_BEATS = 1 / 96;

function sortNotes(notes: Note[]): Note[] {
  return notes.sort((a, b) => a.start - b.start || a.key - b.key);
}

/** Canal con más notas; empate → el más bajo. */
function dominantChannel(notes: RawNote[]): number {
  const counts = new Map<number, number>();
  for (const note of notes) counts.set(note.channel, (counts.get(note.channel) ?? 0) + 1);
  let channel = 0;
  let best = -1;
  for (const [ch, count] of counts) {
    if (count > best || (count === best && ch < channel)) {
      channel = ch;
      best = count;
    }
  }
  return channel;
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Decodifica un Standard MIDI File (formato 0 o 1) a notas del modelo.
 * Lanza Error (en español) si la cabecera no es MThd, el archivo está
 * truncado, la división es SMPTE o el formato no está soportado.
 */
export function decodeMidi(bytes: Uint8Array): DecodedMidi {
  const r = new ByteReader(bytes);

  // Cabecera MThd.
  const headerType = String.fromCharCode(...r.slice(4));
  if (headerType !== 'MThd') {
    throw new Error('decodeMidi: cabecera inválida — el archivo no empieza por "MThd" (¿seguro que es un .mid?)');
  }
  const headerLength = r.u32();
  if (headerLength < 6) {
    throw new Error('decodeMidi: cabecera MThd demasiado corta');
  }
  const format = r.u16();
  r.u16(); // nTracks declarado: se ignora, se leen los chunks reales
  const division = r.u16();
  r.skip(headerLength - 6); // cabeceras extendidas: se salta el resto

  if (format !== 0 && format !== 1) {
    throw new Error(`decodeMidi: formato SMF ${format} no soportado (solo formato 0 y 1)`);
  }
  if ((division & 0x8000) !== 0) {
    throw new Error('decodeMidi: división SMPTE no soportada — solo archivos con ticks por negra');
  }
  if (division === 0) {
    throw new Error('decodeMidi: división inválida (0 ticks por negra)');
  }

  // Chunks: MTrk se parsea; los desconocidos se saltan (el spec lo permite).
  const parsed: ParsedTrack[] = [];
  while (!r.atEnd) {
    const type = String.fromCharCode(...r.slice(4));
    const body = r.slice(r.u32());
    if (type === 'MTrk') parsed.push(parseTrack(body));
  }

  const toNote = (raw: RawNote): Note => ({
    id: newId(),
    start: raw.startTick / division,
    duration: Math.max((raw.endTick - raw.startTick) / division, MIN_NOTE_BEATS),
    key: raw.key,
    velocity: raw.velocity / 127,
    pan: 0,
    slide: false,
  });

  const tracks: DecodedMidiTrack[] = [];
  if (format === 0) {
    // La única pista se separa lógicamente: una DecodedMidiTrack por canal.
    const byChannel = new Map<number, RawNote[]>();
    for (const track of parsed) {
      for (const raw of track.notes) {
        let list = byChannel.get(raw.channel);
        if (!list) {
          list = [];
          byChannel.set(raw.channel, list);
        }
        list.push(raw);
      }
    }
    for (const channel of [...byChannel.keys()].sort((a, b) => a - b)) {
      tracks.push({
        name: `Pista ${tracks.length + 1}`,
        midiChannel: channel,
        notes: sortNotes(byChannel.get(channel)!.map(toNote)),
      });
    }
  } else {
    for (const track of parsed) {
      if (track.notes.length === 0) continue;
      tracks.push({
        name: track.name ?? `Pista ${tracks.length + 1}`,
        midiChannel: dominantChannel(track.notes),
        notes: sortNotes(track.notes.map(toNote)),
      });
    }
  }

  return {
    name: parsed[0]?.name ?? '',
    tempo: parsed.find((t) => t.tempo !== null)?.tempo ?? 120,
    timeSig: parsed.find((t) => t.timeSig !== null)?.timeSig ?? { num: 4, den: 4 },
    tracks,
  };
}
