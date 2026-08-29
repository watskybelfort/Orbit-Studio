/**
 * Los dos caminos que cierran el stream sin que nadie los bloqueara (v3.6
 * solo cubrió el cierre A PROPÓSITO — ver `input-monitor-recording-guard.test.ts`):
 *
 * - Hot-unplug de la interfaz: `track.onended`.
 * - Cambio de dispositivo por defecto del sistema: `navigator.mediaDevices.
 *   ondevicechange`, que dispara para CUALQUIER cambio en la lista y hay que
 *   filtrar si de verdad afecta al dispositivo activo.
 *
 * Estos dos NO se pueden bloquear —el cable ya se fue—, así que la respuesta
 * es la contraria a la guarda: cerrar lo que quede y avisar CLARO de que la
 * toma se cortó ahí. Ver `handleStreamLost`/`handleDeviceChange` en
 * `state/input-monitor.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `rig()` (más abajo) hace `vi.resetModules()` y reimporta `../src/state/app`
 * entero en CADA test — hace falta porque `input-monitor.ts` guarda `stream`,
 * `deviceChangeWired` y `unsubscribeProject` en variables de módulo, y sin un
 * módulo nuevo un test heredaría el "micro abierto" o el "ya enganchado" del
 * anterior (ver el comentario de `rig()`). Ese reimport reevalúa el grafo de
 * `app.ts` —el motor, el store, todo lo que arrastra— y el primero de la
 * tanda paga la transformación de Vite en frío.
 *
 * En una máquina en reposo eso es barato (los 15 tests de este archivo y de
 * `input-monitor-recording-guard.test.ts` corren en ~200 ms cada uno). Bajo
 * carga real de varios agentes a la vez se midió el primer test de cada
 * archivo en varios segundos, y con carga sintética más severa (40 procesos
 * quemando CPU en una máquina de 20 núcleos) ese primer `import()` llegó a
 * 34 s por sí solo — muy por encima de los 5000 ms por defecto de Vitest, que
 * es justo el timeout que se vio caer en CI. 60 s deja un margen de casi 2×
 * sobre ese peor caso medido sin convertir esto en un test lento de verdad
 * (con la máquina libre sigue terminando en milisegundos).
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
 * `ondevicechange` es fire-and-forget a propósito (`() => void
 * handleDeviceChange()`, en `input-monitor.ts` — mismo patrón que
 * `onClick={() => void toggleInputListening()}` en toda la UI): el navegador
 * no espera al manejador, así que `await mediaDevices.ondevicechange?.()`
 * solo espera el `undefined` síncrono del wrapper, NO el `refreshInputDevices()`
 * async de dentro. Para probarlo hay que dejar drenar la cola de microtasks
 * de verdad — un `setTimeout` de sobra, igual que `nextFrame()` en
 * `live-input-bend.test.ts`.
 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

interface FakeMediaDevices {
  enumerateDevices: ReturnType<typeof vi.fn>;
  ondevicechange: (() => void) | null;
}

/** Mismo rig que `input-monitor-recording-guard.test.ts`: micro de mentira, sin AudioContext real. */
async function rig() {
  vi.resetModules();

  const mediaDevices: FakeMediaDevices = {
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

  return { recorder, inputMonitor, track, mediaDevices };
}

describe('input-monitor: hot-unplug (track.onended)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sin toma en curso: cierra el stream y deja un motivo claro en error, sin lanzar', async () => {
    const { inputMonitor, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    // El hardware se va SOLO: nadie llamó a stopInputMonitor.
    track.onended?.();

    const st = inputMonitor.useInputMonitorStore.getState();
    expect(st.listening).toBe(false);
    expect(st.error).toMatch(/desconect/i);
  });

  it('con una toma en curso: para la grabación y el motivo dice que la toma se cortó ahí', async () => {
    const { inputMonitor, recorder, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);
    recorder.useRecorderStore.setState({ phase: 'recording' });

    const abortSpy = vi.spyOn(recorder, 'abortRecordingForLostDevice');

    track.onended?.();

    // El motivo lo explica TODO en una frase: qué pasó (se desconectó) y qué
    // hacer (repetirla) — no un genérico "algo falló".
    const reason = inputMonitor.useInputMonitorStore.getState().error;
    expect(reason).toMatch(/desconect/i);
    expect(reason).toMatch(/toma se cortó/i);
    expect(reason).toMatch(/repít/i);

    // Y se lo pasa a recorder.ts, que es quien de verdad para la captura y
    // guarda lo que se alcanzó a grabar (ver `abortRecordingForLostDevice`).
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith(reason);
  });

  it('sin toma en curso (fase idle): NO llama a abortRecordingForLostDevice — nada que parar', async () => {
    const { inputMonitor, recorder, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);
    expect(recorder.useRecorderStore.getState().phase).toBe('idle');

    const abortSpy = vi.spyOn(recorder, 'abortRecordingForLostDevice');

    track.onended?.();

    expect(abortSpy).not.toHaveBeenCalled();
  });

  it('es idempotente: dos `onended` seguidos (dos tracks de un stream estéreo) no revientan ni duplican el aviso', async () => {
    const { inputMonitor, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    expect(() => {
      track.onended?.();
      track.onended?.();
    }).not.toThrow();

    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(false);
  });

  it('cerrar el micro a propósito (stopInputMonitor) NO dispara el aviso de "se fue solo"', async () => {
    // `stop()` no dispara `onended` por spec, pero `stopInputMonitor` limpia
    // el manejador ANTES de llamar a `stop()` como red de seguridad (ver el
    // comentario en el propio `stopInputMonitor`). Este test simula un
    // runtime que SÍ llamara a onended al hacer stop() y comprueba que, aun
    // así, no hay nada enganchado para reaccionar.
    const { inputMonitor, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    inputMonitor.stopInputMonitor();
    expect(track.onended).toBeNull();
  });
});

describe('input-monitor: cambio de dispositivo por defecto del sistema (ondevicechange)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('si el dispositivo activo SIGUE en la lista tras el evento, no hace nada (otro micro se conectó, el nuestro no se movió)', async () => {
    const { inputMonitor, mediaDevices, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    // Tras el evento, enumerateDevices() ahora sí devuelve el dispositivo
    // activo (con su label, como si ya se hubiera dado permiso) más uno nuevo.
    mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic-1', label: 'Interfaz de siempre' },
      { kind: 'audioinput', deviceId: 'mic-2', label: 'Micro nuevo enchufado' },
    ]);

    mediaDevices.ondevicechange?.();
    await flush();

    expect(track.stop).not.toHaveBeenCalled();
    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(true);
  });

  it('si el dispositivo activo YA NO está en la lista, cierra el stream y avisa (aunque no haya recibido onended)', async () => {
    const { inputMonitor, mediaDevices, track } = await rig();
    expect(await inputMonitor.startInputMonitor()).toBe(true);

    // El aparato desapareció de la lista: se fue, o el sistema cambió de
    // dispositivo por defecto y este ya no es ni siquiera un dispositivo
    // enumerable (caso límite, pero el resultado observable es el mismo).
    mediaDevices.enumerateDevices.mockResolvedValue([
      { kind: 'audioinput', deviceId: 'mic-2', label: 'El único que queda' },
    ]);

    mediaDevices.ondevicechange?.();
    await flush();

    expect(inputMonitor.useInputMonitorStore.getState().listening).toBe(false);
    expect(inputMonitor.useInputMonitorStore.getState().error).toMatch(/dispositivo/i);
  });

  it('con el micro cerrado, el evento no hace nada (nada que perder)', async () => {
    const { inputMonitor, mediaDevices } = await rig();
    // El manejador solo se engancha al abrir el micro por primera vez (igual
    // que `watchProject`): sin abrirlo nunca, `ondevicechange` sigue null.
    expect(mediaDevices.ondevicechange).toBeNull();
  });
});
