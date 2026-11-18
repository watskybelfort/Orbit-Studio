/**
 * Personalización de color en la Playlist.
 *
 * Lo que puede romperse en silencio aquí no es el pintado (eso se ve): es que
 * un hex a medio escribir se cuele al modelo, que el check del swatch quede
 * ilegible sobre un color claro, que "volver al de fábrica" devuelva un color
 * que no está en la grilla, o que el picker nativo deje cuarenta pasos de undo
 * en vez de uno. La aritmética vive en `editors/playlist/color-tools.ts` y
 * `theme/track-palette.ts`; el flujo del componente se fija leyendo su fuente,
 * como el resto del repo (sin jsdom).
 */

import { describe, expect, it } from 'vitest';
import { PALETTE, ProjectStore, findProjectProblems } from '@orbit/core';
import {
  commonClipColor,
  isHexColor,
  normalizeHexColor,
  readableInk,
  resolveClipColor,
} from '../src/editors/playlist/color-tools';
import {
  SWATCH_INK_DARK,
  SWATCH_INK_LIGHT,
  TRACK_COLOR_PRESETS,
  defaultTrackColor,
} from '../src/theme/track-palette';
import { readSource } from './read-source';

describe('normalizeHexColor', () => {
  it('expande #rgb y baja todo a minúsculas', () => {
    expect(normalizeHexColor('#abc')).toBe('#aabbcc');
    expect(normalizeHexColor('ABC')).toBe('#aabbcc');
    expect(normalizeHexColor('  #A1b2C3  ')).toBe('#a1b2c3');
    expect(normalizeHexColor('#AbCdEf')).toBe('#abcdef');
  });

  it('acepta 4 y 8 dígitos y descarta la alpha', () => {
    // El modelo guarda colores opacos y <input type="color"> no maneja alpha:
    // conservarla obligaría a inventar un formato que nadie lee.
    expect(normalizeHexColor('#abcd')).toBe('#aabbcc');
    expect(normalizeHexColor('#11223344')).toBe('#112233');
    expect(normalizeHexColor('11223380')).toBe('#112233');
  });

  it('rechaza lo que no es un hex opaco de 3, 4, 6 u 8 dígitos', () => {
    for (const bad of ['', '   ', 'red', 'rgb(1,2,3)', '#12', '#12345', '#ggg', '#abc#def', '##abc', '# 123']) {
      expect(normalizeHexColor(bad)).toBeNull();
    }
    expect(normalizeHexColor(null)).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
  });

  it('isHexColor es exactamente "normaliza distinto de null"', () => {
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('abcdef')).toBe(true);
    expect(isHexColor('white')).toBe(false);
    expect(isHexColor('#12345')).toBe(false);
    expect(isHexColor(undefined)).toBe(false);
  });
});

describe('readableInk', () => {
  it('elige la tinta que más contrasta, no un umbral fijo', () => {
    expect(readableInk('#101114')).toBe(SWATCH_INK_LIGHT);
    expect(readableInk('#f7f8fa')).toBe(SWATCH_INK_DARK);
    // Amarillo: luminancia alta, check oscuro (con un umbral de 0,45 fijo
    // también saldría, pero el grafito de abajo es el caso que lo distingue).
    expect(readableInk('#e6c95a')).toBe(SWATCH_INK_DARK);
    expect(readableInk('#8e8e93')).toBe(SWATCH_INK_DARK);
    expect(readableInk('#1e3a8a')).toBe(SWATCH_INK_LIGHT);
  });

  it('siempre devuelve una de las dos tintas del tema, incluso con basura', () => {
    for (const preset of TRACK_COLOR_PRESETS) {
      expect([SWATCH_INK_DARK, SWATCH_INK_LIGHT]).toContain(readableInk(preset.value));
    }
    expect(readableInk('no-es-un-color')).toBe(SWATCH_INK_LIGHT);
  });
});

describe('resolveClipColor', () => {
  it('la cadena de siempre: propio → patrón → acento', () => {
    expect(resolveClipColor('#111111', '#222222', '#333333')).toBe('#111111');
    expect(resolveClipColor(undefined, '#222222', '#333333')).toBe('#222222');
    expect(resolveClipColor(undefined, undefined, '#333333')).toBe('#333333');
    expect(resolveClipColor(null, null, '#333333')).toBe('#333333');
  });

  it('una cadena vacía es "sin color", no un color', () => {
    expect(resolveClipColor('', '#222222', '#333333')).toBe('#222222');
    expect(resolveClipColor('  ', undefined, '#333333')).toBe('#333333');
  });

  it('la pista va por encima del patrón y por debajo del clip', () => {
    // Es la personalización de la pista: elegir su color tiene que pintar lo
    // que hay dentro, o el swatch de la cabecera sería decoración.
    expect(resolveClipColor(undefined, '#222222', '#333333', '#444444')).toBe('#444444');
    expect(resolveClipColor('#111111', '#222222', '#333333', '#444444')).toBe('#111111');
    expect(resolveClipColor(undefined, '#222222', '#333333', null)).toBe('#222222');
  });
});

describe('commonClipColor', () => {
  it('solo marca un color si TODOS lo comparten, comparando normalizado', () => {
    expect(commonClipColor(['#ABC', '#aabbcc'])).toBe('#aabbcc');
    expect(commonClipColor(['#aabbcc', '#112233'])).toBeUndefined();
    expect(commonClipColor(['#aabbcc', undefined])).toBeUndefined();
    expect(commonClipColor([undefined, undefined])).toBeUndefined();
    expect(commonClipColor([])).toBeUndefined();
  });
});

describe('TRACK_COLOR_PRESETS y defaultTrackColor', () => {
  it('la paleta tiene entre 12 y 14 colores únicos, todos hex y con nombre', () => {
    expect(TRACK_COLOR_PRESETS.length).toBeGreaterThanOrEqual(12);
    expect(TRACK_COLOR_PRESETS.length).toBeLessThanOrEqual(14);
    expect(new Set(TRACK_COLOR_PRESETS.map((preset) => preset.value)).size).toBe(
      TRACK_COLOR_PRESETS.length,
    );
    for (const preset of TRACK_COLOR_PRESETS) {
      expect(normalizeHexColor(preset.value)).toBe(preset.value);
      expect(preset.name.trim()).not.toBe('');
    }
  });

  it('cada orden da siempre el mismo color y cae en un preset visible', () => {
    const values = TRACK_COLOR_PRESETS.map((preset) => preset.value);
    // Los diez primeros presets son la PALETTE de core: "Volver al color de
    // fábrica" tiene que devolver una casilla que el usuario pueda volver a
    // pulsar, no un color parecido que no está en la grilla.
    expect(values.slice(0, PALETTE.length)).toEqual([...PALETTE]);
    for (let order = 0; order < 40; order++) {
      const color = defaultTrackColor(order);
      expect(color).toBe(defaultTrackColor(order));
      expect(values).toContain(color);
    }
    const ciclo = new Set(Array.from({ length: PALETTE.length }, (_, i) => defaultTrackColor(i)));
    expect(ciclo.size).toBe(PALETTE.length);
  });

  it('un orden negativo o no finito cae en el primero en vez de devolver undefined', () => {
    expect(defaultTrackColor(-1)).toBe(defaultTrackColor(0));
    expect(defaultTrackColor(Number.NaN)).toBe(defaultTrackColor(0));
    expect(defaultTrackColor(Number.POSITIVE_INFINITY)).toBe(defaultTrackColor(0));
  });
});

describe('el comando de color en el bus real', () => {
  const [presetA, presetB] = TRACK_COLOR_PRESETS;
  const ids = ['c1', 'c2', 'c3'] as const;

  function base() {
    const store = new ProjectStore();
    const track = Object.values(store.project.playlistTracks)[0]!;
    store.dispatch({
      type: 'addClips',
      clips: ids.map((id, index) => ({
        id,
        kind: 'pattern' as const,
        playlistTrackId: track.id,
        start: index * 4,
        length: 4,
        muted: false,
      })),
    });
    return store;
  }

  const paint = (store: ProjectStore, color: string | undefined, mergeKey: string) =>
    store.dispatch(
      { type: 'patchClips', patches: ids.map((id) => ({ id, color })) },
      { label: 'Color de 3 clips', mergeKey },
    );

  it('pinta toda la selección con UN paso de undo y lo deshace entero', () => {
    const store = base();
    paint(store, presetA!.value, `pl:clip-color:${[...ids].sort().join(',')}`);
    for (const id of ids) expect(store.project.clips[id]!.color).toBe(presetA!.value);
    expect(store.undo()).toBe(true);
    for (const id of ids) expect(store.project.clips[id]).not.toHaveProperty('color');
    expect(findProjectProblems(store.project as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('la ráfaga del picker nativo se funde en un solo undo', () => {
    const store = base();
    const mergeKey = `pl:clip-color:${[...ids].sort().join(',')}`;
    for (const color of [presetA!.value, presetB!.value, presetA!.value]) {
      paint(store, color, mergeKey);
    }
    for (const id of ids) expect(store.project.clips[id]!.color).toBe(presetA!.value);
    store.undo();
    // Sin mergeKey quedarían dos colores puestos después del Ctrl+Z.
    for (const id of ids) expect(store.project.clips[id]).not.toHaveProperty('color');
  });

  it('quitar el color propio (undefined) es un cambio borrable y no rompe el proyecto', () => {
    const store = base();
    paint(store, presetA!.value, 'pl:clip-color:prueba');
    paint(store, undefined, 'pl:clip-color:prueba:quitar');
    for (const id of ids) expect(store.project.clips[id]).not.toHaveProperty('color');
    expect(findProjectProblems(store.project as unknown as Record<string, unknown>)).toEqual([]);
    // El undo devuelve el color propio: `undefined` BORRA la clave, no la
    // escribe, y el inverso usa la marca de borrado serializable de core.
    store.undo();
    for (const id of ids) expect(store.project.clips[id]!.color).toBe(presetA!.value);
  });
});

describe('el flujo de color dentro de la Playlist', () => {
  const src = readSource('editors/playlist/Playlist.tsx');

  it('el swatch de la cabecera es un botón con menú, no un label con input escondido', () => {
    expect(src).not.toContain('<label className="pl-swatch"');
    expect(src).toContain('className="pl-swatch"');
    expect(src).toContain('aria-haspopup="dialog"');
    expect(src).toContain('aria-expanded={colorMenu !== null}');
    // El pointerdown del SWATCH no se corta: el arrastre de la ventana solo
    // empieza en la cabecera de la ventana, y cortarlo impedía que pulsar el
    // swatch trajera la Playlist al frente (focusWindow escucha en la raíz).
    const swatchStart = src.indexOf('className="pl-swatch"');
    const swatchEnd = src.indexOf('/>', swatchStart);
    expect(swatchStart).toBeGreaterThanOrEqual(0);
    expect(swatchEnd).toBeGreaterThan(swatchStart);
    expect(src.slice(swatchStart, swatchEnd)).not.toContain('onPointerDown');
    // Los presets llevan nombre accesible en español.
    expect(src).toMatch(/aria-label=\{`Color \$\{preset\.name\}`\}/);
  });

  it('la selección se pinta con UN patchClips y mergeKey por ids ordenados', () => {
    const start = src.indexOf('const setSelectionColor');
    const end = src.indexOf('const nudgeTotal', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const flow = src.slice(start, end);
    expect((flow.match(/store\.dispatch\(/g) ?? []).length).toBe(1);
    expect((flow.match(/type: 'patchClips'/g) ?? []).length).toBe(1);
    expect(flow).toContain('const ids = [...selectedIds].sort();');
    expect(flow).toMatch(/label: `Color de \$\{ids\.length\} clip/);
    expect(flow).toMatch(/mergeKey: `pl:clip-color:\$\{ids\.join\(','\)\}`/);
  });

  it('el lienzo resuelve el color del clip y la pista pinta lo que no tiene color propio', () => {
    expect(src).toContain('resolveClipColor(');
    expect(src).toContain('project.playlistTracks[c.playlistTrackId]?.color');
    expect(src).toContain('project.patterns[c.patternId]?.color');
  });

  it('no hay llamadas nuevas a prompt() (Electron no lo soporta)', () => {
    expect(src).not.toContain('window.prompt(');
  });
});
