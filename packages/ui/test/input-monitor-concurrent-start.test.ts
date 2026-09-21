/**
 * Abrir el micro dos veces a la vez: `Promise.all([startInputMonitor(),
 * startInputMonitor()])` — dos efectos de React montando el mismo panel, un
 * atajo que se cuela mientras el primero sigue pidiendo permiso, etc.
 *
 * La guarda de `if (stream) return true` no alcanza: `stream` solo se asigna
 * DESPUÉS de que `getUserMedia` resuelve, así que las dos llamadas entran.
 * El precio no es teórico: dos `getUserMedia` sobre el mismo aparato, los
 * tracks del primero sin parar nadie, y el kernel con dos fuentes de la misma
 * entrada conectadas (nivel duplicado).
 *
 * La salida es la misma que ya usa `recorder.ts` para su `starting`: una
 * promesa de arranque EN VUELO que la segunda llamada espera.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
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

interface Rig {
  mod: typeof import('../src/state/input-monitor');
  opened: () => number;
  tracks: FakeTrack[];
  connectInput: ReturnType<typeof vi.spyOn>;
}

async function rig(): Promise<Rig> {
  vi.resetModules();
  const mediaDevices = {
    enumerateDevices: vi.fn().mockResolvedValue([]),
    ondevicechange: null,
  };
  vi.stubGlobal('navigator', { mediaDevices });

  const { engine } = await import('../src/state/app');
  vi.spyOn(engine, 'init').mockResolvedValue(undefined);
  const connectInput = vi
    .spyOn(engine, 'connectInput')
    .mockReturnValue({ disconnect: vi.fn() } as unknown as MediaStreamAudioSourceNode);

  const mod = await import('../src/state/input-monitor');
  const tracks: FakeTrack[] = [];
  let opened = 0;
  mod.setInputStreamFactory(async () => {
    opened++;
    const track = makeTrack();
    tracks.push(track);
    return makeStream(track);
  });
  return { mod, opened: () => opened, tracks, connectInput };
}

describe('input-monitor: dos arranques a la vez comparten una sola apertura', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('Promise.all de dos startInputMonitor: un único getUserMedia y una única conexión', async () => {
    const { mod, opened, tracks, connectInput } = await rig();

    const [a, b] = await Promise.all([mod.startInputMonitor(), mod.startInputMonitor()]);

    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(opened()).toBe(1);
    expect(connectInput).toHaveBeenCalledTimes(1);
    // El stream del primero no se quedó huérfano: nadie lo paró por dentro.
    expect(tracks[0]!.stop).not.toHaveBeenCalled();
    expect(mod.useInputMonitorStore.getState().listening).toBe(true);
  });

  it('tras cerrar el micro, un arranque nuevo sí abre otro stream (la guarda no se queda pegada)', async () => {
    const { mod, opened } = await rig();
    expect(await mod.startInputMonitor()).toBe(true);
    mod.stopInputMonitor();
    expect(await mod.startInputMonitor()).toBe(true);
    expect(opened()).toBe(2);
  });
});
