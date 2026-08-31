/**
 * La ventana sin sujetar del GRABADOR, que es la peor de las cinco.
 *
 * `stopRecording` recorre TODAS las tomas de la vuelta, sube cada una al motor
 * con `engine.loadSample(id, wav)` y **acumula** sus comandos: no despacha
 * hasta el final. Entre el `loadSample` de la primera toma y ese dispatch no
 * hay nada que nombre su id —ni el proyecto, ni un clip, ni un canal—, así que
 * `sampleKeepSet` no la incluye y un `collectSessionSamples()` que caiga ahí le
 * dice al motor que la suelte.
 *
 * Y la ventana no es un tick: por cada toma que queda hay un `recording.save`
 * (escribir varios megas de WAV al disco) y un `sha1Hex` de ese mismo WAV. Con
 * dos micros armados son cientos de milisegundos, y lo que hay dentro es audio
 * RECIÉN CANTADO por el usuario: es el único de los cinco huecos de esta ronda
 * donde lo que se pierde no se puede volver a generar.
 *
 * Por eso este test cubre **dos tomas** y no una: sujetar solo la que se está
 * guardando dejaría a la primera exactamente igual de desprotegida. Lo que se
 * afirma es el ALCANCE de la sujeción —todas, hasta el dispatch final—, que es
 * la decisión que tenía este caso y que el del editor no tenía.
 *
 * Se prueba con el grabador, el store y el motor REALES (el arnés es el de
 * `input-routes-record.test.ts`), y con el control en negativo obligatorio: la
 * misma grabación con `pinSample` neutralizado se lleva el audio por delante.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '@orbit/engine';
import { readSource } from './read-source';

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

/** Extraído a función aparte para que TS infiera la sobrecarga de método. */
function spyOnSend(engine: AudioEngine) {
  return vi.spyOn(engine, 'send');
}
type SendSpy = ReturnType<typeof spyOnSend>;

/** El último `keep` que se le mandó al motor vía `collectSamples`. */
function lastKeep(send: SendSpy): readonly string[] {
  const calls = send.mock.calls.filter(([msg]) => msg.type === 'collectSamples');
  const last = calls.at(-1)?.[0];
  return last && last.type === 'collectSamples' ? last.keep : [];
}

/**
 * El `loadedSamples` del motor real: la caché de "esto ya está arriba" que
 * `keepOnlySamples` vacía. Si el id sale de ahí, el audio se perdió — el
 * próximo `loadSample` de ese id tendría que volver a subirlo, y en esta sesión
 * ya no lo llama nadie.
 */
function loaded(engine: AudioEngine): Set<string> {
  return (engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
}

interface RigOpts {
  /**
   * `false` neutraliza `pinSample`/`unpinSample` dejando el resto del módulo
   * intacto: es el CONTROL. Mismo código del grabador, misma recolección de
   * verdad, sin lo único que protegía las tomas.
   */
  sujeta?: boolean;
  /** Entradas físicas del aparato de mentira. */
  channels?: number;
}

async function rig(opts: RigOpts = {}) {
  vi.resetModules();

  if (opts.sujeta === false) {
    vi.doMock('../src/state/sample-gc', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/state/sample-gc')>();
      // Solo la sujeción: `collectWorkletSamples` sigue siendo el de verdad y
      // sigue leyendo el `Set` de verdad (que aquí nunca se llena).
      return { ...real, pinSample: () => undefined, unpinSample: () => undefined };
    });
  }

  /** Se llama en mitad de cada `recording.save`, con el número de toma (1, 2…). */
  let enSave: (nth: number) => void = () => undefined;
  /** Se llama justo DESPUÉS de subir cada toma al motor. */
  let trasSubir: (nth: number) => void = () => undefined;

  let saves = 0;
  vi.stubGlobal('window', {
    orbit: {
      recording: {
        save: async (name: string) => {
          const nth = ++saves;
          // El await de verdad: escribir el WAV cede el hilo, y es por donde
          // entra el Ctrl+Z de `useShortcuts`.
          await Promise.resolve();
          enSave(nth);
          return name;
        },
      },
      settings: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  const app = await import('../src/state/app');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  vi.spyOn(app.engine, 'connectInput').mockReturnValue({
    disconnect: () => undefined,
  } as unknown as MediaStreamAudioSourceNode);
  vi.spyOn(app.engine, 'setInputCapture');

  // `loadSample` de verdad necesita un AudioContext que en Node no existe, así
  // que se deja el MISMO estado que deja la de verdad —el id en
  // `loadedSamples`— porque es exactamente lo que un collect borra. Lo que se
  // prueba es la sujeción, no el decodificador.
  let uploads = 0;
  vi.spyOn(app.engine, 'loadSample').mockImplementation(async (sampleId: string) => {
    loaded(app.engine).add(sampleId);
    const nth = ++uploads;
    // El `await decodeAudioData` de la de verdad.
    await Promise.resolve();
    trasSubir(nth);
    return { duration: 1 };
  });

  const send = spyOnSend(app.engine);

  const monitor = await import('../src/state/input-monitor');
  monitor.setInputStreamFactory(() => Promise.resolve(fakeStream(opts.channels ?? 8)));

  const soundActions = await import('../src/browser/sound-actions');
  const gc = await import('../src/state/sample-gc');
  const recorder = await import('../src/state/recorder');
  // Sin cuenta atrás: lo que se prueba es la sujeción de las tomas.
  recorder.useRecorderStore.setState({ countInBars: 0 });

  return {
    core,
    app,
    gc,
    recorder,
    soundActions,
    send,
    onSave: (fn: (nth: number) => void) => (enSave = fn),
    onUpload: (fn: (nth: number) => void) => (trasSubir = fn),
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Declara N entradas mono armadas, por el bus de comandos. */
function declareRoutes(
  core: typeof import('@orbit/core'),
  store: import('@orbit/core').ProjectStore,
  channels: number[],
): void {
  for (const channel of channels) store.dispatch({ type: 'addInputRoute', route: core.createInputRoute(channel) });
}

/** Graba una vuelta de dos tomas (dos micros armados) y la cierra. */
async function grabarDosTomas(r: Rig): Promise<void> {
  declareRoutes(r.core, r.app.store, [0, 4]);
  await r.recorder.toggleRecording();
  expect(r.recorder.useRecorderStore.getState().phase).toBe('recording');
  for (let i = 0; i < 4; i++) {
    r.recorder.pushInputChunk(block(0.5), block(0.5));
    r.app.engine.onInputCaptures?.([
      { routeIndex: 0, left: block(0.5), right: block(0.5) },
      { routeIndex: 1, left: block(0.2), right: block(0.2) },
    ]);
  }
  await r.recorder.toggleRecording();
}

/** Los sampleIds que acabaron en el proyecto, en orden de clip. */
function idsDeLasTomas(store: import('@orbit/core').ProjectStore): string[] {
  return Object.values(store.project.clips)
    .filter((c) => c.kind === 'audio')
    .map((c) => c.sampleId!)
    .filter((id): id is string => Boolean(id));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/state/sample-gc');
  vi.resetModules();
});

describe('un collectSessionSamples en mitad de la vuelta de grabación', () => {
  it('con la sujeción, las DOS tomas sobreviven aunque la recolección caiga entre ellas', async () => {
    const r = await rig();
    const recolecciones: number[] = [];
    // El peor instante posible: la toma 1 ya está subida al motor y NO está
    // registrada (el dispatch es uno solo, al final), y la toma 2 se está
    // escribiendo a disco. Es donde cae el Ctrl+Z de quien acaba de cantar.
    r.onSave((nth) => {
      if (nth === 2) {
        recolecciones.push(nth);
        r.soundActions.collectSessionSamples();
      }
    });
    // Y otra con las DOS subidas y ninguna registrada todavía (el hueco del
    // `sha1Hex` de la última toma).
    r.onUpload((nth) => {
      if (nth === 2) {
        recolecciones.push(20 + nth);
        r.soundActions.collectSessionSamples();
      }
    });

    await grabarDosTomas(r);

    expect(recolecciones).toEqual([2, 22]);
    expect(r.recorder.useRecorderStore.getState().error).toBeNull();

    const ids = idsDeLasTomas(r.app.store);
    expect(ids).toHaveLength(2);
    // Lo que ve el usuario: dos clips con su audio, y el motor lo tiene.
    for (const id of ids) {
      expect(loaded(r.app.engine).has(id)).toBe(true);
      expect(r.app.store.project.samples[id]).toBeDefined();
    }
    // La recolección corrió DENTRO de la ventana y aun así pidió conservar las
    // dos: el pin era lo único que las nombraba en ese instante.
    expect(lastKeep(r.send)).toEqual(expect.arrayContaining(ids));
    // La baja se hizo sola.
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('SIN la sujeción se lleva las dos y los clips quedan mudos (el control)', async () => {
    const r = await rig({ sujeta: false });
    r.onSave((nth) => {
      if (nth === 2) r.soundActions.collectSessionSamples();
    });
    r.onUpload((nth) => {
      if (nth === 2) r.soundActions.collectSessionSamples();
    });

    await grabarDosTomas(r);

    const ids = idsDeLasTomas(r.app.store);
    expect(ids).toHaveLength(2);
    // Esto es el bug, y es doble: la toma 1 se cae en la recolección de dentro
    // del `save` de la 2 (llevaba ahí desde el principio del bucle) y las dos
    // se caen en la de después de subir la 2.
    for (const id of ids) {
      expect(loaded(r.app.engine).has(id)).toBe(false);
      // El modelo queda perfecto y el sonido no: los clips apuntan a samples
      // que el motor ya no tiene, y nadie los vuelve a subir en esta sesión.
      expect(r.app.store.project.samples[id]).toBeDefined();
    }
    expect(lastKeep(r.send)).not.toEqual(expect.arrayContaining(ids));
  });

  it('sujetar la toma en curso NO habría bastado: la anterior es la que más tiempo lleva sin nadie', async () => {
    const r = await rig();
    let sujetasEnLaVentana: string[] = [];
    // En mitad del guardado de la SEGUNDA toma, ¿quién protege a la primera?
    r.onSave((nth) => {
      if (nth === 2) sujetasEnLaVentana = r.gc.pinnedSamples();
    });

    await grabarDosTomas(r);

    // La toma 1 está sujeta mientras se guarda la 2. Si el alcance fuera "la
    // toma en curso", aquí habría 0 (o el id de la 2, que ni siquiera se ha
    // subido todavía) y este número sería la prueba de que el arreglo tapó un
    // archivo y no la clase.
    expect(sujetasEnLaVentana).toHaveLength(1);
    expect(sujetasEnLaVentana[0]).toBe(idsDeLasTomas(r.app.store)[0]);
  });

  it('si el guardado revienta con una toma ya subida, la sujeción se suelta igual', async () => {
    const r = await rig();
    r.onSave((nth) => {
      if (nth === 2) throw new Error('se llenó el disco');
    });

    await grabarDosTomas(r);

    // El grabador reporta el fallo…
    expect(r.recorder.useRecorderStore.getState().error).toBe('se llenó el disco');
    expect(r.recorder.useRecorderStore.getState().phase).toBe('idle');
    // …y no deja NADA sujeto: sin el `finally`, la toma 1 (ya subida al motor
    // cuando reventó la 2) se quedaría protegida para siempre, que es la misma
    // fuga del otro lado.
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('sin nadie recolectando, sujetar no cambia el flujo normal', async () => {
    const r = await rig();
    await grabarDosTomas(r);

    expect(r.recorder.useRecorderStore.getState().error).toBeNull();
    const ids = idsDeLasTomas(r.app.store);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(loaded(r.app.engine).has(id)).toBe(true);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });
});

// ── El alcance elegido, escrito como aserción ───────────────────────────────

/**
 * La decisión de esta tarjeta: se sostienen TODAS las tomas hasta el dispatch
 * final en vez de reordenar para despachar por toma.
 *
 * Despachar por toma acortaría cada sujeción pero no la quitaría —la toma en
 * curso seguiría teniendo su ventana entre subir y registrar—, así que no
 * ahorra el pin: solo lo cobra en otro sitio. Y lo que cobra sí importa: una
 * vuelta de grabación es UN paso de undo a propósito (dos micros se grabaron
 * juntos y deshacerlos de uno en uno deja media grabación puesta), `placeTake`
 * decide contra el proyecto leído ANTES del bucle y vería el clip de la toma 1
 * como una toma anterior a la que mutear, y el `batch` de core dejaría de ser
 * todo-o-nada. Esto último es lo que fija el número.
 */
describe('una vuelta de grabación sigue siendo UN paso de undo', () => {
  it('dos tomas, un solo dispatch', async () => {
    const r = await rig();
    declareRoutes(r.core, r.app.store, [0, 4]);
    await r.recorder.toggleRecording();
    r.recorder.pushInputChunk(block(0.4), block(0.4));
    r.app.engine.onInputCaptures?.([
      { routeIndex: 0, left: block(0.4), right: block(0.4) },
      { routeIndex: 1, left: block(0.3), right: block(0.3) },
    ]);
    const antes = r.app.store.version;
    await r.recorder.toggleRecording();

    expect(idsDeLasTomas(r.app.store)).toHaveLength(2);
    // Un solo comando: si alguien reordena a "un dispatch por toma", aquí se
    // ve el cambio de historial antes de que lo descubra el usuario con un
    // Ctrl+Z que deshace media grabación.
    expect(r.app.store.version).toBe(antes + 1);
    r.app.store.undo();
    expect(idsDeLasTomas(r.app.store)).toHaveLength(0);
  });
});

// ── Que el archivo de verdad lo haga, y no solo el arnés ────────────────────

describe('recorder.ts sujeta de verdad, y hasta después del dispatch', () => {
  const file = readSource('state/recorder.ts');

  it('el pin va ANTES del loadSample de cada toma', () => {
    expect(file.indexOf('pinSample(sampleId)')).toBeGreaterThan(0);
    expect(file.indexOf('pinSample(sampleId)')).toBeLessThan(file.indexOf('engine.loadSample('));
    // Un solo `loadSample` en el archivo: si mañana aparece otro, esta cuenta
    // deja de cuadrar antes de que se note como un clip mudo.
    expect(file.split('engine.loadSample(').length - 1).toBe(1);
  });

  it('la baja es estructural (un finally) y llega DESPUÉS del dispatch', () => {
    // Aquí no vale `withPinnedSample`: son N ids que se descubren dentro del
    // bucle y tienen que seguir sujetos cuando el bucle acaba. Lo que no puede
    // faltar es la garantía, que es el `finally`.
    expect(file).toMatch(/\}\s*finally\s*\{\s*(\/\/[^\n]*\n\s*)*for \(const id of pinnedTakes\) unpinSample\(id\);/);
    // Y el dispatch está DENTRO del try, o sea antes de soltar: sujetar y
    // soltar antes de registrar no arreglaría nada.
    const dispatch = file.indexOf("store.dispatch({ type: 'batch', label, commands }");
    expect(dispatch).toBeGreaterThan(0);
    expect(dispatch).toBeLessThan(file.indexOf('for (const id of pinnedTakes) unpinSample(id)'));
  });
});
