/**
 * Sitio de las ventanas desacopladas (el mixer en el segundo monitor).
 *
 * Se guardan en settings.json y se vuelven a aplicar al reabrir el editor, así
 * que hay que defenderse de lo que puede haber cambiado entre medias: el
 * monitor donde vivía ya no está, la resolución bajó, o el JSON viene tocado a
 * mano. Restaurar a ciegas deja la ventana FUERA de todas las pantallas —
 * existe, se lleva el foco y no hay forma de agarrarla con el ratón.
 *
 * Aquí solo vive esa comprobación, sin Electron delante, para poder probarla.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Área útil de un monitor (el `workArea` de Electron: sin barra de tareas). */
export type Area = Bounds;

/** Mínimos de una ventana hija (los mismos que pide el main al crearla). */
export const MIN_CHILD_WIDTH = 320;
export const MIN_CHILD_HEIGHT = 220;

/** Trozo de ventana que tiene que verse para considerarla alcanzable. */
const MIN_VISIBLE_WIDTH = 140;
const MIN_VISIBLE_HEIGHT = 60;

/** Barra de título: si no cabe en la pantalla, la ventana no se puede mover. */
const TITLE_BAR = 32;

/** Margen de gracia hacia arriba (Windows deja la ventana un pelo fuera). */
const TOP_SLACK = 8;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** Lee unos bounds de settings.json; null si no son cuatro números de verdad. */
export function parseBounds(value: unknown): Bounds | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const x = num(o['x']);
  const y = num(o['y']);
  const width = num(o['width']);
  const height = num(o['height']);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function overlap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.min(aStart + aSize, bStart + bSize) - Math.max(aStart, bStart);
}

/**
 * ¿La ventana se ve y se puede agarrar en alguno de los monitores? No basta
 * con tocar la pantalla: hace falta un trozo apreciable Y que la barra de
 * título entre entera, que es de donde tira el ratón.
 */
export function isReachable(bounds: Bounds, areas: readonly Area[]): boolean {
  return areas.some((area) => {
    const w = overlap(bounds.x, bounds.width, area.x, area.width);
    const h = overlap(bounds.y, bounds.height, area.y, area.height);
    if (w < MIN_VISIBLE_WIDTH || h < MIN_VISIBLE_HEIGHT) return false;
    return bounds.y >= area.y - TOP_SLACK && bounds.y + TITLE_BAR <= area.y + area.height;
  });
}

/**
 * Bounds guardados listos para aplicar: recortados a los mínimos de la ventana
 * y comprobados contra los monitores de AHORA. `null` = no sirven (que la
 * ventana salga donde el sistema quiera, que siempre es un sitio visible).
 */
export function usableBounds(value: unknown, areas: readonly Area[]): Bounds | null {
  const parsed = parseBounds(value);
  if (!parsed) return null;
  const bounds: Bounds = {
    x: parsed.x,
    y: parsed.y,
    width: Math.max(MIN_CHILD_WIDTH, parsed.width),
    height: Math.max(MIN_CHILD_HEIGHT, parsed.height),
  };
  return isReachable(bounds, areas) ? bounds : null;
}

/**
 * Editor al que pertenece una ventana hija a partir de su `frameName`
 * (`window.open(url, 'orbit-mixer')` → `mixer`). Devuelve null para cualquier
 * otra cosa: el nombre acaba siendo una clave de settings.json y no puede
 * traer barras, puntos ni espacios.
 */
export function childWindowId(frameName: string): string | null {
  const rest = frameName.startsWith('orbit-') ? frameName.slice('orbit-'.length) : '';
  return /^[A-Za-z][A-Za-z0-9]*$/.test(rest) ? rest : null;
}
