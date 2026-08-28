/**
 * Lógica pura de las herramientas de la toolbar del Piano Roll que NO vienen
 * ya hechas de `@orbit/core` (arpegiar, strum, humanizar y chop sí: viven en
 * `note-tools.ts` de core, con sus propios tests — esto es lo que queda).
 *
 * Lo usa `PianoRoll.tsx`: allí queda el cableado (leer el estado, despachar) y
 * la regla vive aquí, probada sin canvas ni React delante — que es la
 * convención de tests de `packages/ui` escrita en CLAUDE.md.
 */

import type { Note, NotePatch } from '@orbit/core';

/**
 * A qué notas afecta un botón de herramienta: la selección viva, o TODAS si
 * no hay selección (o si la que hay ya no corresponde a ninguna nota).
 *
 * La poda contra notas vivas importa: tras deshacer una herramienta, `selection`
 * puede seguir llena de ids que ya no existen. Sin ella, "Cuantizar" con esa
 * selección fantasma sería un botón que no hace nada y no lo dice — parece que
 * Orbit no respondió, no que la selección estaba vacía de verdad.
 */
export function affectedNoteIds(
  notes: readonly Note[],
  selection: ReadonlySet<string>,
): string[] {
  if (selection.size > 0) {
    const alive = notes.filter((n) => selection.has(n.id)).map((n) => n.id);
    if (alive.length > 0) return alive;
  }
  return notes.map((n) => n.id);
}

/** Los parches de "Cuantizar": cada inicio afectado, redondeado a la rejilla. */
export function quantizePatches(
  notes: readonly Note[],
  ids: ReadonlySet<string>,
  snapStep: number,
): NotePatch[] {
  return notes
    .filter((n) => ids.has(n.id))
    .map((n) => ({ id: n.id, start: Math.round(n.start / snapStep) * snapStep }));
}

/**
 * Los parches de "Transponer": cada altura afectada, movida `semis` semitonos
 * y recortada al rango MIDI de la rejilla (nunca se sale por arriba o abajo).
 */
export function transposePatches(
  notes: readonly Note[],
  ids: ReadonlySet<string>,
  semis: number,
  maxKey: number,
): NotePatch[] {
  return notes
    .filter((n) => ids.has(n.id))
    .map((n) => ({ id: n.id, key: Math.min(maxKey, Math.max(0, n.key + semis)) }));
}
