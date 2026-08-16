import { describe, expect, it } from 'vitest';
import { defaultPluginParams, parsePluginSource } from '../src/state/plugin-parse';

/** Fuente mínima válida: createEffect + metadata opcional por delante. */
function src(header: string): string {
  return `${header}
function createEffect(sampleRate) {
  return { process(l, r, n) {} };
}`;
}

describe('parsePluginSource: contrato del SDK de plugins JS', () => {
  it('fuente válida devuelve name y params saneados', () => {
    const parsed = parsePluginSource(
      src(`const name = 'Tremolo';
const params = [
  { key: 'rate', label: 'Rate', min: 0.1, max: 20, default: 5, unit: 'Hz', curve: 'exp' },
  { key: 'depth', min: 0, max: 1, default: 0.6 },
];`),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Tremolo');
    expect(parsed!.params).toEqual([
      { key: 'rate', label: 'Rate', min: 0.1, max: 20, default: 5, unit: 'Hz', curve: 'exp' },
      // label ausente → cae a la key
      { key: 'depth', label: 'depth', min: 0, max: 1, default: 0.6 },
    ]);
  });

  it('sin name declarado el nombre queda null (el llamante usa el archivo)', () => {
    const parsed = parsePluginSource(src(''));
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBeNull();
    expect(parsed!.params).toEqual([]);
  });

  it('fuente sin createEffect se descarta', () => {
    expect(parsePluginSource(`const name = 'Nada';`)).toBeNull();
    // createEffect existe pero no es función
    expect(parsePluginSource(`const createEffect = 42;`)).toBeNull();
  });

  it('fuente que no compila o lanza en el top-level se descarta', () => {
    expect(parsePluginSource('function {{{')).toBeNull();
    expect(parsePluginSource(`throw new Error('boom');`)).toBeNull();
  });

  it('params que no son array se tratan como sin perillas', () => {
    const parsed = parsePluginSource(src(`const params = { key: 'x' };`));
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual([]);
  });

  it('entradas corruptas de params se descartan y el default se recorta', () => {
    const parsed = parsePluginSource(
      src(`const params = [
  null,
  'texto',
  { label: 'Sin key', min: 0, max: 1, default: 0 },
  { key: '', min: 0, max: 1, default: 0 },
  { key: 'nan', min: 0, max: NaN, default: 0 },
  { key: 'inf', min: -Infinity, max: 1, default: 0 },
  { key: 'rango', min: 5, max: 5, default: 5 },
  { key: 'alReves', min: 10, max: 0, default: 5 },
  { key: 'fuera', min: 0, max: 1, default: 99 },
  { key: 'ok', label: 'OK', min: -1, max: 1, default: 0, curve: 'rara', unit: 7 },
  { key: 'ok', label: 'Duplicada', min: 0, max: 2, default: 1 },
];`),
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.params).toEqual([
      // default 99 recortado al máximo del rango
      { key: 'fuera', label: 'fuera', min: 0, max: 1, default: 1 },
      // curve/unit inválidos se omiten; la key duplicada no repite perilla
      { key: 'ok', label: 'OK', min: -1, max: 1, default: 0 },
    ]);
  });

  it('un return prematuro en la fuente no cuela metadata falsa', () => {
    expect(parsePluginSource(`return { factory: true, name: 'Troyano', params: [] };`)).toBeNull();
  });
});

describe('defaultPluginParams', () => {
  it('construye el record de defaults desde los specs', () => {
    expect(
      defaultPluginParams([
        { key: 'rate', label: 'Rate', min: 0.1, max: 20, default: 5 },
        { key: 'depth', label: 'Depth', min: 0, max: 1, default: 0.6 },
      ]),
    ).toEqual({ rate: 5, depth: 0.6 });
  });
});
