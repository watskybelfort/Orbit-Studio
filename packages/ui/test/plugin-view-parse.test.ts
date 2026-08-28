/**
 * La declaración de la vista entra por el mismo sitio que el resto del contrato
 * del plugin: parseo ESTÁTICO, sin ejecutar nada, y con todo recortado a rangos
 * cerrados. Un `height` de un millón o mil etiquetas no pueden salir de aquí.
 */

import { describe, expect, it } from 'vitest';
import { parsePluginSource } from '../src/state/plugin-parse';
import {
  VIEW_DEFAULT_FPS,
  VIEW_DEFAULT_HEIGHT,
  VIEW_MAX_FPS,
  VIEW_MAX_HEIGHT,
  VIEW_MAX_LABELS,
  VIEW_MAX_LABEL_CHARS,
  VIEW_MIN_HEIGHT,
} from '../src/plugins/view-protocol';

/** Fuente mínima con DSP, para poder colgarle la vista. */
function src(header: string, withView = true): string {
  return `${header}
function createEffect(sampleRate) { return { process(l, r, n) {} }; }
${withView ? 'function createView(sampleRate) { return { draw(d, f) {} }; }' : ''}`;
}

describe('parseView: la vista declarada por el plugin', () => {
  it('sin createView no hay vista', () => {
    const parsed = parsePluginSource(src('const view = { height: 120 };', false));
    expect(parsed).not.toBeNull();
    // Un `const view` suelto NO abre ninguna superficie de dibujo.
    expect(parsed!.view).toBeNull();
  });

  it('con createView y sin `const view`, valores por defecto', () => {
    const parsed = parsePluginSource(src(''));
    expect(parsed!.view).toEqual({
      height: VIEW_DEFAULT_HEIGHT,
      fps: VIEW_DEFAULT_FPS,
      needs: { level: false, spectrum: false },
      labels: [],
    });
  });

  it('lee alto, ritmo, needs y etiquetas', () => {
    const parsed = parsePluginSource(
      src(`const view = {
  height: 140,
  fps: 24,
  needs: ['level', 'spectrum'],
  labels: ['in', 'out'],
};`),
    );
    expect(parsed!.view).toEqual({
      height: 140,
      fps: 24,
      needs: { level: true, spectrum: true },
      labels: ['in', 'out'],
    });
  });

  it('recorta el alto y el ritmo a rangos que la UI pueda pintar', () => {
    const big = parsePluginSource(src('const view = { height: 100000, fps: 5000 };'));
    expect(big!.view!.height).toBe(VIEW_MAX_HEIGHT);
    expect(big!.view!.fps).toBe(VIEW_MAX_FPS);
    const small = parsePluginSource(src('const view = { height: -3, fps: 0 };'));
    expect(small!.view!.height).toBe(VIEW_MIN_HEIGHT);
    expect(small!.view!.fps).toBeGreaterThan(0);
  });

  it('valores no numéricos caen al defecto en vez de colarse', () => {
    const parsed = parsePluginSource(
      src(`const view = { height: 'alto', fps: NaN, needs: 'todo' };`),
    );
    expect(parsed!.view).toEqual({
      height: VIEW_DEFAULT_HEIGHT,
      fps: VIEW_DEFAULT_FPS,
      needs: { level: false, spectrum: false },
      labels: [],
    });
  });

  it('needs desconocidos se ignoran (no abren datos que no existen)', () => {
    const parsed = parsePluginSource(
      src(`const view = { needs: ['level', 'micrófono', 'disco', 42] };`),
    );
    expect(parsed!.view!.needs).toEqual({ level: true, spectrum: false });
  });

  it('las etiquetas se recortan en número y en largo', () => {
    const many = Array.from({ length: 40 }, (_, i) => `'e${i}'`).join(', ');
    const parsed = parsePluginSource(src(`const view = { labels: [${many}] };`));
    expect(parsed!.view!.labels).toHaveLength(VIEW_MAX_LABELS);

    const long = 'x'.repeat(500);
    const one = parsePluginSource(src(`const view = { labels: ['${long}'] };`));
    expect(one!.view!.labels[0]!.length).toBe(VIEW_MAX_LABEL_CHARS);
  });

  it('etiquetas que no son texto, o vacías, se descartan', () => {
    const parsed = parsePluginSource(
      src(`const view = { labels: [1, null, '', '   ', 'buena', true] };`),
    );
    expect(parsed!.view!.labels).toEqual(['buena']);
  });

  it('un salto de línea dentro de una etiqueta no descoloca el dibujo', () => {
    const parsed = parsePluginSource(src(`const view = { labels: ['dos\\nlineas'] };`));
    expect(parsed!.view!.labels).toEqual(['dos lineas']);
  });

  it('un `view` que no es objeto literal deja los defaults', () => {
    const parsed = parsePluginSource(src('const view = [1, 2, 3];'));
    expect(parsed!.view!.height).toBe(VIEW_DEFAULT_HEIGHT);
  });

  it('NO ejecuta nada del plugin para leer la vista', () => {
    const marker = '__orbit_view_exec_test__';
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[marker];
    const parsed = parsePluginSource(`globalThis['${marker}'] = true;
const view = { height: 120, labels: ['x'] };
function createEffect(sr) { return { process(l, r, n) {} }; }
function createView(sr) { globalThis['${marker}'] = 'draw'; return { draw() {} }; }`);
    expect(parsed!.view!.height).toBe(120);
    expect(g[marker]).toBeUndefined();
  });

  it('createView como const flecha también cuenta como fábrica', () => {
    const parsed = parsePluginSource(`function createEffect(sr) { return { process(l,r,n){} }; }
const createView = (sr) => ({ draw(d, f) {} });`);
    expect(parsed!.view).not.toBeNull();
  });

  it('un plugin que solo dibuja (sin DSP) se sigue descartando', () => {
    // Una vista sin efecto ni instrumento no es un plugin: no hay nada que
    // insertar en la cadena.
    expect(parsePluginSource('function createView(sr) { return { draw() {} }; }')).toBeNull();
  });
});
