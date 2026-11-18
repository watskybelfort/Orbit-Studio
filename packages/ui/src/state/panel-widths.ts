/**
 * Anchos de los paneles laterales del shell (Biblioteca de sonidos y Claude).
 *
 * Son de ESTA máquina, como la disposición de `workspace-memory.ts`: no van al
 * proyecto, no entran al undo y no viajan por la sala. Viven en settings.json
 * bajo una sola clave con dos números planos (`panelWidths: { browser, claude }`).
 *
 * El ancho se escribe como custom property en `<html>` y no como estilo del
 * `<aside>`: las pestañas y el propio panel leen `--sidebar-width` /
 * `--assistant-width`, y `workspaceArea()` (layouts) mide el panel vivo y cae al
 * token cuando está desmontado. Una sola escritura deja a todos de acuerdo.
 *
 * Ojo con el orden de arranque: `loadPanelWidths()` tiene que resolver ANTES de
 * `initWorkspaceMemory()`, o la memoria del escritorio mide con los anchos de
 * fábrica y recorta las cajas contra un área que ya no existe.
 */

export type PanelSide = 'browser' | 'claude';

export interface PanelWidths {
  browser: number;
  claude: number;
}

/** Clave de settings.json. */
export const PANEL_WIDTHS_KEY = 'panelWidths';

/**
 * Anchos de fábrica: los mismos que `tokens.css` declara en `:root`. Si cambia
 * uno, cambia el otro — el token es el valor que se ve antes de que settings
 * conteste, y este el que se usa al restaurar/doble clic.
 */
export const PANEL_WIDTH_DEFAULTS: PanelWidths = { browser: 240, claude: 280 };

/**
 * Límites por panel, con el porqué:
 * - Biblioteca 180–420: por debajo de 180 la columna de categorías y el nombre
 *   del sample no caben; por encima de 420 se come el editor y el usuario está
 *   mirando samples, no la canción.
 * - Claude 220–460: 220 es el ancho mínimo legible del hilo de mensajes; 460
 *   deja de ser un panel lateral y pasa a competir con el workspace.
 */
export const PANEL_WIDTH_LIMITS: Record<PanelSide, { min: number; max: number }> = {
  browser: { min: 180, max: 420 },
  claude: { min: 220, max: 460 },
};

/** Custom property que lee cada panel (y `layouts.ts` como respaldo). */
export const PANEL_WIDTH_VARS: Record<PanelSide, string> = {
  browser: '--sidebar-width',
  claude: '--assistant-width',
};

export const PANEL_SIDES: readonly PanelSide[] = ['browser', 'claude'];

/** Retardo del guardado tras el último cambio, en ms (como el resto del repo). */
const SAVE_DEBOUNCE_MS = 400;

/** Los anchos vigentes de esta sesión. Arranca en fábrica. */
const widths: PanelWidths = { ...PANEL_WIDTH_DEFAULTS };

/** Avisos de cambio para que el asa repinte su `aria-valuenow` tras cargar. */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Escucha cambios de ancho (incluida la carga inicial). Devuelve el
 * desuscriptor, con la forma que espera `useSyncExternalStore`.
 */
export function subscribePanelWidths(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Copia de los anchos vigentes. */
export function getPanelWidths(): PanelWidths {
  return { ...widths };
}

/**
 * Mete un ancho dentro de los límites de su panel. Un valor que no es un
 * número finito (settings corrupto, `NaN` de una cuenta) cae al de fábrica.
 */
export function clampPanelWidth(side: PanelSide, value: number): number {
  if (!Number.isFinite(value)) return PANEL_WIDTH_DEFAULTS[side];
  const { min, max } = PANEL_WIDTH_LIMITS[side];
  return Math.round(Math.min(max, Math.max(min, value)));
}

/**
 * Lee lo guardado sin confiar en nada: settings.json es texto que cualquiera
 * edita y puede traer strings, nulls, números fuera de rango o la clave
 * ausente. Lo que no valga se queda en su valor de fábrica, entrada por
 * entrada, así una mitad rota no obliga a perder la otra.
 */
export function parsePanelWidths(raw: unknown): PanelWidths {
  const out: PanelWidths = { ...PANEL_WIDTH_DEFAULTS };
  if (typeof raw !== 'object' || raw === null) return out;
  const record = raw as Record<string, unknown>;
  for (const side of PANEL_SIDES) {
    const value = record[side];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[side] = clampPanelWidth(side, value);
    }
  }
  return out;
}

/**
 * Escribe los dos tokens en `<html>`. Sin `document` (tests en Node, arranque
 * fuera del renderer) no hace nada: el ancho igual queda en el estado del
 * módulo para cuando haya DOM.
 */
export function applyPanelWidths(values: PanelWidths = widths): void {
  if (typeof document === 'undefined') return;
  const style = document.documentElement?.style;
  if (!style) return;
  for (const side of PANEL_SIDES) {
    style.setProperty(PANEL_WIDTH_VARS[side], `${values[side]}px`);
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Escritura real de los anchos vigentes; no hay nada que hacer sin puente. */
function writePanelWidths(): void {
  if (typeof window === 'undefined') return;
  void window.orbit?.settings.set({ [PANEL_WIDTHS_KEY]: { ...widths } });
}

/**
 * Guarda con retardo: durante un arrastre el ancho cambia a 60 fps y escribir
 * settings.json en cada frame sería absurdo. Cada llamada reinicia el reloj, así
 * que la escritura cae a los 400 ms de la última flecha o del último cambio.
 */
export function savePanelWidths(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writePanelWidths();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Escribe ya, sin esperar el debounce. Lo usa el asa al soltar: el ancho dejó
 * de moverse y no hay razón para retrasar el guardado. Si no había nada
 * pendiente también escribe — el estado del módulo siempre es la verdad.
 */
export function flushPanelWidths(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writePanelWidths();
}

/** Ajusta un panel en caliente (clamp incluido), lo pinta y programa el guardado. */
export function setPanelWidth(side: PanelSide, value: number): number {
  const next = clampPanelWidth(side, value);
  widths[side] = next;
  applyPanelWidths();
  emit();
  savePanelWidths();
  return next;
}

/** Doble clic: vuelve al ancho de fábrica de ese panel. */
export function resetPanelWidth(side: PanelSide): number {
  widths[side] = PANEL_WIDTH_DEFAULTS[side];
  applyPanelWidths();
  emit();
  savePanelWidths();
  return widths[side];
}

/**
 * Carga los anchos de settings.json y los aplica. Tolera que no haya puente
 * (tests, navegador suelto) y que `get()` falle: en ambos casos quedan los de
 * fábrica. Nunca rechaza — de eso depende el orden de arranque de App.
 */
export async function loadPanelWidths(): Promise<PanelWidths> {
  let raw: unknown;
  if (typeof window !== 'undefined') {
    try {
      const settings = await window.orbit?.settings.get();
      raw = settings?.[PANEL_WIDTHS_KEY];
    } catch {
      raw = undefined;
    }
  }
  const parsed = parsePanelWidths(raw);
  widths.browser = parsed.browser;
  widths.claude = parsed.claude;
  applyPanelWidths();
  emit();
  return getPanelWidths();
}
