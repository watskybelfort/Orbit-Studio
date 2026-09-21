/**
 * Grabar MIDI armado y dar a Stop con una tecla todavía pulsada.
 *
 * El cruce de vuelta del loop ya cerraba las notas de `held` en el beat del
 * final de la pasada (ver el comentario del `subscribe` en `live-input.ts`),
 * pero la parada del transporte no: `commitRecording()` volcaba lo apuntado y
 * la nota que seguías sosteniendo se quedaba fuera de la toma — la tocas, la
 * dejas apretada, das Stop y esa nota no existe.
 *
 * Este test toca el teclado del PC (sin Web MIDI): lo que se prueba es la
 * transición `playing → parado`, no el transporte real.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

interface Rig {
  store: typeof import('../src/state/app')['store'];
  live: typeof import('../src/state/live-input');
  ui: typeof import('../src/state/ui');
  channelId: string;
  patternId: string;
  keydown: (key: string) => void;
}

async function rig(): Promise<Rig> {
  vi.resetModules();
  const listeners = new Map<string, (e: unknown) => void>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  vi.stubGlobal('document', { activeElement: null });
  // Sin Web MIDI: el teclado del PC es suficiente y no arrastra hardware.
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  const { store, engine } = await import('../src/state/app');
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);

  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const live = await import('../src/state/live-input');
  const ui = await import('../src/state/ui');
  live.initLiveInput();

  const patternId = store.project.patternOrder[0]!;
  return {
    store,
    live,
    ui,
    channelId: channel.id,
    patternId,
    keydown: (key: string) => {
      listeners.get('keydown')?.({
        key,
        repeat: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        timeStamp: 16,
      });
    },
  };
}

describe('grabación MIDI: la nota sostenida entra en la toma al dar Stop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cerrar el transporte con la tecla pulsada no pierde esa nota', async () => {
    const { store, live, ui, channelId, patternId, keydown } = await rig();
    live.useLiveInputStore.setState({ armed: true });
    ui.useUiStore.setState({ playing: true, positionBeats: 8, activePatternId: patternId });

    keydown('x');
    expect(live.useLiveInputStore.getState().heldKeys).toBe(1);

    // Stop del transporte (lo que hace `stopPlayback`, sin motor real).
    ui.useUiStore.setState({ playing: false });

    const notes = store.project.patterns[patternId]!.notes[channelId] ?? [];
    expect(notes).toHaveLength(1);
    // Empezó en el beat donde iba el playhead (0 en este rig sin medidores) y
    // se cierra en el beat donde paró: la duración es la de la pulsación.
    expect(notes[0]!.duration).toBeCloseTo(8, 5);
  });
});
