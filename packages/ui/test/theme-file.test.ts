/**
 * Temas como archivo (`.orbittheme.json`): compatibilidad del bloque
 * `appearance` que estrenó `style`, `motion` y `glassMenus`.
 *
 * La regla es laxa a propósito: un tema viejo sin esos campos sigue siendo
 * válido (se normaliza a los defaults) y uno con basura tampoco se rechaza —
 * es una preferencia de presentación, no un color. Lo que sí se sigue
 * rechazando es lo estructural (marca, versión futura, tema base, colores).
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, type Appearance } from '../src/theme/appearance';
import {
  buildThemeFile,
  parseThemeFile,
  serializeThemeFile,
  THEME_FILE_FORMAT,
} from '../src/theme/theme-file';

/** Un tema v1 de antes de que existieran estilo/animaciones/vidrio. */
const OLD_THEME = {
  format: THEME_FILE_FORMAT,
  version: 1,
  name: 'Noche vieja',
  theme: 'dark',
  overrides: { accent: '#5aa9e6' },
};

function parseOk(text: string) {
  const result = parseThemeFile(text);
  if (!result.ok) throw new Error(`El tema no debería rechazarse: ${result.error}`);
  return result.file;
}

describe('parseThemeFile y el bloque appearance', () => {
  it('un tema viejo sin bloque appearance se abre con los defaults', () => {
    const file = parseOk(JSON.stringify(OLD_THEME));

    expect(file.appearance).toEqual(DEFAULT_APPEARANCE);
    expect(file.name).toBe('Noche vieja');
  });

  it('un tema viejo con appearance sin los campos nuevos sigue siendo válido', () => {
    const file = parseOk(
      JSON.stringify({
        ...OLD_THEME,
        appearance: { scale: 1.1, font: 'segoe', radius: 10 },
      }),
    );

    expect(file.appearance).toEqual({
      scale: 1.1,
      font: 'segoe',
      radius: 10,
      style: 'soft',
      motion: true,
      glassMenus: false,
    });
  });

  it('valores inválidos en los campos nuevos caen al default sin rechazar el tema', () => {
    const file = parseOk(
      JSON.stringify({
        ...OLD_THEME,
        appearance: {
          scale: 1.25,
          font: 'georgia',
          radius: 99,
          style: 'neón',
          motion: 'sí',
          glassMenus: 1,
        },
      }),
    );

    expect(file.appearance).toEqual({
      scale: 1.25,
      font: 'georgia',
      radius: 16, // clamp de siempre
      style: 'soft',
      motion: true,
      glassMenus: false,
    });
  });

  it('valores válidos de los campos nuevos se conservan', () => {
    const file = parseOk(
      JSON.stringify({
        ...OLD_THEME,
        appearance: {
          scale: 1,
          font: 'system',
          radius: 8,
          style: 'classic',
          motion: false,
          glassMenus: true,
        },
      }),
    );

    expect(file.appearance).toMatchObject({
      style: 'classic',
      motion: false,
      glassMenus: true,
    });
  });

  it('lo estructural sigue rechazándose (la laxitud es solo de appearance)', () => {
    expect(parseThemeFile(JSON.stringify({ ...OLD_THEME, format: 'otra-app' }))).toEqual({
      ok: false,
      error: 'Esto no es un tema de Orbit: falta la marca «format: orbit-theme».',
    });
    expect(parseThemeFile(JSON.stringify({ ...OLD_THEME, theme: 'neón' }))).toMatchObject({
      ok: false,
    });
  });
});

describe('buildThemeFile y la exportación', () => {
  it('el archivo exportado lleva siempre los tres campos nuevos', () => {
    const appearance: Appearance = {
      ...DEFAULT_APPEARANCE,
      style: 'classic',
      motion: false,
      glassMenus: true,
    };

    const file = buildThemeFile('Mi tema', 'acrylic', {}, appearance);
    const text = serializeThemeFile(file);

    expect(file.appearance).toEqual(appearance);
    expect(text).toContain('"style": "classic"');
    expect(text).toContain('"motion": false');
    expect(text).toContain('"glassMenus": true');
  });

  it('exportar y volver a importar conserva estilo, movimiento y vidrio', () => {
    const appearance: Appearance = {
      ...DEFAULT_APPEARANCE,
      scale: 1.15,
      radius: 11,
      style: 'classic',
      motion: false,
      glassMenus: true,
    };
    const text = serializeThemeFile(buildThemeFile('Ida y vuelta', 'light', {}, appearance));

    expect(parseOk(text).appearance).toEqual(appearance);
  });

  it('un tema custom viejo (sin los campos) se exporta ya normalizado', () => {
    // Lo que devuelve el lector de "Mis temas" antes de esta versión: un objeto
    // que en runtime no tiene style/motion/glassMenus, aunque el tipo lo pida.
    const legacy = { scale: 1.1, font: 'segoe', radius: 10 } as unknown as Appearance;

    expect(buildThemeFile('Viejo', 'dark', {}, legacy).appearance).toEqual({
      scale: 1.1,
      font: 'segoe',
      radius: 10,
      style: 'soft',
      motion: true,
      glassMenus: false,
    });
  });
});
