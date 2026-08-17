/**
 * Modos de herramienta del Piano Roll (paridad FL) y la lógica pura que usan.
 *
 * Aquí no hay React ni canvas: solo geometría y transformaciones de notas, para
 * que PianoRoll.tsx se quede con el dibujo y los gestos.
 */

import { newId, type Note, type NotePatch } from '@orbit/core';

export type PianoRollTool = 'draw' | 'brush' | 'slice';

/** Orden del selector de la toolbar. Los atajos son los de FL (P / B / C). */
export const TOOLS: { id: PianoRollTool; label: string; key: string; hint: string }[] = [
  {
    id: 'draw',
    label: 'Dibujar',
    key: 'KeyP',
    hint: 'Dibujar (P): crear, mover y redimensionar notas',
  },
  {
    id: 'brush',
    label: 'Pincel',
    key: 'KeyB',
    hint: 'Pincel (B): arrastra para pintar notas seguidas en la rejilla; con el botón derecho borra lo que toques',
  },
  {
    id: 'slice',
    label: 'Cortar',
    key: 'KeyC',
    hint: 'Cortar (C): arrastra una línea y parte en dos las notas que cruce',
  },
];

/** Tolerancia de tiempo en beats (misma escala que note-tools). */
const EPS = 1e-6;
/** Trozo mínimo que puede dejar un corte, en beats: menos que eso no se corta. */
const MIN_PIECE = 1 / 64;

// ── Pincel ───────────────────────────────────────────────────────────────────

/** ¿Ya hay una nota de esa fila sonando en ese beat? El pincel no repinta. */
export function occupied(notes: readonly Note[], key: number, beat: number): boolean {
  return notes.some(
    (n) => n.key === key && beat >= n.start - EPS && beat < n.start + n.duration - EPS,
  );
}

// ── Corte ────────────────────────────────────────────────────────────────────

export interface SliceLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SliceCut {
  note: Note;
  /** Beat exacto donde la línea parte la nota. */
  at: number;
}

/**
 * Qué notas cruza la línea del corte y en qué beat las parte.
 *
 * Una nota se corta cuando el segmento atraviesa el CENTRO vertical de su fila
 * dentro de su tramo de tiempo: así una línea horizontal no corta nada (como en
 * FL) y un tajo vertical parte todo lo que hay debajo. Las coordenadas llegan
 * en píxeles de canvas y se convierten con los mismos closures que dibuja el
 * componente (zoom y scroll incluidos).
 */
export function sliceCuts(
  notes: readonly Note[],
  line: SliceLine,
  rowCenterY: (key: number) => number,
  xToBeat: (x: number) => number,
): SliceCut[] {
  const dy = line.y1 - line.y0;
  if (Math.abs(dy) < 0.5) return []; // línea horizontal (o un clic): no corta
  const cuts: SliceCut[] = [];
  for (const n of notes) {
    const t = (rowCenterY(n.key) - line.y0) / dy;
    if (t < 0 || t > 1) continue;
    const at = xToBeat(line.x0 + (line.x1 - line.x0) * t);
    if (at > n.start + MIN_PIECE && at < n.start + n.duration - MIN_PIECE) {
      cuts.push({ note: n, at });
    }
  }
  return cuts;
}

export interface SliceResult {
  /** Cabezas: la nota original acortada hasta el corte (conserva su id). */
  patches: NotePatch[];
  /** Colas: notas nuevas desde el corte hasta el final de la original. */
  tails: Note[];
}

/**
 * Convierte los cortes en el par (patches, colas) que va en UN solo batch.
 * Como en `chop`, la cabeza pierde el slide y la cola se lo queda: el glide
 * sigue apuntando al final de la nota original.
 */
export function applySliceCuts(cuts: readonly SliceCut[]): SliceResult {
  const patches: NotePatch[] = [];
  const tails: Note[] = [];
  for (const { note, at } of cuts) {
    patches.push({ id: note.id, duration: at - note.start, slide: false });
    tails.push({
      ...note,
      id: newId(),
      start: at,
      duration: note.start + note.duration - at,
    });
  }
  return { patches, tails };
}
