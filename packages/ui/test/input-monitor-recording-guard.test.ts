/**
 * La guarda de "no tocar el micro ni el dispositivo con una toma en curso"
 * (ver el bloque grande al principio de `state/input-monitor.ts`, sección
 * "Guarda: no tocar el micro ni el dispositivo con una toma en curso") vivía
 * solo en `InputSection.tsx` (v3.6): bloqueaba el botón y el select, pero
 * `toggleInputListening`/`setInputDevice` seguían aceptando la llamada de
 * cualquier OTRO camino —un atajo de teclado, la paleta de comandos, una
 * acción de MCP— y truncaban la toma en silencio igual.
 *
 * Este archivo prueba la regla donde ahora vive de verdad: en las funciones.
 * No monta ningún componente (el repo no usa jsdom, ver CLAUDE.md); llama
 * directo a `toggleInputListening`/`setInputDevice` con un `MediaStream` de
 * mentira (mismo patrón de `vi.stubGlobal` que `live-input-bend.test.ts` y
 * `run-export.test.ts`) y comprueba que, con una toma en curso, el stream NO
 * se toca — ni se llama a `track.stop()` ni cambia `listening`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Mismo `rig()` —y el mismo costo— que `input-monitor-hot-unplug.test.ts`:
 * ver el comentario de allá para el porqué del `vi.resetModules()` por test y
 * de los 60 s (medido: primer `import()` de `../src/state/app` en varios
 * segundos bajo carga real de agentes en paralelo, hasta 34 s con carga
 * sintética severa; en reposo este archivo corre en ~200 ms por test).
 */
vi.setConfig({ testTimeout: 60_000 });

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
  getSettings: () => { deviceId: string; channelCount: number };
}

function makeTrack(deviceId = 'mic-1'): FakeTrack {
  return {
    stop: vi.fn(),
    onended: null,
    getSettings: () => ({ deviceId, channelCount: 2 }),
  };
}

function makeStream(track: FakeTrack): MediaStream {
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

/**
 * Un `input-monitor` recién nacido con el micro ya ABIERTO (mock de
 * `getUserMedia`/`connectInput`, sin AudioContext real — no existe en Node).
 * `vi.resetModules()` hace falta porque `input-monitor.ts` guarda el stream
 * en una variable de módulo: sin reset, el segundo test heredaría el micro
 * "abierto" del primero.
 */
async function rig() {
  vi.resetModules();

  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: vi.fn().mockResolvedValue([]),
      ondevicechange: null as unknown,
    },
  });

  const { engine } = await import('../src/state/app');
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);
  // `connectInput` de verdad exige un AudioContext ya arrancado (ver
  // `engine.ts`): en Node no hay, así que se sustituye por un nodo de
  // mentira — lo que se prueba aquí es la guarda, no el grafo de audio.
  vi.spyOn(engine, 'connectInput').mockReturnValue({
    disconnect: vi.fn(),
  } as unknown as MediaStreamAudioSourceNode);

  const recorder = await import('../src/state/recorder');
  const inputMonitor = await import('../src/state/input-monitor');

  const track = makeTrack();
  inputMonitor.setInputStreamFactory(async () => makeStream(track));

  return { recorder, inputMonitor, track };
}

describe('input-monitor: la guarda de "toma en curso" vive en la función', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sin toma en curso, toggleInputListening cierra el micro normalmente', async () => {
    const { inputMonitor, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(true);

    const ok = await inputMonitor.toggleInputListening();

    expect(ok).toBe(true);
    expect(track.stop).toHaveBeenCalled();
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(false);
  });

  it('con una toma en curso, toggleInputListening rechaza con false y NO toca el stream', async () => {
    const { inputMonitor, recorder, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    recorder.useRecorderStore.setState({ phase: 'recording' });

    const ok = await inputMonitor.toggleInputListening();

    expect(ok).toBe(false);
    // El stream sigue vivo de verdad: ni se llamó a stop() ni se puso
    // `listening` en falso — esto es justo lo que la guarda en el componente
    // NO podía garantizar (solo bloqueaba el botón, no la función).
    expect(track.stop).not.toHaveBeenCalled();
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(true);
    expect(inputMonitor.useInputMonitorStore.getState().error).toMatch(/toma en curso/i);
  });

  it('durante la cuenta atrás (countin) también rechaza: la fase relevante es "no idle", no solo "recording"', async () => {
    const { inputMonitor, recorder, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    recorder.useRecorderStore.setState({ phase: 'countin' });

    const ok = await inputMonitor.toggleInputListening();

    expect(ok).toBe(false);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('con una toma en curso, setInputDevice rechaza con false y NO reabre el stream con otro dispositivo', async () => {
    const { inputMonitor, recorder, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);
    const before = inputMonitor.useInputMonitorStore.getState().deviceId;

    recorder.useRecorderStore.setState({ phase: 'saving' });

    const ok = await inputMonitor.setInputDevice('otro-dispositivo');

    expect(ok).toBe(false);
    expect(track.stop).not.toHaveBeenCalled();
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(true);
    // Rechazar de verdad, no solo simularlo: el dispositivo elegido no cambia.
    expect(inputMonitor.useInputMonitorStore.getState().deviceId).toBe(before);
  });

  it('setInputDevice bloquea por FASE, no por si el micro está abierto (caso de borde que en la app real no ocurre)', async () => {
    // Documentado en `setInputDevice`: mientras se graba, `listening` es
    // siempre `true` (lo abre `startRecording` antes de que la fase deje
    // `idle`), así que "toma en curso con el micro cerrado" no pasa en la app
    // real. Pero la guarda no confía en esa coincidencia: mira la fase, no el
    // stream, que es la versión simple y segura de razonar (y la que se
    // prueba aquí, con el micro sin abrir ni una vez).
    const { inputMonitor, recorder } = await rig();
    recorder.useRecorderStore.setState({ phase: 'recording' });

    const ok = await inputMonitor.setInputDevice('otro-dispositivo');

    expect(ok).toBe(false);
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(false);
  });

  it('inputGuardReason() es la única fuente: null en idle, un motivo con "toma en curso" en cualquier otra fase', async () => {
    const { inputMonitor, recorder } = await rig();
    expect(inputMonitor.inputGuardReason()).toBeNull();

    for (const phase of ['countin', 'recording', 'saving'] as const) {
      recorder.useRecorderStore.setState({ phase });
      expect(inputMonitor.inputGuardReason()).toMatch(/toma en curso/i);
    }

    recorder.useRecorderStore.setState({ phase: 'idle' });
    expect(inputMonitor.inputGuardReason()).toBeNull();
  });

  it('el rechazo es con `false`, no con una excepción — mismo patrón que startInputMonitor', async () => {
    const { inputMonitor, recorder } = await rig();
    recorder.useRecorderStore.setState({ phase: 'recording' });

    await expect(inputMonitor.toggleInputListening()).resolves.toBe(false);
    await expect(inputMonitor.setInputDevice('otro')).resolves.toBe(false);
  });
});
