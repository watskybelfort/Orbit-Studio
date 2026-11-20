/**
 * Carpeta recordada de proyectos.
 *
 * `lastProjectDir` es lo que hace que «Abrir» y «Guardar como» arranquen donde
 * el usuario estuvo la última vez, en vez de Documents cada vez. Aquí se prueba
 * la aritmética pura; el cableado en los handlers se comprueba en la fuente,
 * como el resto de tests del main que no levantan Electron.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LAST_PROJECT_DIR_KEY,
  projectOpenDefaultPath,
  projectSaveDefaultPath,
  rememberedProjectDir,
  withRememberedProjectDir,
} from '../src/main/project-dirs';

const beats = resolve('beats');
const docs = resolve('docs');
const project = resolve(beats, 'tema.orbit');

describe('rememberedProjectDir', () => {
  it('devuelve la carpeta guardada y exige una ruta absoluta', () => {
    expect(rememberedProjectDir({ [LAST_PROJECT_DIR_KEY]: beats })).toBe(beats);
    expect(rememberedProjectDir({ [LAST_PROJECT_DIR_KEY]: 'beats' })).toBeNull();
    expect(rememberedProjectDir({ [LAST_PROJECT_DIR_KEY]: '' })).toBeNull();
    expect(rememberedProjectDir({ [LAST_PROJECT_DIR_KEY]: 42 })).toBeNull();
    expect(rememberedProjectDir({})).toBeNull();
  });
});

describe('defaultPath de los diálogos', () => {
  it('abrir arranca en la última carpeta, o en el fallback si no hay', () => {
    expect(projectOpenDefaultPath({ [LAST_PROJECT_DIR_KEY]: beats }, docs)).toBe(beats);
    expect(projectOpenDefaultPath({}, docs)).toBe(docs);
    expect(projectOpenDefaultPath({ [LAST_PROJECT_DIR_KEY]: 'relativa' }, docs)).toBe(docs);
  });

  it('guardar como propone el nombre dentro de la última carpeta', () => {
    expect(projectSaveDefaultPath({ [LAST_PROJECT_DIR_KEY]: beats }, docs, 'tema.orbit')).toBe(
      project,
    );
    expect(projectSaveDefaultPath({}, docs, 'tema.orbit')).toBe(resolve(docs, 'tema.orbit'));
  });
});

describe('withRememberedProjectDir', () => {
  it('recuerda la carpeta del archivo abierto o guardado', () => {
    expect(withRememberedProjectDir({}, project)).toMatchObject({
      [LAST_PROJECT_DIR_KEY]: beats,
    });
  });

  it('no reescribe si la carpeta ya era la misma', () => {
    const settings = { [LAST_PROJECT_DIR_KEY]: beats, theme: 'dark' };
    expect(withRememberedProjectDir(settings, project)).toBe(settings);
  });

  it('ignora rutas relativas o vacías', () => {
    const settings = { theme: 'dark' };
    expect(withRememberedProjectDir(settings, 'tema.orbit')).toBe(settings);
    expect(withRememberedProjectDir(settings, '')).toBe(settings);
  });
});

describe('cableado en el main', () => {
  it('abrir, guardar y abrir un reciente pasan por la carpeta recordada', () => {
    const src = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(src).toContain('defaultPath: projectOpenDefaultPath(readSettings()');
    expect(src).toContain('defaultPath: projectSaveDefaultPath(readSettings()');
    // Una llamada en open-recent, otra en open y otra en save.
    expect(src.match(/rememberProjectDir\(/g)).toHaveLength(4);
  });
});
