/**
 * Aplicar un layout guardado en el PROYECTO tiene que dejar las ventanas
 * dentro del escritorio de AHORA, igual que el camino de settings
 * (`workspace-memory.ts` pasa cada caja por `fitToArea`).
 *
 * El modelo no sabe qué monitor tienes: un layout guardado en una sesión con
 * dos pantallas trae coordenadas como x = 2600, y aplicarlo en un portátil
 * deja el mixer existiendo en el store pero invisible — se puede arrastrar a
 * ciegas, no se puede agarrar. El recorte tiene que ser el MISMO en los dos
 * caminos, sin una segunda copia de la regla.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

async function rig() {
  vi.resetModules();
  const { useUiStore } = await import('../src/state/ui');
  const layouts = await import('../src/state/layouts');
  return { useUiStore, layouts };
}

describe('layouts del proyecto: recorte al escritorio', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('una ventana que se quedó fuera vuelve a la vista', async () => {
    const { useUiStore, layouts } = await rig();
    layouts.applyLayoutWindows({
      mixer: { open: true, x: 9999, y: 9999, w: 3000, h: 2000 },
    });

    const area = layouts.workspaceArea();
    const w = useUiStore.getState().windows.mixer;
    expect(w.open).toBe(true);
    expect(w.x).toBeGreaterThanOrEqual(0);
    expect(w.y).toBeGreaterThanOrEqual(0);
    expect(w.x).toBeLessThanOrEqual(area.w);
    expect(w.y).toBeLessThanOrEqual(area.h);
    expect(w.w).toBeLessThanOrEqual(area.w);
    expect(w.h).toBeLessThanOrEqual(area.h);
  });

  it('un layout normal entra tal cual (el recorte no lo deforma)', async () => {
    const { useUiStore, layouts } = await rig();
    layouts.applyLayoutWindows({
      playlist: { open: true, x: 20, y: 30, w: 600, h: 300 },
    });

    const w = useUiStore.getState().windows.playlist;
    expect(w).toMatchObject({ open: true, x: 20, y: 30, w: 600, h: 300 });
  });

  it('las claves de los paneles del shell siguen siendo solo un flag', async () => {
    const { useUiStore, layouts } = await rig();
    layouts.applyLayoutWindows({
      playlist: { open: false, x: 0, y: 0, w: 500, h: 300 },
      [layouts.BROWSER_KEY]: { open: true, x: 0, y: 0, w: 0, h: 0 },
      [layouts.CLAUDE_KEY]: { open: false, x: 0, y: 0, w: 0, h: 0 },
    });

    expect(useUiStore.getState().browserOpen).toBe(true);
    expect(useUiStore.getState().claudePanelOpen).toBe(false);
  });
});
