/**
 * Grabar VARIAS entradas a la vez, de punta a punta en la UI.
 *
 * Lo que hay que demostrar es lo que no se ve en el kernel:
 *
 * - que las tomas de dos entradas armadas caen en **pistas distintas** y en
 *   **un solo paso de undo** (se grabaron juntas; deshacerlas de una en una
 *   dejaría media grabación puesta);
 * - que sin enrutado declarado todo sigue siendo **una toma, un micro**, que
 *   es lo que hace que nada de lo que ya funcionaba cambie;
 * - y que el sumidero de la **calibración de latencia** (`setRawInputSink`) y
 *   el reparto por entrada **no se pisan**: mientras la calibración está
 *   puesta, la grabación no ve un solo paquete.
 *
 * Todo con una fuente de mentira: no hay interfaz de audio en este entorno.
 * Esto prueba el CAMINO DE DATOS —quién recoge qué y dónde acaba—, no que un
 * driver entregue de verdad ocho canales.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** Un `MediaStream` de mentira que dice traer `channels` entradas. */
function fakeStream(channels: number): MediaStream {
  const track = {
    stop: () => undefined,
    getSettings: () => ({ channelCount: channels, deviceId: 'interfaz-de-mentira' }),
  };
  return {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
}

function block(value: number, length = 128): Float32Array {
  return new Float32Array(length).fill(value);
}

async function rig(channels = 8) {
  vi.resetModules();

  const savedFiles: string[] = [];
  vi.stubGlobal('window', {
    orbit: {
      recording: {
        save: (name: string) => {
          savedFiles.push(name);
          return Promise.resolve(name);
        },
      },
      settings: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  // Sin `mediaDevices`: la relectura de la lista de aparatos se rinde sola, que
  // es exactamente lo que hace sin permiso concedido.
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  // El audio de verdad no existe en Node: se sustituye lo que lo toca. Lo que
  // se prueba aquí es dónde acaba cada toma, no el arranque del motor.
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  vi.spyOn(app.engine, 'loadSample').mockResolvedValue({ duration: 1 });
  vi.spyOn(app.engine, 'connectInput').mockReturnValue({
    disconnect: () => undefined,
  } as unknown as MediaStreamAudioSourceNode);
  const setInputCapture = vi.spyOn(app.engine, 'setInputCapture');

  const monitor = await import('../src/state/input-monitor');
  monitor.setInputStreamFactory(() => Promise.resolve(fakeStream(channels)));

  const recorder = await import('../src/state/recorder');
  // Sin cuenta atrás: lo que se prueba es el reparto de las tomas, y la cuenta
  // tiene su propio banco (`count-in-v1`).
  recorder.useRecorderStore.setState({ countInBars: 0 });

  return { core, app, monitor, recorder, setInputCapture, savedFiles };
}

/** Declara N entradas mono en el proyecto, por el bus de comandos. */
function declareRoutes(
  core: typeof import('@orbit/core'),
  store: import('@orbit/core').ProjectStore,
  channels: number[],
): string[] {
  const ids: string[] = [];
  for (const channel of channels) {
    const route = core.createInputRoute(channel);
    store.dispatch({ type: 'addInputRoute', route });
    ids.push(route.id);
  }
  return ids;
}

describe('dos entradas armadas, dos tomas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cada toma cae en SU pista, y todo en un solo paso de undo', async () => {
    const { core, app, recorder, setInputCapture } = await rig(8);
    declareRoutes(core, app.store, [0, 4]);

    await recorder.toggleRecording();
    expect(recorder.useRecorderStore.getState().error).toBeNull();
    expect(recorder.useRecorderStore.getState().phase).toBe('recording');
    // Al kernel se le piden las DOS entradas, por índice.
    expect(setInputCapture).toHaveBeenCalledWith(true, [0, 1]);

    // El audio llega como en producción: la primera entrada por el camino de
    // siempre (el `inputCaptureL/R` del frame) y la segunda por el gancho.
    for (let i = 0; i < 4; i++) {
      recorder.pushInputChunk(block(0.5), block(0.5));
      app.engine.onInputCaptures?.([
        { routeIndex: 0, left: block(0.5), right: block(0.5) },
        { routeIndex: 1, left: block(0.2), right: block(0.2) },
      ]);
    }

    const versionBefore = app.store.version;
    await recorder.toggleRecording();
    expect(recorder.useRecorderStore.getState().error).toBeNull();

    const clips = Object.values(app.store.project.clips);
    expect(clips).toHaveLength(2);
    // En pistas distintas: si cayeran en la misma, la segunda taparía a la
    // primera y grabar dos micros a la vez no serviría de nada.
    const tracks = new Set(clips.map((c) => c.playlistTrackId));
    expect(tracks.size).toBe(2);
    expect(Object.keys(app.store.project.samples)).toHaveLength(2);
    // Un solo comando (un `batch`): una sola versión del store.
    expect(app.store.version).toBe(versionBefore + 1);
  });

  it('las dos tomas se deshacen juntas', async () => {
    const { core, app, recorder } = await rig(8);
    declareRoutes(core, app.store, [0, 4]);
    await recorder.toggleRecording();
    recorder.pushInputChunk(block(0.4), block(0.4));
    app.engine.onInputCaptures?.([
      { routeIndex: 0, left: block(0.4), right: block(0.4) },
      { routeIndex: 1, left: block(0.3), right: block(0.3) },
    ]);
    await recorder.toggleRecording();
    expect(Object.values(app.store.project.clips)).toHaveLength(2);
    app.store.undo();
    expect(Object.values(app.store.project.clips)).toHaveLength(0);
  });

  it('una entrada DESARMADA no graba', async () => {
    const { core, app, recorder, setInputCapture } = await rig(8);
    const ids = declareRoutes(core, app.store, [0, 4]);
    app.store.dispatch({ type: 'patchInputRoute', routeId: ids[1]!, patch: { armed: false } });

    await recorder.toggleRecording();
    expect(setInputCapture).toHaveBeenCalledWith(true, [0]);
    recorder.pushInputChunk(block(0.4), block(0.4));
    await recorder.toggleRecording();
    expect(Object.values(app.store.project.clips)).toHaveLength(1);
  });

  it('sin ninguna entrada armada lo dice, en vez de grabar silencio', async () => {
    const { core, app, recorder } = await rig(8);
    const ids = declareRoutes(core, app.store, [0]);
    app.store.dispatch({ type: 'patchInputRoute', routeId: ids[0]!, patch: { armed: false } });
    await recorder.toggleRecording();
    expect(recorder.useRecorderStore.getState().phase).toBe('idle');
    expect(recorder.useRecorderStore.getState().error).toMatch(/armada/i);
  });

  it('una entrada en un canal que el aparato no tiene no cuenta como armada', async () => {
    // El proyecto se grabó con una interfaz de ocho y hoy solo hay un micro.
    const { core, app, recorder, setInputCapture } = await rig(2);
    declareRoutes(core, app.store, [0, 6]);
    await recorder.toggleRecording();
    expect(setInputCapture).toHaveBeenCalledWith(true, [0]);
    recorder.pushInputChunk(block(0.4), block(0.4));
    await recorder.toggleRecording();
    expect(Object.values(app.store.project.clips)).toHaveLength(1);
  });
});

describe('sin enrutado declarado: una toma, un micro', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('se graba la entrada implícita y cae un solo clip', async () => {
    const { app, recorder, setInputCapture } = await rig(2);
    expect(app.store.project.inputRouteOrder).toHaveLength(0);

    await recorder.toggleRecording();
    expect(setInputCapture).toHaveBeenCalledWith(true, [0]);
    for (let i = 0; i < 3; i++) recorder.pushInputChunk(block(0.5), block(0.5));
    await recorder.toggleRecording();

    expect(recorder.useRecorderStore.getState().error).toBeNull();
    const clips = Object.values(app.store.project.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.kind).toBe('audio');
  });

  it('la toma nace en el beat donde empezó (sin latencia calibrada, tal cual)', async () => {
    const { app, recorder } = await rig(2);
    await recorder.toggleRecording();
    recorder.pushInputChunk(block(0.5), block(0.5));
    await recorder.toggleRecording();
    expect(Object.values(app.store.project.clips)[0]!.start).toBe(0);
  });
});

describe('la calibración de latencia y el reparto por entrada no se pisan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('con el sumidero puesto, la grabación no ve un solo paquete', async () => {
    const { core, app, recorder } = await rig(8);
    declareRoutes(core, app.store, [0, 4]);
    await recorder.toggleRecording();

    const capturado: number[] = [];
    recorder.setRawInputSink((left) => capturado.push(left.length));
    for (let i = 0; i < 3; i++) recorder.pushInputChunk(block(0.5), block(0.5));
    recorder.setRawInputSink(null);

    expect(capturado).toEqual([128, 128, 128]);
    // Nada llegó a la toma: al cerrar, la primera entrada salió vacía y solo
    // queda la que sí recibió audio por el gancho.
    app.engine.onInputCaptures?.([{ routeIndex: 1, left: block(0.3), right: block(0.3) }]);
    await recorder.toggleRecording();
    expect(Object.values(app.store.project.clips)).toHaveLength(1);
  });

  it('sin grabar ni sumidero, un paquete suelto no revienta nada', async () => {
    const { recorder } = await rig(2);
    expect(() => recorder.pushInputChunk(block(0.2), block(0.2))).not.toThrow();
  });
});
