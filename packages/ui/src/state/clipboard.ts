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

/**
 * Clip sin id ni pista, con `start` relativo y `row` = filas por debajo de la
 * primera de lo copiado.
 *
 * `row` y no `lane`: `Clip.lane` ya existe y es OTRA cosa —el carril de toma
 * dentro de una misma pista (comping)—. Llamarlos igual hacía que empaquetar
 * pisara el carril de toma y que al pegar se perdiera.
 */
export type PackedClip = Omit<Clip, 'id' | 'playlistTrackId'> & { row: number };

export interface ClipsPayload {
  kind: 'clips';
  span: number;
  /** Cuántas filas ocupa lo copiado (1 = todo en la misma pista). */
  rows: number;
  /** Fila donde estaba la primera: destino por defecto si nadie dice otra. */
  homeRow: number;
  clips: PackedClip[];
}

/** Lo justo para empaquetar: el clip y en qué fila de la playlist estaba. */
export interface ClipWithRow {
  clip: Clip;
  row: number;
}

export function packClips(items: readonly ClipWithRow[]): ClipsPayload | null {
  if (items.length === 0) return null;
  let minBeat = Infinity;
  let maxBeat = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const { clip, row } of items) {
    if (clip.start < minBeat) minBeat = clip.start;
    if (clip.start + clip.length > maxBeat) maxBeat = clip.start + clip.length;
    if (row < minRow) minRow = row;
    if (row > maxRow) maxRow = row;
  }
  return {
    kind: 'clips',
    span: maxBeat - minBeat,
    rows: maxRow - minRow + 1,
    homeRow: minRow,
    clips: items.map(({ clip, row }) => {
      const { id: _id, playlistTrackId: _t, frozenFrom: _f, ...rest } = clip;
      return {
        ...rest,
        // Los puntos de automatización se clonan de verdad: compartir el array
        // haría que editar la copia moviera la curva del original.
        ...(rest.points ? { points: rest.points.map((p) => ({ ...p })) } : null),
        start: rest.start - minBeat,
        row: row - minRow,
      };
    }),
  };
}

/**
 * Materializa los clips en `atBeat` y a partir de la fila `atRow`.
 *
 * Si lo copiado no cabe hacia abajo, el grupo ENTERO sube lo justo para caber
 * (misma regla que `clampGroupMove` al arrastrar). Si ni así cabe —se copiaron
 * más pistas de las que hay ahora— se quedan fuera las de abajo, que es lo
 * único que se puede hacer sin inventar pistas.
 *
 * `frozenFrom` no viaja (se descarta al empaquetar): apunta a los clips que
 * una pista congelada dejó escondidos, y una copia que dijera ser dueña de
 * ellos descongelaría encima del original.
 */
export function unpackClips(
  payload: ClipsPayload,
  atBeat: number,
  atRow: number,
  trackIds: readonly string[],
): Clip[] {
  if (trackIds.length === 0) return [];
  const base = Math.max(0, atBeat);
  const wanted = Math.max(0, atRow);
  const overflow = wanted + payload.rows - trackIds.length;
  const row0 = overflow > 0 ? Math.max(0, wanted - overflow) : wanted;

  const out: Clip[] = [];
  for (const c of payload.clips) {
    const trackId = trackIds[row0 + c.row];
    if (trackId === undefined) continue; // no cabe: se queda fuera
    const { row: _row, ...rest } = c;
    out.push({
      ...rest,
      ...(rest.points ? { points: rest.points.map((p) => ({ ...p })) } : null),
      id: newId(),
      playlistTrackId: trackId,
      start: base + rest.start,
    });
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
