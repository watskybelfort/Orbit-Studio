/**
 * `patchInputRoute` funde una ráfaga (arrastrar el deslizador de ganancia, o
 * el NumberScrubber de la pista de mixer) en UN solo paso de undo, con
 * `mergeKey` — igual que hace `AudioEditor` con `ae:gain:${clip.id}`.
 *
 * Antes: `patchInputRoute` despachaba sin `mergeKey`, así que un arrastre del
 * deslizador de ganancia (`<input type="range" min=0 max=4 step=0.05>`, hasta
 * 80 eventos por gesto) dejaba hasta 80 entradas «Ajustar entrada» en el
 * historial, y deshacer el gesto entero pedía ~80 Ctrl+Z.
 *
 * Lo que hay que demostrar, y que un vistazo al panel de Historial no prueba
 * con la misma fuerza:
 *
 * - una ráfaga de ~80 dispatches de ganancia sobre la MISMA ruta deja UNA
 *   entrada en el historial, y deshacerla una vez devuelve la ganancia al
 *   valor de ANTES del gesto (no al penúltimo paso, que es el bug que deja un
 *   `mergeKey` que solo lleve el id sin el campo, o ninguno);
 * - dos rutas distintas no se funden entre sí, aunque la ráfaga de una
 *   empiece justo donde termina la de la otra;
 * - dos campos de la MISMA ruta (ganancia y nombre) tampoco se funden entre
 *   sí, aunque caigan en la misma ventana de fusión.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function rig() {
  vi.resetModules();

  vi.stubGlobal('window', {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  // Sin `mediaDevices`: nada de esto abre un micro de verdad, solo despacha
  // comandos contra el `ProjectStore`.
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  const monitor = await import('../src/state/input-monitor');

  return { core, app, monitor };
}

/** Declara una ruta de entrada mono en el canal 0, por el bus de comandos. */
function declareRoute(
  core: typeof import('@orbit/core'),
  store: import('@orbit/core').ProjectStore,
): string {
  const route = core.createInputRoute(0);
  store.dispatch({ type: 'addInputRoute', route });
  return route.id;
}

describe('patchInputRoute funde ráfagas por ruta y por campo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('un arrastre completo de ganancia (80 pasos) deja UNA entrada, y un undo vuelve al valor de antes del gesto', async () => {
    const { core, app, monitor } = await rig();
    const routeId = declareRoute(core, app.store);
    const gainBefore = app.store.project.inputRoutes[routeId]!.gain;
    expect(gainBefore).toBe(1);

    const historyBefore = app.store.history.length;

    // El deslizador real: min=0 max=4 step=0.05 → 80 pasos por un arrastre de
    // punta a punta.
    for (let i = 1; i <= 80; i++) {
      const value = Math.round(i * 0.05 * 100) / 100;
      monitor.patchInputRoute(routeId, { gain: value });
    }

    expect(app.store.project.inputRoutes[routeId]!.gain).toBe(4);
    // Una sola entrada nueva, no 80.
    expect(app.store.history.length).toBe(historyBefore + 1);

    const entry = app.store.history[app.store.history.length - 1]!;
    expect(entry.label).toBe('Ganancia de la entrada');
    expect(entry.mergeKey).toBe(`route:${routeId}:gain`);

    app.store.undo();
    // Al valor de ANTES del gesto — no al penúltimo paso (3.95).
    expect(app.store.project.inputRoutes[routeId]!.gain).toBe(gainBefore);
  });

  it('dos rutas distintas no se funden aunque una ráfaga empiece donde termina la otra', async () => {
    const { core, app, monitor } = await rig();
    const routeA = declareRoute(core, app.store);
    const routeB = declareRoute(core, app.store);
    const historyBefore = app.store.history.length;

    for (let i = 1; i <= 10; i++) monitor.patchInputRoute(routeA, { gain: i * 0.1 });
    for (let i = 1; i <= 10; i++) monitor.patchInputRoute(routeB, { gain: i * 0.1 });

    // Dos entradas: una por ruta, no una sola fundiendo las dos.
    expect(app.store.history.length).toBe(historyBefore + 2);

    // Deshacer una vez solo toca la ruta B (la última ráfaga); A queda intacta.
    app.store.undo();
    expect(app.store.project.inputRoutes[routeB]!.gain).toBe(1);
    expect(app.store.project.inputRoutes[routeA]!.gain).toBeCloseTo(1.0, 5);

    app.store.undo();
    expect(app.store.project.inputRoutes[routeA]!.gain).toBe(1);
  });

  it('ganancia y nombre de la MISMA ruta no se funden entre sí', async () => {
    const { core, app, monitor } = await rig();
    const routeId = declareRoute(core, app.store);
    const historyBefore = app.store.history.length;

    for (let i = 1; i <= 5; i++) monitor.patchInputRoute(routeId, { gain: i * 0.1 });
    monitor.patchInputRoute(routeId, { name: 'Voz' });
    for (let i = 1; i <= 5; i++) monitor.patchInputRoute(routeId, { gain: 1 + i * 0.1 });

    // Tres entradas: la ráfaga de ganancia, el cambio de nombre, y la
    // SEGUNDA ráfaga de ganancia (no se reengancha a la primera porque el
    // nombre quedó arriba de la pila en el medio).
    expect(app.store.history.length).toBe(historyBefore + 3);

    const labels = app.store.history.slice(-3).map((e) => e.label);
    expect(labels).toEqual(['Ganancia de la entrada', 'Nombre de la entrada', 'Ganancia de la entrada']);

    expect(app.store.project.inputRoutes[routeId]!.name).toBe('Voz');
    expect(app.store.project.inputRoutes[routeId]!.gain).toBeCloseTo(1.5, 5);
  });

  it('cubre los tres llamantes reales de MidiSection: gain, mixerTrack y name, cada uno con su propia mergeKey', async () => {
    const { core, app, monitor } = await rig();
    const routeId = declareRoute(core, app.store);
    const historyBefore = app.store.history.length;

    // gain: deslizador, ráfaga.
    for (let i = 1; i <= 3; i++) monitor.patchInputRoute(routeId, { gain: i * 0.2 });
    // mixerTrack: NumberScrubber, ráfaga.
    for (let i = 1; i <= 3; i++) monitor.patchInputRoute(routeId, { mixerTrack: i });
    // name: una entrada por pulsación.
    monitor.patchInputRoute(routeId, { name: 'V' });
    monitor.patchInputRoute(routeId, { name: 'Vo' });
    monitor.patchInputRoute(routeId, { name: 'Voz' });

    // Cada ráfaga funde en una sola entrada: 3 en total, no 9.
    expect(app.store.history.length).toBe(historyBefore + 3);
    const tail = app.store.history.slice(-3);
    expect(tail.map((e) => e.mergeKey)).toEqual([
      `route:${routeId}:gain`,
      `route:${routeId}:mixerTrack`,
      `route:${routeId}:name`,
    ]);
    expect(tail.map((e) => e.label)).toEqual([
      'Ganancia de la entrada',
      'Pista de la entrada',
      'Nombre de la entrada',
    ]);
  });
});
