/**
 * Hot-unplug del micro DURANTE la cuenta atrás.
 *
 * El camino de `recording` ya estaba cubierto (`input-monitor-hot-unplug.test.ts`):
 * si el cable se va con una toma en curso, se guarda lo capturado y se avisa.
 * Pero la cuenta atrás se quedó fuera de la condición (`phase === 'recording'`
 * a secas), y durante la cuenta el micro YA está abierto y la toma está a
 * punto de entrar: sin stream, la captura arranca vacía y sale un clip mudo
 * sin que nadie diga por qué. La cuenta tiene que cancelarse y el aviso tiene
 * que llegar igual que en una toma en curso.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

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

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

async function rig() {
  vi.resetModules();
  const mediaDevices = {
    enumerateDevices: vi.fn().mockResolvedValue([]),
    ondevicechange: null,
  };
  vi.stubGlobal('navigator', { mediaDevices });

  const { engine } = await import('../src/state/app');
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);
  vi.spyOn(engine, 'connectInput').mockReturnValue({
    disconnect: vi.fn(),
  } as unknown as MediaStreamAudioSourceNode);

  const recorder = await import('../src/state/recorder');
  const inputMonitor = await import('../src/state/input-monitor');
  const track = makeTrack();
  inputMonitor.setInputStreamFactory(async () => makeStream(track));

  return { recorder, inputMonitor, track };
}

describe('input-monitor: hot-unplug durante la cuenta atrás', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cancela la cuenta, para la toma y deja el aviso de que se cortó', async () => {
    const { recorder, inputMonitor, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);
    recorder.useRecorderStore.setState({ phase: 'countin', countdown: 4 });

    track.onended?.();
    await flush();

    // El micro se cerró y la fase no puede quedarse en 'countin' esperando a
    // un stream que ya no existe: la próxima parada sería una toma vacía.
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(false);
    const st = recorder.useRecorderStore.getState();
    expect(st.phase).toBe('idle');
    expect(st.error).toMatch(/toma se cortó/i);
  });

  it('con la grabación ya capturando, el camino de siempre sigue igual', async () => {
    const { recorder, inputMonitor, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);
    recorder.useRecorderStore.setState({ phase: 'recording' });
    const abortSpy = vi.spyOn(recorder, 'abortRecordingForLostDevice');

    track.onended?.();
    await flush();

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });
});
