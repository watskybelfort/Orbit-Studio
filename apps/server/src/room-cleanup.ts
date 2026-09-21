/**
 * Recogida de salas cerradas al arrancar.
 *
 * Cada código que se abrió una vez dejaba su `.bin` en `roomsDir` para
 * siempre: el servidor los cargaba y guardaba, pero nadie los borraba. Con el
 * uso normal eso es un goteo de MB que nunca baja. Al arrancar (que es cuando
 * no hay ninguna sala abierta) se pasa la escoba con dos reglas simples:
 *
 * - **tope**: se conservan los `ROOM_MAX_FILES` más recientes; el resto cae;
 * - **edad**: lo que no se tocó en `ROOM_MAX_AGE_MS` cae aunque sobre sitio.
 *
 * Los números son deliberadamente holgados: la idea es no acumular basura de
 * meses, no hacer rotación agresiva. Borrar un `.bin` se lleva sus compañeros
 * (`.bin.corrupt`, `.bin.tmp`, `.auth.json`); un `.auth.json` SIN `.bin` no se
 * toca nunca — podría ser una sala con contraseña que aún no ha guardado su
 * primer snapshot, y borrarlo le quitaría la puerta.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Cuántos `.bin` se conservan como máximo (el mismo orden que MAX_ROOMS). */
export const ROOM_MAX_FILES = 200;

/** A partir de cuándo una sala sin tocar se considera basura. */
export const ROOM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

export interface RoomFileEntry {
  name: string;
  mtimeMs: number;
}

export interface RoomCleanupOptions {
  maxFiles?: number;
  maxAgeMs?: number;
  now?: number;
}

/** Nombres de archivo a borrar según el tope y la edad. Puro. */
export function selectStaleRoomFiles(
  entries: readonly RoomFileEntry[],
  opts: RoomCleanupOptions = {},
): string[] {
  const maxFiles = opts.maxFiles ?? ROOM_MAX_FILES;
  const maxAgeMs = opts.maxAgeMs ?? ROOM_MAX_AGE_MS;
  const now = opts.now ?? Date.now();
  const names = new Set(entries.map((entry) => entry.name));
  const stale = new Set<string>();

  // Un temporal es una escritura que no terminó: nunca vale para nada.
  for (const entry of entries) {
    if (entry.name.endsWith('.bin.tmp')) stale.add(entry.name);
  }

  const bins = entries
    .filter((entry) => entry.name.endsWith('.bin'))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  bins.forEach((entry, index) => {
    const tooMany = index >= maxFiles;
    const tooOld = now - entry.mtimeMs > maxAgeMs;
    if (!tooMany && !tooOld) return;
    stale.add(entry.name);
    const code = entry.name.slice(0, -'.bin'.length);
    // Compañeros del mismo código: sin el bin no significan nada.
    for (const companion of [`${code}.auth.json`, `${code}.bin.corrupt`, `${code}.bin.tmp`]) {
      if (names.has(companion)) stale.add(companion);
    }
  });

  // Los `.corrupt` sueltos también envejecen.
  for (const entry of entries) {
    if (entry.name.endsWith('.bin.corrupt') && now - entry.mtimeMs > maxAgeMs) {
      stale.add(entry.name);
    }
  }

  return [...stale];
}

/**
 * Pasa la escoba por `roomsDir`. Devuelve los nombres borrados; los fallos de
 * borrado se ignoran (best-effort: la limpieza no puede impedir arrancar).
 */
export function sweepRooms(roomsDir: string, opts: RoomCleanupOptions = {}): string[] {
  let entries: RoomFileEntry[];
  try {
    entries = readdirSync(roomsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({
        name: entry.name,
        mtimeMs: statSync(join(roomsDir, entry.name)).mtimeMs,
      }));
  } catch {
    return []; // la carpeta no existe todavía: no hay nada que limpiar
  }
  const removed: string[] = [];
  for (const name of selectStaleRoomFiles(entries, opts)) {
    try {
      unlinkSync(join(roomsDir, name));
      removed.push(name);
    } catch {
      // best-effort
    }
  }
  return removed;
}
