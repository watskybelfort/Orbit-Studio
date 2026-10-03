import { afterEach, describe, expect, it, vi } from 'vitest';
import { store } from '../src/state/app';
import { useUiStore } from '../src/state/ui';
import { applyLayout, applyLayoutWindows, applyPreset, areaAfterPanels, captureLayout, LAYOUT_PRESETS, savePresetAs, useLayoutNotice, workspaceArea } from '../src/state/layouts';
import { fitWindowToWorkspace, PRESET_EDITOR_MINIMUMS, type WorkspaceSize } from '../src/shell/window-bounds';
import type { LayoutWindow } from '@orbit/core';

const initialUi = useUiStore.getState();
const flag = (open: boolean) => ({ open, x: 0, y: 0, w: 0, h: 0 });

/** Solo geometría/estados: el DOM simulado conserva el render viejo hasta
 * commitRender, igual que React dentro del manejador que elige el preset. */
function fakeWorkspace(scale = 1, browserWidth = 240, claudeWidth = 280, physicalHeight = 660) {
  let rendered = { ...useUiStore.getState() };
  const total = { w: Math.floor(1366 / scale), h: Math.floor(physicalHeight / scale) };
  class Element {
    constructor(readonly kind: 'columns' | 'workspace' | 'browser' | 'claude') {}
    get clientWidth() {
      if (this.kind === 'columns') return total.w;
      if (this.kind === 'browser') return browserWidth;
      if (this.kind === 'claude') return claudeWidth;
      return total.w - (rendered.browserOpen && !rendered.compact ? browserWidth : 0) - (rendered.claudePanelOpen && !rendered.compact ? claudeWidth : 0);
    }
    get clientHeight() { return total.h; }
  }
  const columns = new Element('columns');
  const workspace = new Element('workspace');
  const browser = new Element('browser');
  const claude = new Element('claude');
  const computedStyle = (element: Element) => ({
    width: `${element.clientWidth}px`,
    getPropertyValue: (name: string) => name === '--sidebar-width' ? '240px' : name === '--assistant-width' ? '280px' : '',
  });
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', {
    defaultView: { getComputedStyle: computedStyle },
    querySelector: (selector: string) => {
      if (selector === '.workspace') return workspace;
      if (selector === '.app-columns') return columns;
      if (selector === '.app-columns > .sidebar') return rendered.browserOpen && !rendered.compact ? browser : null;
      if (selector === '.app-columns > .claude-panel') return rendered.claudePanelOpen && !rendered.compact ? claude : null;
      return null;
    },
  });
  return { total, commitRender: () => { rendered = { ...useUiStore.getState() }; } };
}

/** Comprueba las cajas que pintará InternalWindow, con los mismos mínimos que
 * Workspace, no solo el tamaño pedido al store (que puede ser demasiado chico). */
function expectVisibleWithoutOverlap(windows: Record<string, LayoutWindow>, area: WorkspaceSize) {
  const boxes = Object.entries(PRESET_EDITOR_MINIMUMS).flatMap(([id, minimum]) => {
    const win = windows[id];
    return win?.open ? [fitWindowToWorkspace(win, area, minimum)] : [];
  });
  expect(boxes.length).toBeGreaterThan(0);
  for (const [i, a] of boxes.entries()) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(area.w);
    expect(a.y + a.h).toBeLessThanOrEqual(area.h);
    for (const b of boxes.slice(i + 1)) {
      expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  }
}

describe('BUG028: medir el área de destino de un layout', () => {
  afterEach(() => {
    useUiStore.setState(initialUi, true);
    useLayoutNotice.getState().dismiss();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([[1, 660], [1.25, 570], [1.5, 506]])('abrir → cerrar navegador a escala %s usa todo el ancho desde la primera vez', (scale, height) => {
    useUiStore.setState({ browserOpen: true, claudePanelOpen: false, compact: false });
    const view = fakeWorkspace(scale, 240, 280, height);
    applyPreset('mezclar');
    expect(useUiStore.getState().windows.mixer.w).toBe(view.total.w - 24);
    expect(useUiStore.getState().windows.playlist.open).toBe(scale !== 1.5);
    if (scale !== 1.5) expect(useUiStore.getState().windows.playlist.w).toBe(view.total.w - 24);
    else expect(useLayoutNotice.getState().message).toContain('Abre Arreglo desde la barra');
    expectVisibleWithoutOverlap(captureLayout(), view.total);
    const first = captureLayout();
    view.commitRender();
    applyPreset('mezclar');
    expect(captureLayout()).toEqual(first);
  });

  it.each([1, 1.25, 1.5])('cerrar → abrir navegador a escala %s descuenta su ancho antes de construir', (scale) => {
    useUiStore.setState({ browserOpen: false, claudePanelOpen: false, compact: false });
    const view = fakeWorkspace(scale);
    applyPreset('componer');
    const rack = useUiStore.getState().windows.channelRack;
    const piano = useUiStore.getState().windows.pianoRoll;
    const targetWidth = view.total.w - 240;
    if (scale === 1) {
      expect(rack.w).toBe(Math.round(targetWidth * 0.3));
      expect(piano.open).toBe(true);
      expect(piano.x).toBe(rack.w + 24);
      expect(piano.w).toBe(targetWidth - rack.w - 36);
      expect(useLayoutNotice.getState().message).toBeNull();
    } else {
      expect(rack.w).toBe(targetWidth - 24);
      expect(piano.open).toBe(false);
      expect(useLayoutNotice.getState().message).toBe('Espacio reducido: Ritmos ocupa el escritorio. Abre Notas desde la barra para editar melodías.');
    }
    expectVisibleWithoutOverlap(captureLayout(), { w: targetWidth, h: view.total.h });
    const first = captureLayout();
    view.commitRender();
    applyPreset('componer');
    expect(captureLayout()).toEqual(first);
  });

  it('descuenta ambos paneles y respeta un ancho vigente distinto del valor de fábrica', () => {
    useUiStore.setState({ browserOpen: true, claudePanelOpen: true, compact: false });
    const view = fakeWorkspace(1.25, 270, 310);
    applyLayoutWindows({
      mixer: { open: true, x: 0, y: 0, w: 4000, h: 300 },
      browser: flag(true), claudePanel: flag(false),
    });
    expect(useUiStore.getState().windows.mixer.w).toBe(view.total.w - 270);
  });

  it('abrir ambos paneles desde cerrados reserva los dos anchos antes del render', () => {
    useUiStore.setState({ browserOpen: false, claudePanelOpen: false, compact: false });
    const view = fakeWorkspace(1.25);
    applyLayoutWindows({
      mixer: { open: true, x: 0, y: 0, w: 4000, h: 300 },
      browser: flag(true), claudePanel: flag(true),
    });
    expect(useUiStore.getState().windows.mixer.w).toBe(view.total.w - 240 - 280);
  });

  it('un layout antiguo sin flags respeta el panel abierto y su ancho vigente', () => {
    useUiStore.setState({ browserOpen: false, claudePanelOpen: true, compact: false });
    const view = fakeWorkspace(1, 240, 310);
    applyLayoutWindows({ mixer: { open: true, x: 0, y: 0, w: 4000, h: 300 } });
    expect(useUiStore.getState().windows.mixer.w).toBe(view.total.w - 310);
    expect(useUiStore.getState()).toMatchObject({ browserOpen: false, claudePanelOpen: true });
  });

  it('la proyección pura conserva la altura y nunca devuelve un ancho negativo', () => {
    const total = { w: 400, h: 300 };
    const widths = { browser: 240, claude: 280 };
    expect(areaAfterPanels(total, widths, { browserOpen: true, claudePanelOpen: true, compact: false })).toEqual({ w: 0, h: 300 });
    expect(areaAfterPanels(total, widths, { browserOpen: true, claudePanelOpen: true, compact: true })).toEqual(total);
    expect(total).toEqual({ w: 400, h: 300 });
  });

  it('en modo enfoque los paneles con flag abierto no quitan espacio', () => {
    useUiStore.setState({ browserOpen: true, claudePanelOpen: true, compact: true });
    const view = fakeWorkspace(1.5);
    applyPreset('arreglar');
    expect(useUiStore.getState().windows.playlist.w).toBe(view.total.w - 24);
  });

  it('guardar un preset usa su área destino sin alterar el escritorio actual', () => {
    useUiStore.setState({ browserOpen: true, claudePanelOpen: true, compact: false });
    const view = fakeWorkspace(1.25);
    const before = captureLayout();
    const history = store.history.length;
    expect(savePresetAs('mezclar', 'BUG028 prueba')).toBe(true);
    expect(captureLayout()).toEqual(before);
    expect(store.project.layouts?.['BUG028 prueba']?.['mixer']?.w).toBe(view.total.w - 24);
    expect(store.history.length).toBe(history + 1);
    expect(applyLayout('BUG028 prueba')).toBe(true);
    expect(useUiStore.getState().windows.mixer.w).toBe(view.total.w - 24);
    store.undo();
  });

  it('el aviso es descartable y se limpia al volver a una distribución normal', () => {
    useUiStore.setState({ browserOpen: false, claudePanelOpen: false, compact: false });
    fakeWorkspace(1.5);
    applyPreset('componer');
    expect(useLayoutNotice.getState().message).not.toBeNull();
    useLayoutNotice.getState().dismiss();
    expect(useLayoutNotice.getState().message).toBeNull();
    applyPreset('componer');
    fakeWorkspace(1);
    applyPreset('mezclar');
    expect(useLayoutNotice.getState().message).toBeNull();
  });

  it('guardar el modo estrecho no cambia el aviso ni añade metadatos al proyecto', () => {
    useUiStore.setState({ browserOpen: false, claudePanelOpen: false, compact: false });
    fakeWorkspace(1.5);
    useLayoutNotice.setState({ message: 'Aviso anterior' });
    const before = captureLayout();
    expect(savePresetAs('componer', 'BUG028 estrecho')).toBe(true);
    try {
      expect(captureLayout()).toEqual(before);
      expect(useLayoutNotice.getState().message).toBe('Aviso anterior');
      const saved = store.project.layouts?.['BUG028 estrecho'];
      expect(Object.keys(saved ?? {}).sort()).toEqual(['browser', 'channelRack', 'claudePanel']);
      expect(applyLayout('BUG028 estrecho')).toBe(true);
      expect(useUiStore.getState().windows.channelRack.open).toBe(true);
      expect(useUiStore.getState().windows.pianoRoll.open).toBe(false);
      expect(useLayoutNotice.getState().message).toBeNull();
    } finally {
      store.undo();
    }
  });

  it('consultar el área actual sigue midiendo el render presente, sin anticipar flags', () => {
    useUiStore.setState({ browserOpen: true, claudePanelOpen: false, compact: false });
    const view = fakeWorkspace(1.25);
    useUiStore.setState({ browserOpen: false });
    expect(workspaceArea().w).toBe(view.total.w - 240);
    view.commitRender();
    expect(workspaceArea().w).toBe(view.total.w);
  });
});

describe('presets: cabida con los mínimos reales de los editores', () => {
  it.each([
    ['componer', { w: 1126, h: 600 }, ['channelRack', 'pianoRoll']],
    ['componer', { w: 852, h: 450 }, ['channelRack']],
    ['componer', { w: 670, h: 337 }, ['channelRack']],
    ['componer', { w: 250, h: 170 }, ['channelRack']],
    ['componer', { w: 915, h: 600 }, ['channelRack']],
    ['componer', { w: 916, h: 600 }, ['channelRack', 'pianoRoll']],
    ['mezclar', { w: 1366, h: 600 }, ['playlist', 'mixer']],
    ['mezclar', { w: 911, h: 337 }, ['mixer']],
    ['mezclar', { w: 1366, h: 435 }, ['mixer']],
    ['mezclar', { w: 1366, h: 436 }, ['playlist', 'mixer']],
    ['mezclar', { w: 583, h: 600 }, ['mixer']],
    ['mezclar', { w: 584, h: 600 }, ['playlist', 'mixer']],
  ] as const)('%s en %j conserva visibles %j sin solapar', (id, area, expected) => {
    const preset = LAYOUT_PRESETS.find((p) => p.id === id)!;
    const windows = preset.build(area);
    const open = Object.keys(PRESET_EDITOR_MINIMUMS).filter((key) => windows[key]?.open);
    expect(open.sort()).toEqual([...expected].sort());
    expectVisibleWithoutOverlap(windows, area);
  });
});
