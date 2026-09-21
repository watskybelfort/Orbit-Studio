/**
 * Dos formas de dejar una nota colgada con el teclado MIDI, con el mismo
 * patrón detrás: algo cambia fuera del mensaje que iba a soltarla.
 *
 * 1. **Cambiar de canal con una tecla pulsada.** El note-off llega con el
 *    canal VIEJO y el filtro del canal nuevo lo descarta. `setMidiOctave` ya
 *    soltaba todo antes de cambiar (su note-off llegaría transponido), pero
 *    `setMidiChannel` no.
 * 2. **Desenchufar el controlador.** `attach` solo reparte manejadores de los
 *    dispositivos presentes; los que desaparecen no liberan nada, ya no hay
 *    quién mande su note-off.
 *
 * En los dos casos el pedal de sostenido se olvida del dispositivo (espejo de
 * `setMidiDeviceEnabled`), o sus notas retenidas se quedarían sonando sin
 * dueño.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });

interface FakeInput {
  id: string;
  name: string;
  onmidimessage: ((e: unknown) => void) | null;
}

interface Rig {
  live: typeof import('../src/state/live-input');
  send: (bytes: number[]) => void;
  inputs: Map<string, FakeInput>;
  /** Simula el desenchufe: el aparato sale de la lista y dispara el evento. */
  unplug: () => void;
  /** Simula el evento del sistema sin tocar la lista (otro micro, etc.). */
  stateChange: () => void;
}

async function rig(): Promise<Rig> {
  vi.resetModules();
  const listeners = new Map<string, (e: unknown) => void>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  });
  vi.stubGlobal('document', { activeElement: null });

  const fakeInput: FakeInput = { id: 'dev1', name: 'Teclado de mentira', onmidimessage: null };
  const inputs = new Map<string, FakeInput>([['dev1', fakeInput]]);
  const access = {
    inputs,
    onstatechange: null as (() => void) | null,
  };
  vi.stubGlobal('navigator', { requestMIDIAccess: () => Promise.resolve(access) });

  const core = await import('@orbit/core');
  const { store, engine } = await import('../src/state/app');
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);

  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const live = await import('../src/state/live-input');
  live.initLiveInput();
  // La resolución de `requestMIDIAccess()` es una promesa: dejarla asentar.
  await Promise.resolve();
  await Promise.resolve();

  return {
    live,
    inputs,
    send: (bytes: number[], timeStamp = 0) =>
      fakeInput.onmidimessage?.({ data: new Uint8Array(bytes), timeStamp }),
    unplug: () => {
      inputs.delete('dev1');
      access.onstatechange?.();
    },
    stateChange: () => access.onstatechange?.(),
  };
}

describe('live-input: soltar lo que suena cuando cambia el mundo por debajo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cambiar de canal MIDI con una tecla pulsada la suelta en el acto', async () => {
    const { live, send } = await rig();
    send([0x90, 60, 100]); // note-on, canal 1
    expect(live.useLiveInputStore.getState().heldKeys).toBe(1);

    live.setMidiChannel(2);

    // Sin esto la nota se queda sonando: su note-off llegar moriría en el
    // filtro del canal nuevo.
    expect(live.useLiveInputStore.getState().heldKeys).toBe(0);
  });

  it('desenchufar el controlador suelta la tecla que estaba pulsada', async () => {
    const { live, send, unplug } = await rig();
    send([0x90, 64, 90]);
    expect(live.useLiveInputStore.getState().heldKeys).toBe(1);

    unplug();

    expect(live.useLiveInputStore.getState().heldKeys).toBe(0);
  });

  it('desenchufar con el pedal pisado suelta también lo que el pedal retenía', async () => {
    const { live, send, unplug } = await rig();
    send([0x90, 67, 80]); // note-on
    send([0xb0, 64, 127]); // pedal abajo (CC 64)
    send([0x80, 67, 0]); // note-off: el pedal lo retiene
    expect(live.useLiveInputStore.getState().sustainedKeys).toBe(1);

    unplug();

    // Nadie va a mandar ya el CC 64 de bajada desde ese aparato.
    expect(live.useLiveInputStore.getState().heldKeys).toBe(0);
    expect(live.useLiveInputStore.getState().sustainedKeys).toBe(0);
  });

  it('un evento del sistema que no se lleva ningún aparato no suelta nada', async () => {
    const { live, send, stateChange } = await rig();
    send([0x90, 62, 90]);

    stateChange();

    expect(live.useLiveInputStore.getState().heldKeys).toBe(1);
  });
});
