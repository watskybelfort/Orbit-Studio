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

  it('un name con muchas barras y comilla sin cerrar no cuelga (ReDoS)', () => {
    // El regex anterior de parseName tenía backtracking catastrófico: una tirada
    // de `\` sin comilla de cierre lo colgaba. Con el LiteralReader es lineal.
    const evil = src(`const name = "${'\\'.repeat(40)}`); // comilla sin cerrar
    const t0 = performance.now();
    const parsed = parsePluginSource(evil);
    expect(performance.now() - t0).toBeLessThan(500);
    // La fuente sigue siendo un plugin válido (tiene createEffect); el name
    // simplemente no se pudo leer.
    expect(parsed).not.toBeNull();
  });

  it('lee name con escapes correctamente (via LiteralReader)', () => {
    const parsed = parsePluginSource(src(`const name = "Mi\\nTremolo";`));
    expect(parsed?.name).toBe('Mi\nTremolo');
  });

  it('NO ejecuta el top-level del plugin (parseo estático)', () => {
    const marker = '__orbit_plugin_exec_test__';
    const g = globalThis as unknown as Record<string, unknown>;
    delete g[marker];
    const parsed = parsePluginSource(`globalThis['${marker}'] = true;
const name = 'Malicioso';
const params = [{ key: 'g', min: 0, max: 1, default: 0.5 }];
function createEffect(sampleRate) { return { process(l, r, n) {} }; }`);
    // La metadata se leyó…
    expect(parsed?.name).toBe('Malicioso');
    expect(parsed?.params).toHaveLength(1);
    // …pero el efecto secundario del top-level NUNCA ocurrió (no se ejecutó nada).
    expect(g[marker]).toBeUndefined();
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

describe('plugins de instrumento (v1.0)', () => {
  const instrument = `const name = 'Mono';
function createInstrument(sampleRate) {
  return {
    noteOn(key, velocity) {},
    noteOff() {},
    render(l, r, from, to, gainL, gainR) { return false; },
  };
}`;

  it('un archivo con createInstrument vale aunque no traiga createEffect', () => {
    const parsed = parsePluginSource(instrument);
    expect(parsed).not.toBeNull();
    expect(parsed?.instrument).toBe(true);
    expect(parsed?.effect).toBe(false);
    expect(parsed?.name).toBe('Mono');
  });

  it('un archivo puede traer las dos fábricas', () => {
    const parsed = parsePluginSource(`${instrument}
function createEffect(sr) { return { process(l, r, n) {} }; }`);
    expect(parsed?.effect).toBe(true);
    expect(parsed?.instrument).toBe(true);
  });

  it('sin ninguna de las dos fábricas se descarta', () => {
    expect(parsePluginSource("const name = 'Nada';")).toBeNull();
  });
});
