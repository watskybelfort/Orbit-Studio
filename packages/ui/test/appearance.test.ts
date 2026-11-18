/**
 * Apariencia: defaults, normalización de basura, los atributos de <html> y el
 * ida y vuelta con settings.json. Sin DOM: `appearanceAttributes` es pura y el
 * guardado se prueba con un `window.orbit` de mentira, igual que el resto del
 * repo.
 *
 * Lo que se protege:
 *  - que el default sea el acabado suave (style/motion/glass) sin tocar los
 *    valores de siempre (escala, fuente, radio);
 *  - que un archivo o unos settings con valores inválidos caigan al default en
 *    vez de escribir un atributo vacío o un `undefined`;
 *  - que las ocho combinaciones de estilo × movimiento × vidrio produzcan el
 *    mapa exacto que lee tokens.css;
 *  - que elegir `classic` no altere el radio por defecto ni ningún otro campo.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appearanceAttributes,
  appearanceFromSettings,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  saveAppearanceToSettings,
  type Appearance,
} from '../src/theme/appearance';
import { readSource } from './read-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('defaults de apariencia', () => {
  it('el defecto es suave, con animaciones y sin vidrio en los menús', () => {
    expect(DEFAULT_APPEARANCE).toMatchObject({
      scale: 1,
      font: 'system',
      radius: 8,
      style: 'soft',
      motion: true,
      glassMenus: false,
    });
  });
});

describe('normalizeAppearance', () => {
  it('sin datos devuelve los defaults', () => {
    expect(normalizeAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance('no soy un objeto')).toEqual(DEFAULT_APPEARANCE);
  });

  it('la basura cae al default sin arrastrar el resto', () => {
    // Un booleano persistido como string NO se adivina: cae al default.
    expect(
      normalizeAppearance({ style: 'neón', motion: 'true', glassMenus: 1 }),
    ).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ motion: 0, glassMenus: 'sí' })).toEqual({
      ...DEFAULT_APPEARANCE,
    });
  });

  it('conserva los valores válidos y recorta escala y radio', () => {
    expect(
      normalizeAppearance({
        scale: 99,
        font: 'segoe',
        radius: 99,
        style: 'classic',
        motion: false,
        glassMenus: true,
      }),
    ).toEqual({
      scale: 1.5,
      font: 'segoe',
      radius: 16,
      style: 'classic',
      motion: false,
      glassMenus: true,
    });
  });

  it('elegir clásico no mueve el radio ni ningún otro valor por defecto', () => {
    const soft = normalizeAppearance({ ...DEFAULT_APPEARANCE });
    const classic = normalizeAppearance({ ...DEFAULT_APPEARANCE, style: 'classic' });

    expect(classic.radius).toBe(soft.radius);
    // Fuera del estilo, la apariencia es la misma pieza por pieza.
    expect({ ...classic, style: 'soft' }).toEqual(soft);
  });
});

describe('appearanceAttributes', () => {
  it('traduce las ocho combinaciones de estilo × movimiento × vidrio', () => {
    const combinations: string[] = [];

    for (const style of ['soft', 'classic'] as const) {
      for (const motion of [true, false] as const) {
        for (const glassMenus of [true, false] as const) {
          const a: Appearance = { ...DEFAULT_APPEARANCE, style, motion, glassMenus };
          expect(appearanceAttributes(a)).toEqual({
            'data-style': style,
            'data-motion': motion ? 'on' : 'off',
            'data-glass-menus': glassMenus ? 'on' : 'off',
          });
          combinations.push(`${style}/${motion}/${glassMenus}`);
        }
      }
    }

    expect(combinations).toHaveLength(8);
    expect(new Set(combinations).size).toBe(8);
  });

  it('un valor inválido en runtime cae a suave y no apaga el movimiento', () => {
    // Un tema custom guardado antes de esta versión puede llegar sin campos:
    // los tipos no existen en el JSON. Nunca debe escribirse un atributo vacío
    // ni tomar `undefined` como si fuera un "no".
    const crudo = {
      ...DEFAULT_APPEARANCE,
      style: 'neón',
      motion: undefined,
      glassMenus: undefined,
    } as unknown as Appearance;

    expect(appearanceAttributes(crudo)).toEqual({
      'data-style': 'soft',
      'data-motion': 'on',
      'data-glass-menus': 'off',
    });
  });

  it('en CSS el radio grande por defecto ES el radio normal (clásico intacto)', () => {
    const css = readSource('theme/tokens.css');

    // Base: el popup mide exactamente lo mismo que en la v3.14.
    expect(css).toContain('--radius-lg: var(--radius);');
    // Solo el bloque suave lo agranda; el clásico no tiene override.
    expect(css).toContain("html[data-style='soft'] {");
    expect(css).toContain('--radius-lg: calc(var(--radius) * 1.75);');
  });
});

describe('settings.json (claves planas)', () => {
  it('ida y vuelta: guarda las seis claves y las relee igual', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { orbit: { settings: { set } } });

    const a: Appearance = {
      ...DEFAULT_APPEARANCE,
      scale: 1.25,
      font: 'georgia',
      radius: 12,
      style: 'classic',
      motion: false,
      glassMenus: true,
    };

    await saveAppearanceToSettings(a);

    expect(set).toHaveBeenCalledWith({
      uiScale: 1.25,
      uiFont: 'georgia',
      uiRadius: 12,
      uiStyle: 'classic',
      uiMotion: false,
      uiGlassMenus: true,
    });

    // Y lo escrito, leído por el mismo camino que usa el arranque, vuelve a la
    // misma apariencia (sin perder los campos nuevos).
    expect(appearanceFromSettings(set.mock.calls[0]![0])).toEqual(a);
  });

  it('settings viejos o con basura caen a los defaults', () => {
    expect(appearanceFromSettings({})).toEqual(DEFAULT_APPEARANCE);
    expect(
      appearanceFromSettings({
        uiStyle: 'brutal',
        uiMotion: 'no',
        uiGlassMenus: null,
      }),
    ).toEqual(DEFAULT_APPEARANCE);
  });
});
