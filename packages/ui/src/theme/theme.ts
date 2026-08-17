// Aplicación y persistencia de temas.
// El tema vive en dos sitios que hay que conmutar a la vez:
//   1. CSS: data-theme en <html> + overrides de variables (las perillas).
//   2. Ventana: el main conmuta el backgroundMaterial DWM (via window.orbit).
//
// Los ajustes de apariencia que NO son de color (escala de UI, tipografía y
// radio) viven en theme/appearance.ts; se cargan aquí, en el mismo arranque,
// para que la primera pintada ya salga con el tamaño y la fuente del usuario.

import { appearanceFromSettings, applyAppearance, DEFAULT_APPEARANCE, type Appearance } from './appearance';

export type ThemeId = 'dark' | 'light' | 'acrylic';

export interface ThemeOverrides {
  /** Color de marca (--accent). */
  accent?: string;
  /** Veladura del vidrio 0..1 (--glass-alpha, solo acrílico). */
  glassAlpha?: number;
  /** Color que vela el vidrio (--glass-tint, solo acrílico). */
  glassTint?: string;
  /** Semáforo macOS en la barra de título (no es CSS: lo consume el shell). */
  trafficLights?: boolean;
}

export interface ThemeState {
  theme: ThemeId;
  overrides: ThemeOverrides;
  /** Escala, tipografía y radio (ver theme/appearance.ts). */
  appearance: Appearance;
}

export function isThemeId(value: unknown): value is ThemeId {
  return value === 'dark' || value === 'light' || value === 'acrylic';
}

/** El puente del preload, si corremos dentro de Electron. */
function orbit(): OrbitApi | undefined {
  return typeof window !== 'undefined' ? window.orbit : undefined;
}

function setVar(el: HTMLElement, name: string, value: string | undefined): void {
  if (value === undefined || value === '') {
    el.style.removeProperty(name);
  } else {
    el.style.setProperty(name, value);
  }
}

/**
 * Aplica el tema EN CALIENTE: data-theme en <html>, overrides de perillas y
 * conmutación del material de ventana en el main (si hay puente).
 * Devuelve `true` si el acrílico quedó realmente activo en la ventana.
 */
export async function applyTheme(themeId: ThemeId, overrides?: ThemeOverrides): Promise<boolean> {
  const root = document.documentElement;
  root.setAttribute('data-theme', themeId);

  setVar(root, '--accent', overrides?.accent);
  setVar(root, '--glass-alpha', overrides?.glassAlpha !== undefined ? String(overrides.glassAlpha) : undefined);
  setVar(root, '--glass-tint', overrides?.glassTint);

  const api = orbit();
  if (api) {
    const { acrylicAvailable } = await api.theme.apply(themeId);
    return acrylicAvailable;
  }
  return false;
}

/** Lee el tema persistido (fallback: oscuro), lo aplica y lo devuelve. */
export async function loadThemeFromSettings(): Promise<ThemeState> {
  const fallback: ThemeState = {
    theme: 'dark',
    overrides: {},
    appearance: { ...DEFAULT_APPEARANCE },
  };
  const api = orbit();
  if (!api) {
    applyAppearance(fallback.appearance);
    await applyTheme(fallback.theme);
    return fallback;
  }
  try {
    const settings = await api.settings.get();
    const saved = settings['theme'];
    const theme: ThemeId = isThemeId(saved) ? saved : 'dark';
    const overrides: ThemeOverrides = {
      accent: typeof settings['accent'] === 'string' ? settings['accent'] : undefined,
      glassAlpha: typeof settings['glassAlpha'] === 'number' ? settings['glassAlpha'] : undefined,
      glassTint: typeof settings['glassTint'] === 'string' ? settings['glassTint'] : undefined,
      trafficLights: typeof settings['trafficLights'] === 'boolean' ? settings['trafficLights'] : undefined,
    };
    const appearance = appearanceFromSettings(settings);
    // La apariencia primero: si hay escala, el shim ya está puesto cuando el
    // resto de la UI empieza a medir.
    applyAppearance(appearance);
    await applyTheme(theme, overrides);
    return { theme, overrides, appearance };
  } catch {
    applyAppearance(fallback.appearance);
    await applyTheme(fallback.theme);
    return fallback;
  }
}

/** Persiste el tema y sus perillas en settings.json (merge superficial). */
export async function saveThemeToSettings(theme: ThemeId, overrides: ThemeOverrides = {}): Promise<void> {
  const api = orbit();
  if (!api) return;
  const patch: Record<string, unknown> = { theme };
  if (overrides.accent !== undefined) patch['accent'] = overrides.accent;
  if (overrides.glassAlpha !== undefined) patch['glassAlpha'] = overrides.glassAlpha;
  if (overrides.glassTint !== undefined) patch['glassTint'] = overrides.glassTint;
  if (overrides.trafficLights !== undefined) patch['trafficLights'] = overrides.trafficLights;
  await api.settings.set(patch);
}
