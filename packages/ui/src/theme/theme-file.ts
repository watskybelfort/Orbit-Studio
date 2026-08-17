/**
 * Temas como archivo: exportar el tema actual a un `.json` y volver a
 * importarlo (para pasarlo de una máquina a otra o compartirlo).
 *
 * ## Formato
 * ```json
 * {
 *   "format": "orbit-theme",
 *   "version": 1,
 *   "name": "Noche cerrada",
 *   "theme": "acrylic",
 *   "overrides": { "accent": "#5aa9e6", "glassAlpha": 0.55, "glassTint": "#101114" },
 *   "appearance": { "scale": 1.1, "font": "segoe", "radius": 10 }
 * }
 * ```
 *
 * ## Por qué descarga/`<input type=file>` y no diálogos nativos
 * El puente de Electron (`window.orbit`) solo sabe abrir diálogos con filtros
 * fijos: `file.saveDialog` filtra WAV y `project.open` filtra `.orbit`. No hay
 * un abrir/guardar genérico, así que aquí se usa el camino del navegador —
 * `<a download>` para exportar y `<input type="file">` para importar — que en
 * Electron funciona igual (la descarga pasa por el diálogo de guardado de
 * Chromium) y encima deja el customizador utilizable fuera de la app.
 */

import { normalizeAppearance, type Appearance } from './appearance';
import { isThemeId, type ThemeId, type ThemeOverrides } from './theme';

export const THEME_FILE_FORMAT = 'orbit-theme';
export const THEME_FILE_VERSION = 1;
/** Extensión sugerida: acaba en `.json` para que cualquier editor lo abra. */
export const THEME_FILE_EXT = '.orbittheme.json';

export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT;
  version: number;
  name: string;
  theme: ThemeId;
  overrides: ThemeOverrides;
  appearance: Appearance;
}

export type ThemeFileResult =
  | { ok: true; file: ThemeFile }
  | { ok: false; error: string };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function buildThemeFile(
  name: string,
  theme: ThemeId,
  overrides: ThemeOverrides,
  appearance: Appearance,
): ThemeFile {
  return {
    format: THEME_FILE_FORMAT,
    version: THEME_FILE_VERSION,
    name: name.trim() || 'Tema de Orbit',
    theme,
    overrides,
    appearance,
  };
}

export function serializeThemeFile(file: ThemeFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Valida y normaliza el contenido de un archivo de tema. Devuelve un mensaje
 * claro (y en cristiano) por cada motivo de rechazo: el usuario tiene que
 * saber si le han pasado un archivo de otra app, de una versión futura o con
 * un color mal escrito.
 */
export function parseThemeFile(text: string): ThemeFileResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `El archivo no es JSON válido (${detail}).` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'El archivo no contiene un objeto de tema.' };
  }

  const obj = raw as Record<string, unknown>;
  if (obj['format'] !== THEME_FILE_FORMAT) {
    return {
      ok: false,
      error: 'Esto no es un tema de Orbit: falta la marca «format: orbit-theme».',
    };
  }
  const version = typeof obj['version'] === 'number' ? obj['version'] : 0;
  if (version > THEME_FILE_VERSION) {
    return {
      ok: false,
      error: `El tema viene de una versión más nueva de Orbit (formato v${version}); actualiza para abrirlo.`,
    };
  }
  const theme = obj['theme'];
  if (!isThemeId(theme)) {
    return {
      ok: false,
      error: `El tema base «${String(theme)}» no vale: tiene que ser dark, light o acrylic.`,
    };
  }

  const rawOverrides = obj['overrides'];
  if (rawOverrides !== undefined && (typeof rawOverrides !== 'object' || rawOverrides === null)) {
    return { ok: false, error: 'El bloque «overrides» tiene que ser un objeto.' };
  }
  const o = (rawOverrides ?? {}) as Record<string, unknown>;

  const overrides: ThemeOverrides = {};
  for (const key of ['accent', 'glassTint'] as const) {
    const value = o[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !HEX.test(value)) {
      return {
        ok: false,
        error: `El color «${key}» del tema («${String(value)}») no es un hexadecimal tipo #5aa9e6.`,
      };
    }
    overrides[key] = value;
  }
  const alpha = o['glassAlpha'];
  if (alpha !== undefined && alpha !== null) {
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      return {
        ok: false,
        error: 'La transparencia («glassAlpha») tiene que ser un número entre 0 y 1.',
      };
    }
    overrides.glassAlpha = alpha;
  }
  if (typeof o['trafficLights'] === 'boolean') overrides.trafficLights = o['trafficLights'];

  const name = typeof obj['name'] === 'string' && obj['name'].trim() ? obj['name'].trim() : 'Tema importado';

  return {
    ok: true,
    // La apariencia se normaliza (y se recorta a rango) en vez de rechazarse:
    // un tema con una escala rara sigue siendo un tema válido.
    file: { format: THEME_FILE_FORMAT, version, name, theme, overrides, appearance: normalizeAppearance(obj['appearance']) },
  };
}

/** Nombre de archivo seguro en Windows/mac/linux. */
function safeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim();
  return clean || 'tema';
}

/** Descarga el tema como archivo (en Electron abre el diálogo de guardado). */
export function downloadThemeFile(file: ThemeFile): string {
  const fileName = `${safeFileName(file.name)}${THEME_FILE_EXT}`;
  const blob = new Blob([serializeThemeFile(file)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revocar en el mismo turno cancelaría la descarga en curso.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return fileName;
}

/**
 * Pide un archivo al usuario con un `<input type="file">` invisible.
 * `null` si cancela (Chromium dispara el evento `cancel` del input).
 */
export function pickThemeFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.orbittheme,application/json';
    input.style.display = 'none';
    const done = (value: { name: string; text: string } | null) => {
      input.remove();
      resolve(value);
    };
    input.addEventListener('cancel', () => done(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      file
        .text()
        .then((text) => done({ name: file.name, text }))
        .catch(() => done(null));
    });
    document.body.appendChild(input);
    input.click();
  });
}
