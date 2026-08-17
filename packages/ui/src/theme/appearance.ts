/**
 * Apariencia "a mi manera": escala de la interfaz, familia tipográfica y radio
 * de esquinas. Funciona igual que el tema — se aplica en caliente por tokens
 * CSS y se persiste en `settings.json` del userData:
 *
 *   uiScale   0.8 … 1.5   → `zoom` de <html> (ver ui-scale.ts)
 *   uiFont    id de UI_FONTS → token `--font-ui`
 *   uiRadius  0 … 16 px   → token `--radius`
 *
 * Ni una sola regla de color/geometría se escribe fuera de estos tokens: los
 * componentes siguen leyendo `var(--radius)` y `var(--font-ui)` como siempre.
 * Los canvas leen `getComputedStyle(canvas).fontFamily`, así que también
 * heredan la tipografía elegida sin tocar los editores.
 */

import { applyUiScale, clampUiScale, themedWindows, UI_SCALE_DEFAULT } from './ui-scale';

/** Familias tipográficas ofrecidas: lista corta y de fuentes que ya existen
 *  en el sistema (nada que descargar, nada que falle sin conexión). */
export type UiFontId = 'system' | 'segoe' | 'helvetica' | 'verdana' | 'georgia' | 'mono';

export interface UiFont {
  id: UiFontId;
  label: string;
  /** Pila CSS completa, con respaldos para cuando la primera no esté. */
  stack: string;
}

export const UI_FONTS: readonly UiFont[] = [
  {
    id: 'system',
    label: 'Del sistema',
    stack: "'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
  },
  { id: 'segoe', label: 'Segoe UI', stack: "'Segoe UI', Tahoma, Geneva, sans-serif" },
  {
    id: 'helvetica',
    label: 'Helvetica · Arial',
    stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  { id: 'verdana', label: 'Verdana', stack: 'Verdana, Geneva, Tahoma, sans-serif' },
  { id: 'georgia', label: 'Georgia', stack: "Georgia, 'Times New Roman', Times, serif" },
  {
    id: 'mono',
    label: 'Monoespaciada',
    stack: "'Cascadia Code', Consolas, 'SF Mono', ui-monospace, monospace",
  },
];

export const UI_RADIUS_MIN = 0;
export const UI_RADIUS_MAX = 16;

export interface Appearance {
  /** Escala global de la UI (1 = 100 %). */
  scale: number;
  font: UiFontId;
  /** Radio de esquinas en px. */
  radius: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  scale: UI_SCALE_DEFAULT,
  font: 'system',
  radius: 8,
};

export function isUiFontId(value: unknown): value is UiFontId {
  return UI_FONTS.some((f) => f.id === value);
}

export function fontStack(id: UiFontId): string {
  return (UI_FONTS.find((f) => f.id === id) ?? UI_FONTS[0]!).stack;
}

export function clampRadius(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE.radius;
  return Math.min(UI_RADIUS_MAX, Math.max(UI_RADIUS_MIN, Math.round(n)));
}

/** Normaliza cualquier cosa (archivo importado, settings viejos) a Appearance. */
export function normalizeAppearance(raw: unknown): Appearance {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_APPEARANCE };
  const r = raw as Record<string, unknown>;
  return {
    scale: clampUiScale(r['scale'] ?? DEFAULT_APPEARANCE.scale),
    font: isUiFontId(r['font']) ? r['font'] : DEFAULT_APPEARANCE.font,
    radius: clampRadius(r['radius'] ?? DEFAULT_APPEARANCE.radius),
  };
}

/** El puente del preload, si corremos dentro de Electron. */
function orbit(): OrbitApi | undefined {
  return typeof window !== 'undefined' ? window.orbit : undefined;
}

/** Aplica la apariencia EN CALIENTE (tokens + escala). */
export function applyAppearance(a: Appearance): void {
  if (typeof document === 'undefined') return;
  // También a los editores desacoplados: son otra ventana, pero la misma app.
  for (const w of themedWindows()) {
    const root = w.document.documentElement;
    root.style.setProperty('--font-ui', fontStack(a.font));
    root.style.setProperty('--radius', `${clampRadius(a.radius)}px`);
  }
  applyUiScale(a.scale);
}

/** Lee la apariencia de unos settings ya cargados (claves planas). */
export function appearanceFromSettings(settings: Record<string, unknown>): Appearance {
  return normalizeAppearance({
    scale: settings['uiScale'],
    font: settings['uiFont'],
    radius: settings['uiRadius'],
  });
}

/** Lee la apariencia persistida, la aplica y la devuelve. */
export async function loadAppearanceFromSettings(): Promise<Appearance> {
  const api = orbit();
  if (!api) {
    applyAppearance(DEFAULT_APPEARANCE);
    return { ...DEFAULT_APPEARANCE };
  }
  try {
    const settings = await api.settings.get();
    const appearance = appearanceFromSettings(settings);
    applyAppearance(appearance);
    return appearance;
  } catch {
    applyAppearance(DEFAULT_APPEARANCE);
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Persiste la apariencia en settings.json (merge superficial). */
export async function saveAppearanceToSettings(a: Appearance): Promise<void> {
  const api = orbit();
  if (!api) return;
  await api.settings.set({ uiScale: a.scale, uiFont: a.font, uiRadius: a.radius });
}

// Las perillas de apariencia son sliders: arrastrarlas dispara decenas de
// cambios por segundo y cada guardado es un IPC + una escritura de settings.json.
// Se aplica al instante y se guarda cuando la mano se queda quieta.
const SAVE_DEBOUNCE_MS = 300;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Aplica ya y persiste al soltar (para sliders y selectores). */
export function commitAppearance(a: Appearance): void {
  applyAppearance(a);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveAppearanceToSettings(a);
  }, SAVE_DEBOUNCE_MS);
}
