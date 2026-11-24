/**
 * Apariencia "a mi manera": escala de la interfaz, familia tipográfica, radio
 * de esquinas y el carácter visual (estilo suave/clásico, animaciones y menús
 * translúcidos). Funciona igual que el tema — se aplica en caliente por tokens
 * CSS + atributos de <html> y se persiste en `settings.json` del userData:
 *
 *   uiScale      0.8 … 1.5   → `zoom` de <html> (ver ui-scale.ts)
 *   uiFont       id de UI_FONTS → token `--font-ui`
 *   uiRadius     0 … 16 px   → token `--radius`
 *   uiStyle      'soft' | 'classic' → atributo data-style (radios y sombras)
 *   uiMotion     booleano     → atributo data-motion (animaciones/transiciones)
 *   uiGlassMenus booleano     → atributo data-glass-menus (menús translúcidos)
 *
 * Ni una sola regla de color/geometría se escribe fuera de estos tokens: los
 * componentes siguen leyendo `var(--radius)` y `var(--font-ui)` como siempre.
 * Los canvas leen `getComputedStyle(canvas).fontFamily`, así que también
 * heredan la tipografía elegida sin tocar los editores.
 *
 * Los tres ajustes nuevos van por ATRIBUTOS y no por variables porque en CSS
 * no hay forma limpia de condicionar un bloque entero de reglas a una custom
 * property (`@supports` no evalúa valores de runtime): con `data-style` el
 * tema suave es un bloque más de la hoja, y `data-motion` puede apagar las
 * transiciones con una sola regla global.
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

/**
 * Carácter de la interfaz. 'soft' es el defecto desde la v3.15: esquinas algo
 * más redondeadas, hover teñido de acento y transiciones cortas. 'classic' es
 * el look anterior a esta perilla, sin un solo píxel de diferencia: en
 * tokens.css el radio grande por defecto vale `var(--radius)`, así que el
 * bloque suave es el único que lo agranda.
 */
export type UiStyle = 'classic' | 'soft';

export function isUiStyle(value: unknown): value is UiStyle {
  return value === 'classic' || value === 'soft';
}

export interface Appearance {
  /** Escala global de la UI (1 = 100 %). */
  scale: number;
  font: UiFontId;
  /** Radio de esquinas en px. */
  radius: number;
  /** 'soft' = acabado iOS sutil; 'classic' = look original. */
  style: UiStyle;
  /** Animaciones y transiciones. false las apaga de verdad (duración 0). */
  motion: boolean;
  /** Menús translúcidos con blur también en oscuro/claro (en acrílico ya lo son). */
  glassMenus: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = {
  scale: UI_SCALE_DEFAULT,
  font: 'system',
  radius: 8,
  style: 'soft',
  motion: true,
  glassMenus: false,
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
    // Un booleano persistido como string ("true") NO se acepta: viene de un
    // archivo editado a mano y adivinar la intención es peor que el default.
    style: isUiStyle(r['style']) ? r['style'] : DEFAULT_APPEARANCE.style,
    motion: typeof r['motion'] === 'boolean' ? r['motion'] : DEFAULT_APPEARANCE.motion,
    glassMenus:
      typeof r['glassMenus'] === 'boolean' ? r['glassMenus'] : DEFAULT_APPEARANCE.glassMenus,
  };
}

/** Atributos de <html> que activan las reglas de tokens.css. */
export interface AppearanceAttributes {
  'data-style': UiStyle;
  'data-motion': 'on' | 'off';
  'data-glass-menus': 'on' | 'off';
}

/**
 * Mapa PURO de apariencia → atributos. Se exporta aparte de `applyAppearance`
 * para poder probar las ocho combinaciones sin DOM. El estilo se vuelve a
 * validar porque a un tema custom o importado de una versión vieja le puede
 * faltar el campo en runtime (los tipos no llegan al JSON).
 */
export function appearanceAttributes(a: Appearance): AppearanceAttributes {
  return {
    'data-style': isUiStyle(a.style) ? a.style : DEFAULT_APPEARANCE.style,
    'data-motion': a.motion === false ? 'off' : 'on',
    'data-glass-menus': a.glassMenus === true ? 'on' : 'off',
  };
}

/** El puente del preload, si corremos dentro de Electron. */
function orbit(): OrbitApi | undefined {
  return typeof window !== 'undefined' ? window.orbit : undefined;
}

/** Aplica la apariencia EN CALIENTE (tokens + escala + atributos). */
export function applyAppearance(a: Appearance): void {
  if (typeof document === 'undefined') return;
  const attributes = appearanceAttributes(a);
  // También a los editores desacoplados: son otra ventana, pero la misma app.
  // DetachedWindow clona los atributos de <html> al abrir y los observa, así
  // que un cambio aquí llega a las dos ventanas por la vía normal.
  for (const w of themedWindows()) {
    const root = w.document.documentElement;
    root.style.setProperty('--font-ui', fontStack(a.font));
    root.style.setProperty('--radius', `${clampRadius(a.radius)}px`);
    for (const [name, value] of Object.entries(attributes)) {
      root.setAttribute(name, value);
    }
  }
  applyUiScale(a.scale);
}

/** Lee la apariencia de unos settings ya cargados (claves planas). */
export function appearanceFromSettings(settings: Record<string, unknown>): Appearance {
  return normalizeAppearance({
    scale: settings['uiScale'],
    font: settings['uiFont'],
    radius: settings['uiRadius'],
    style: settings['uiStyle'],
    motion: settings['uiMotion'],
    glassMenus: settings['uiGlassMenus'],
  });
}

/** Persiste la apariencia en settings.json (merge superficial). */
export async function saveAppearanceToSettings(a: Appearance): Promise<void> {
  const api = orbit();
  if (!api) return;
  await api.settings.set({
    uiScale: a.scale,
    uiFont: a.font,
    uiRadius: a.radius,
    uiStyle: a.style,
    uiMotion: a.motion,
    uiGlassMenus: a.glassMenus,
  });
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
