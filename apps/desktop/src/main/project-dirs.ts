/**
 * Carpeta recordada de proyectos para los diálogos nativos.
 *
 * El usuario no debería buscar la misma carpeta cada vez que abre o guarda.
 * `lastProjectDir` vive en `settings.json` (userData) y se escribe solo desde
 * el main, que es quien abre los diálogos. Se acepta únicamente una ruta
 * ABSOLUTA: una entrada corrupta o relativa no debe mandar el diálogo a un
 * sitio raro, y el fallback (Documentos) sigue siendo predecible.
 */

import { dirname, isAbsolute, join } from 'node:path';

export const LAST_PROJECT_DIR_KEY = 'lastProjectDir';

/** Carpeta recordada, o null si no hay o no sirve. */
export function rememberedProjectDir(settings: Record<string, unknown>): string | null {
  const raw = settings[LAST_PROJECT_DIR_KEY];
  return typeof raw === 'string' && isAbsolute(raw) ? raw : null;
}

/** `defaultPath` de «Abrir proyecto»: la última carpeta o el fallback. */
export function projectOpenDefaultPath(
  settings: Record<string, unknown>,
  fallbackDir: string,
): string {
  return rememberedProjectDir(settings) ?? fallbackDir;
}

/** `defaultPath` de «Guardar como»: la última carpeta + el nombre sugerido. */
export function projectSaveDefaultPath(
  settings: Record<string, unknown>,
  fallbackDir: string,
  suggestedName: string,
): string {
  return join(rememberedProjectDir(settings) ?? fallbackDir, suggestedName);
}

/**
 * Devuelve los ajustes con la carpeta de `filePath` recordada. Si la ruta no
 * es absoluta o la carpeta ya era la misma, devuelve el MISMO objeto para que
 * el llamador no escriba settings.json sin necesidad.
 */
export function withRememberedProjectDir(
  settings: Record<string, unknown>,
  filePath: string,
): Record<string, unknown> {
  if (filePath.length === 0 || !isAbsolute(filePath)) return settings;
  const dir = dirname(filePath);
  if (rememberedProjectDir(settings) === dir) return settings;
  return { ...settings, [LAST_PROJECT_DIR_KEY]: dir };
}
