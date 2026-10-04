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
  send: (bytes: number[], timeStamp?: number) => void;
  app: typeof import('../src/state/app');
  ui: typeof import('../src/state/ui');
  preview: ReturnType<typeof vi.spyOn>;
  channelId: string;
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
  const app = await import('../src/state/app');
  const { store, engine } = app;
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);
  const preview = vi.spyOn(engine, 'previewNote');
  const ui = await import('../src/state/ui');

  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const live = await import('../src/state/live-input');
  live.initLiveInput();
  // La resolución de `requestMIDIAccess()` es una promesa: dejarla asentar.
  await Promise.resolve();
  await Promise.resolve();

  return {
    live,
    app,
    ui,
    preview,
    channelId: channel.id,
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

  it('dos canales sostienen el mismo do hasta el último note-off, sin perder ninguna nota grabada', async () => {
    const { live, send, preview, app, ui, channelId } = await rig();
    live.useLiveInputStore.setState({ armed: true });
    ui.useUiStore.setState({ playing: true });
    send([0x90, 60, 100]);
    send([0x91, 60, 80]);
    expect(live.useLiveInputStore.getState().heldKeys).toBe(2);
    expect(preview.mock.calls).toEqual([[0, 60, true]]);
    send([0x80, 60, 0]);
    expect(live.useLiveInputStore.getState().heldKeys).toBe(1);
    expect(preview.mock.calls).toEqual([[0, 60, true]]);
    send([0x81, 60, 0]);
    expect(live.useLiveInputStore.getState().heldKeys).toBe(0);
    expect(preview.mock.calls).toEqual([[0, 60, true], [0, 60, false]]);
    ui.useUiStore.setState({ playing: false });
    const notes = app.store.project.patterns[app.store.project.patternOrder[0]!]!.notes[channelId]!;
    expect(notes).toHaveLength(2);
    expect(notes.map((note) => note.velocity)).toEqual([100 / 127, 80 / 127]);
    app.store.undo();
    expect(app.store.project.patterns[app.store.project.patternOrder[0]!]!.notes[channelId] ?? []).toEqual([]);
  });

  it('el pedal de un canal no retiene la nota del otro canal', async () => {
    const { live, send, preview } = await rig();
    send([0xb0, 64, 127]);
    send([0x90, 60, 100]);
    send([0x91, 62, 100]);
    send([0x80, 60, 0]);
    send([0x81, 62, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 1, sustainedKeys: 1 });
    expect(preview.mock.calls).toContainEqual([0, 62, false]);
    send([0xb1, 64, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 1, sustainedKeys: 1 });
    send([0xb0, 64, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 0, sustainedKeys: 0 });
  });

  it.each([120, 123])('CC%d suelta solo su canal y su pedal', async (cc) => {
    const { live, send, preview } = await rig();
    send([0xb0, 64, 127]);
    send([0xb1, 64, 127]);
    send([0x90, 60, 100]);
    send([0x91, 60, 80]);
    send([0x80, 60, 0]);
    send([0x81, 60, 0]);
    send([0xb0, cc, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 1, sustainedKeys: 1 });
    expect(preview.mock.calls).toEqual([[0, 60, true]]);
    send([0xb1, 64, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 0, sustainedKeys: 0 });
    expect(preview.mock.calls).toEqual([[0, 60, true], [0, 60, false]]);
  });

  it.each(['unplug', 'disable', 'filter'] as const)('%s limpia todos los canales y pedales sin duplicar note-off', async (action) => {
    const { live, send, unplug, preview } = await rig();
    send([0xb0, 64, 127]);
    send([0xbf, 64, 127]);
    send([0x90, 60, 100]);
    send([0x9f, 60, 100]);
    send([0x80, 60, 0]);
    send([0x8f, 60, 0]);
    if (action === 'unplug') unplug();
    else if (action === 'disable') live.setMidiDeviceEnabled('dev1', false);
    else live.setMidiChannel(2);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 0, sustainedKeys: 0 });
    expect(preview.mock.calls).toEqual([[0, 60, true], [0, 60, false]]);
  });

  it('repicar bajo pedal conserva el ciclo de ataque y liberación de una sola fuente', async () => {
    const { live, send, preview } = await rig();
    send([0xb0, 64, 127]);
    send([0x90, 60, 100]);
    send([0x80, 60, 0]);
    send([0x90, 60, 100]);
    expect(preview.mock.calls).toEqual([[0, 60, true], [0, 60, false], [0, 60, true]]);
    send([0xb0, 64, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 1, sustainedKeys: 0 });
    send([0x80, 60, 0]);
    expect(preview).toHaveBeenLastCalledWith(0, 60, false);
  });

  it('un note-off sin note-on no inventa una tecla sostenida', async () => {
    const { live, send } = await rig();
    send([0xb0, 64, 127]);
    send([0x80, 60, 0]);
    expect(live.useLiveInputStore.getState()).toMatchObject({ heldKeys: 0, sustainedKeys: 0 });
  });

  it('dos dispositivos con ids que comparten prefijo no se cortan al apagar uno', async () => {
    const { live, send, inputs, stateChange, preview } = await rig();
    const other: FakeInput = { id: 'dev1:2', name: 'Otro teclado', onmidimessage: null };
    inputs.set(other.id, other);
    stateChange();
    send([0x90, 60, 100]);
    other.onmidimessage?.({ data: new Uint8Array([0x90, 60, 80]), timeStamp: 0 });
    live.setMidiDeviceEnabled('dev1', false);
    expect(live.useLiveInputStore.getState().heldKeys).toBe(1);
    expect(preview.mock.calls).toEqual([[0, 60, true]]);
    other.onmidimessage?.({ data: new Uint8Array([0x80, 60, 0]), timeStamp: 0 });
    expect(live.useLiveInputStore.getState().heldKeys).toBe(0);
    expect(preview).toHaveBeenLastCalledWith(0, 60, false);
  });
});
