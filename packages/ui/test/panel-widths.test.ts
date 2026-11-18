import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPanelWidths,
  clampPanelWidth,
  flushPanelWidths,
  getPanelWidths,
  loadPanelWidths,
  PANEL_WIDTH_DEFAULTS,
  PANEL_WIDTH_LIMITS,
  PANEL_WIDTHS_KEY,
  parsePanelWidths,
  resetPanelWidth,
  savePanelWidths,
  setPanelWidth,
  subscribePanelWidths,
} from '../src/state/panel-widths';

/**
 * Todo corre en `environment: 'node'`: no hay DOM ni `window.orbit` de verdad.
 * Los pocos casos que necesitan uno se stubean con `vi.stubGlobal` y se
 * restauran en `afterEach`, como el resto de tests de `packages/ui`.
 */

beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // Sin window, load deja los de fábrica: el estado del módulo se resetea entre
  // pruebas aunque un test anterior lo haya movido.
  await loadPanelWidths();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('límites de ancho por panel', () => {
  it('recorta a los mínimos y máximos documentados', () => {
    expect(PANEL_WIDTH_LIMITS.browser).toEqual({ min: 180, max: 420 });
    expect(PANEL_WIDTH_LIMITS.claude).toEqual({ min: 220, max: 460 });
    expect(clampPanelWidth('browser', 10)).toBe(180);
    expect(clampPanelWidth('browser', 999)).toBe(420);
    expect(clampPanelWidth('claude', 0)).toBe(220);
    expect(clampPanelWidth('claude', 10_000)).toBe(460);
  });

  it('redondea y deja pasar los valores de dentro', () => {
    expect(clampPanelWidth('browser', 240.4)).toBe(240);
    expect(clampPanelWidth('browser', 240.6)).toBe(241);
    expect(clampPanelWidth('claude', 300)).toBe(300);
  });

  it('un valor que no es un número finito cae al de fábrica de SU panel', () => {
    expect(clampPanelWidth('browser', Number.NaN)).toBe(PANEL_WIDTH_DEFAULTS.browser);
    expect(clampPanelWidth('claude', Number.POSITIVE_INFINITY)).toBe(PANEL_WIDTH_DEFAULTS.claude);
    expect(clampPanelWidth('browser', Number.NEGATIVE_INFINITY)).toBe(PANEL_WIDTH_DEFAULTS.browser);
  });
});

describe('parsePanelWidths tolera settings basura', () => {
  it.each([null, undefined, 'no', 42, [], true])('sin objeto (%j) devuelve fábrica', (raw) => {
    expect(parsePanelWidths(raw)).toEqual(PANEL_WIDTH_DEFAULTS);
  });

  it('una clave rota no arrastra a la que está bien', () => {
    expect(parsePanelWidths({ browser: '300', claude: 310 })).toEqual({ browser: 240, claude: 310 });
  });

  it('recorta lo guardado fuera de rango', () => {
    expect(parsePanelWidths({ browser: 20, claude: 9_999 })).toEqual({ browser: 180, claude: 460 });
  });

  it('acepta números válidos y no muta los defaults', () => {
    const got = parsePanelWidths({ browser: 300, claude: 350 });
    expect(got).toEqual({ browser: 300, claude: 350 });
    expect(got).not.toBe(PANEL_WIDTH_DEFAULTS);
    expect(PANEL_WIDTH_DEFAULTS).toEqual({ browser: 240, claude: 280 });
  });

  it('ignora claves desconocidas y valores no finitos', () => {
    expect(parsePanelWidths({ browser: Number.NaN, claude: 300, otra: 999 })).toEqual({
      browser: 240,
      claude: 300,
    });
  });
});

describe('aplicar los tokens en <html>', () => {
  it('escribe --sidebar-width y --assistant-width', () => {
    const setProperty = vi.fn();
    vi.stubGlobal('document', { documentElement: { style: { setProperty } } });
    applyPanelWidths({ browser: 300, claude: 350 });
    expect(setProperty).toHaveBeenNthCalledWith(1, '--sidebar-width', '300px');
    expect(setProperty).toHaveBeenNthCalledWith(2, '--assistant-width', '350px');
  });

  it('sin document no explota ni hace nada', () => {
    expect(typeof document).toBe('undefined');
    expect(() => applyPanelWidths(PANEL_WIDTH_DEFAULTS)).not.toThrow();
  });
});

describe('cargar y guardar en settings.json', () => {
  it('lee panelWidths, recorta y deja el estado del módulo con lo aplicado', async () => {
    const get = vi.fn().mockResolvedValue({ [PANEL_WIDTHS_KEY]: { browser: 310, claude: 9_999 } });
    vi.stubGlobal('window', { orbit: { settings: { get, set: vi.fn() } } });

    expect(await loadPanelWidths()).toEqual({ browser: 310, claude: 460 });
    expect(getPanelWidths()).toEqual({ browser: 310, claude: 460 });
  });

  it('si settings.get falla, quedan los de fábrica y la promesa no rechaza', async () => {
    const get = vi.fn().mockRejectedValue(new Error('disco lleno'));
    vi.stubGlobal('window', { orbit: { settings: { get, set: vi.fn() } } });

    await expect(loadPanelWidths()).resolves.toEqual(PANEL_WIDTH_DEFAULTS);
    expect(getPanelWidths()).toEqual(PANEL_WIDTH_DEFAULTS);
  });

  it('sin puente de Electron también resuelve con fábrica', async () => {
    vi.stubGlobal('window', {});
    await expect(loadPanelWidths()).resolves.toEqual(PANEL_WIDTH_DEFAULTS);
  });

  it('guardar elige la última petición del debounce y escribe una sola vez', () => {
    vi.useFakeTimers();
    const set = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', { orbit: { settings: { get: vi.fn(), set } } });

    setPanelWidth('browser', 200);
    setPanelWidth('browser', 260);
    expect(set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith({ [PANEL_WIDTHS_KEY]: { browser: 260, claude: 280 } });
  });

  it('flush escribe ya y cancela el debounce pendiente', () => {
    vi.useFakeTimers();
    const set = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', { orbit: { settings: { get: vi.fn(), set } } });

    setPanelWidth('claude', 320);
    flushPanelWidths();
    expect(set).toHaveBeenCalledWith({ [PANEL_WIDTHS_KEY]: { browser: 240, claude: 320 } });
    vi.advanceTimersByTime(400);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('sin window, guardar no explota', () => {
    expect(() => savePanelWidths()).not.toThrow();
    expect(() => flushPanelWidths()).not.toThrow();
  });
});

describe('estado vivo', () => {
  it('setPanelWidth cambia el ancho vigente y lo recorta', () => {
    expect(setPanelWidth('browser', 999)).toBe(420);
    expect(getPanelWidths().browser).toBe(420);
  });

  it('resetPanelWidth vuelve al de fábrica', () => {
    setPanelWidth('claude', 400);
    expect(resetPanelWidth('claude')).toBe(PANEL_WIDTH_DEFAULTS.claude);
    expect(getPanelWidths().claude).toBe(PANEL_WIDTH_DEFAULTS.claude);
  });

  it('los suscriptores se enteran de los cambios y del desuscriptor', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePanelWidths(listener);
    setPanelWidth('browser', 300);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    setPanelWidth('browser', 320);
    expect(listener).not.toHaveBeenCalled();
  });
});
