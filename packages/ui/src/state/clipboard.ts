/**
 * Portapapeles de la app (notas del Piano Roll y clips de la Playlist).
 *
 * No es el del sistema: lo que viaja son entidades del modelo, no texto, y
 * pegarlas tiene que crear ids nuevos. El del sistema entra por otro sitio el
 * día que se quiera copiar entre dos ventanas de Orbit; aquí lo que importa es
 * que copiar y pegar dentro de la sesión sea exacto.
 *
 * Lo que se guarda va SIEMPRE normalizado: el primer beat de la selección pasa
 * a ser el 0 y la pista más alta la 0. Así pegar es una suma —el punto de
 * destino más el offset guardado— y la separación entre las notas o entre las
 * pistas se conserva sola.
 */

import { newId, type Clip, type Note } from '@orbit/core';
import { create } from 'zustand';

// ── Notas ────────────────────────────────────────────────────────────────────

/** Nota sin id, con `start` relativo al principio de lo copiado. */
export type PackedNote = Omit<Note, 'id'>;

export interface NotesPayload {
  kind: 'notes';
  /** De dónde salieron (solo informativo, para el aviso). */
  channelName: string;
  /** Beats que ocupa lo copiado, del primer inicio al último final. */
  span: number;
  notes: PackedNote[];
}

/** Normaliza la selección al 0. Devuelve null si no hay nada que copiar. */
export function packNotes(notes: readonly Note[], channelName = ''): NotesPayload | null {
  if (notes.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes) {
    if (n.start < min) min = n.start;
    if (n.start + n.duration > max) max = n.start + n.duration;
  }
  return {
    kind: 'notes',
    channelName,
    span: max - min,
    notes: notes.map(({ id: _id, ...rest }) => ({ ...rest, start: rest.start - min })),
  };
}

/**
 * Materializa lo copiado en `atBeat`, con ids nuevos.
 *
 * `atBeat` puede ser negativo si el usuario pega con el caret antes del 0: el
 * grupo se desplaza ENTERO hasta apoyarlo en el 0, no se acota nota a nota
 * (acotando una a una, las de la izquierda se clavan y el acorde se cierra).
 */
export function unpackNotes(payload: NotesPayload, atBeat: number): Note[] {
  const base = Math.max(0, atBeat);
  return payload.notes.map((n) => ({ ...n, id: newId(), start: base + n.start }));
}

// ── Clips ────────────────────────────────────────────────────────────────────

/** Clip sin id ni pista, con `start` relativo y `lane` = filas por debajo de la primera. */
export type PackedClip = Omit<Clip, 'id' | 'playlistTrackId'> & { lane: number };

export interface ClipsPayload {
  kind: 'clips';
  span: number;
  /** Cuántas filas ocupa lo copiado (1 = todo en la misma pista). */
  lanes: number;
  clips: PackedClip[];
}

/** Lo justo para empaquetar: el clip y en qué fila estaba. */
export interface ClipWithLane {
  clip: Clip;
  lane: number;
}

export function packClips(items: readonly ClipWithLane[]): ClipsPayload | null {
  if (items.length === 0) return null;
  let minBeat = Infinity;
  let maxBeat = -Infinity;
  let minLane = Infinity;
  let maxLane = -Infinity;
  for (const { clip, lane } of items) {
    if (clip.start < minBeat) minBeat = clip.start;
    if (clip.start + clip.length > maxBeat) maxBeat = clip.start + clip.length;
    if (lane < minLane) minLane = lane;
    if (lane > maxLane) maxLane = lane;
  }
  return {
    kind: 'clips',
    span: maxBeat - minBeat,
    lanes: maxLane - minLane + 1,
    clips: items.map(({ clip, lane }) => {
      const { id: _id, playlistTrackId: _t, ...rest } = clip;
      return { ...rest, start: rest.start - minBeat, lane: lane - minLane };
    }),
  };
}

/**
 * Materializa los clips en `atBeat` y a partir de la fila `atLane`.
 *
 * Si lo copiado no cabe hacia abajo, el grupo ENTERO sube lo justo para caber
 * (misma regla que `clampGroupMove` al arrastrar). Si ni así cabe —se copiaron
 * más pistas de las que hay ahora— se quedan fuera las de abajo, que es lo
 * único que se puede hacer sin inventar pistas.
 */
export function unpackClips(
  payload: ClipsPayload,
  atBeat: number,
  atLane: number,
  trackIds: readonly string[],
): Clip[] {
  if (trackIds.length === 0) return [];
  const base = Math.max(0, atBeat);
  const wanted = Math.max(0, atLane);
  const overflow = wanted + payload.lanes - trackIds.length;
  const lane0 = overflow > 0 ? Math.max(0, wanted - overflow) : wanted;

  const out: Clip[] = [];
  for (const c of payload.clips) {
    const trackId = trackIds[lane0 + c.lane];
    if (trackId === undefined) continue; // no cabe: se queda fuera
    const { lane: _lane, ...rest } = c;
    out.push({ ...rest, id: newId(), playlistTrackId: trackId, start: base + rest.start });
  }
  return out;
}

// ── El portapapeles vivo ─────────────────────────────────────────────────────

export type ClipboardPayload = NotesPayload | ClipsPayload;

interface ClipboardState {
  /** Lo último copiado, o null si no se ha copiado nada en esta sesión. */
  payload: ClipboardPayload | null;
}

/**
 * Store y no una variable de módulo porque el menú Editar tiene que saber si
 * "Pegar" va habilitado: sin suscripción, la entrada se queda gris hasta que
 * algo más provoque un render.
 */
export const useClipboard = create<ClipboardState>(() => ({ payload: null }));

export function setClipboard(payload: ClipboardPayload | null): void {
  if (payload === null) return; // copiar sin selección no borra lo que ya había
  useClipboard.setState({ payload });
}

export function readClipboard(): ClipboardPayload | null {
  return useClipboard.getState().payload;
}

/** Qué hay guardado, para el enable/disable y la etiqueta del menú. */
export function clipboardKind(): 'notes' | 'clips' | null {
  return useClipboard.getState().payload?.kind ?? null;
}
