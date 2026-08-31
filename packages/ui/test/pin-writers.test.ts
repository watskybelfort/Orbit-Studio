/**
 * La misma ventana sin sujetar, en los otros tres escritores de samples.
 *
 * El patrón es el del editor de audio (`audio-editor-sample-pin.test.ts`, que
 * es el arnés del que sale este): entre `engine.loadSample(idNuevo, …)` y el
 * `registerSample` del dispatch, ese id no lo nombra NADA del modelo, así que
 * `sampleKeepSet` no lo incluye y un `collectSessionSamples()` que caiga ahí le
 * dice al motor que lo suelte. El clip nace mudo y nadie lo vuelve a subir en
 * esta sesión. Y la ventana es real: dentro hay `await` que ceden el hilo de
 * verdad (`decodeAudioData`, `crypto.subtle.digest`, la lectura de disco) y el
 * Ctrl+Z de `useShortcuts` recolecta sin preguntarle a nadie.
 *
 * Los tres de aquí, con lo que cuesta cada uno cuando falla:
 *
 *  - **Consolidar / Congelar** (`state/bounce.ts`): un render que tardó
 *    segundos, con sus efectos y su automatización. Se puede repetir, pero el
 *    congelado existe justo para no repetirlo.
 *  - **Grabar la salida de una pista** (`state/track-capture.ts`): una pasada
 *    EN VIVO con las perillas que se movieron en ese momento. No se puede
 *    volver a renderizar: repetirla es volver a tocarla.
 *  - **Cargar sonidos del Explorador** (`browser/sound-actions.ts`): un grupo
 *    entero, y aquí lo grave es que son N a la vez — un piano de treinta
 *    muestras pasa treinta veces por `sha1Hex` con las treinta ya subidas.
 *
 * Cada uno con su CONTROL EN NEGATIVO: la misma operación con `pinSample`
 * neutralizado, que es lo que demuestra que la sujeción es lo único que
 * salvaba el audio.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '@orbit/engine';
import type { SoundEntry } from '@orbit/sound-library';
import { readSource } from './read-source';

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
 * `keepOnlySamples` vacía. Si el id sale de ahí, el audio se perdió.
 */
function loaded(engine: AudioEngine): Set<string> {
  return (engine as unknown as { loadedSamples: Set<string> }).loadedSamples;
}

interface RigOpts {
  /**
   * `false` neutraliza la sujeción y deja el resto del módulo intacto: es el
   * control. `collectWorkletSamples` sigue siendo el de verdad y sigue leyendo
   * el `Set` de verdad (que así nunca se llena).
   */
  sujeta?: boolean;
  /** Bytes que devuelve una lectura de disco del Explorador. */
  bytes?: () => ArrayBuffer;
}

async function rig(opts: RigOpts = {}) {
  vi.resetModules();

  if (opts.sujeta === false) {
    vi.doMock('../src/state/sample-gc', async (importOriginal) => {
      const real = await importOriginal<typeof import('../src/state/sample-gc')>();
      return {
        ...real,
        pinSample: () => undefined,
        unpinSample: () => undefined,
        // `withPinnedSample` hay que neutralizarlo APARTE aunque `pinSample` ya
        // esté anulado: dentro del módulo llama a su `pinSample` local, no al
        // export, así que sustituir el export no lo desactiva. Aquí queda como
        // lo que era el código antes del arreglo — ejecutar el bloque a pelo.
        withPinnedSample: <T,>(_id: string, run: () => Promise<T>) => run(),
      };
    });
  }

  /** Se llama justo DESPUÉS de subir cada sample al motor, con su número. */
  let trasSubir: (nth: number, id: string) => void = () => undefined;
  /** Se llama en mitad de cada lectura de disco del Explorador. */
  let enLeer: (nth: number) => void = () => undefined;

  const guardados: string[] = [];
  let leidos = 0;
  const leer = async (file: string): Promise<ArrayBuffer> => {
    const nth = ++leidos;
    // Una lectura de disco cede el hilo de verdad.
    await Promise.resolve();
    enLeer(nth);
    return (opts.bytes ?? (() => new ArrayBuffer(64)))();
  };

  vi.stubGlobal('window', {
    orbit: {
      recording: {
        save: async (name: string) => {
          await Promise.resolve();
          guardados.push(name);
          return name;
        },
        read: leer,
      },
      library: { read: leer },
      pack: { read: leer },
      folder: { read: leer },
      settings: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('navigator', {});
  // `nextPaint` espera un frame real antes del render bloqueante; sin rAF su
  // promesa reventaría y el bounce moriría antes de llegar a la ventana.
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
  // Sin `Worker` el render cae al camino directo, que es el que se puede
  // observar desde aquí (con worker, el render se iría a otro hilo).
  vi.stubGlobal('Worker', undefined);

  const core = await import('@orbit/core');
  const app = await import('../src/state/app');

  let uploads = 0;
  // `loadSample` de verdad necesita un AudioContext que en Node no existe: se
  // deja el MISMO estado que deja la de verdad (el id en `loadedSamples`), que
  // es exactamente lo que un collect borra.
  vi.spyOn(app.engine, 'loadSample').mockImplementation(async (sampleId: string) => {
    loaded(app.engine).add(sampleId);
    const nth = ++uploads;
    // El `await decodeAudioData` de la de verdad.
    await Promise.resolve();
    trasSubir(nth, sampleId);
    return { duration: 1 };
  });
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const send = spyOnSend(app.engine);

  const gc = await import('../src/state/sample-gc');
  const soundActions = await import('../src/browser/sound-actions');

  return {
    core,
    app,
    gc,
    soundActions,
    send,
    guardados,
    onUpload: (fn: (nth: number, id: string) => void) => (trasSubir = fn),
    onRead: (fn: (nth: number) => void) => (enLeer = fn),
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** Ids de sample que el motor tiene arriba y NO son los del proyecto de partida. */
function nuevosEnElMotor(r: Rig, previos: ReadonlySet<string>): string[] {
  return [...loaded(r.app.engine)].filter((id) => !previos.has(id));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../src/state/sample-gc');
  vi.resetModules();
});

// ── Consolidar a audio ──────────────────────────────────────────────────────

/** Deja un clip de patrón en la playlist y devuelve su id. */
function clipDePatron(core: typeof import('@orbit/core'), store: import('@orbit/core').ProjectStore): string {
  const trackId = Object.keys(store.project.playlistTracks)[0]!;
  const patternId = store.project.patternOrder[0]!;
  const id = core.newId();
  store.dispatch({
    type: 'addClips',
    clips: [
      { id, kind: 'pattern' as const, playlistTrackId: trackId, start: 0, length: 4, muted: false, patternId },
    ],
  });
  return id;
}

describe('un collectSessionSamples en la ventana de un consolidado', () => {
  it('con la sujeción, el consolidado sobrevive y el clip nuevo suena', async () => {
    const r = await rig();
    const bounce = await import('../src/state/bounce');
    const clipId = clipDePatron(r.core, r.app.store);
    let recolectado = false;
    // Justo después de subir el render al kernel y antes del `registerSample`:
    // el hueco del `await sha1Hex(buffer)`, por donde entra el Ctrl+Z.
    r.onUpload(() => {
      recolectado = true;
      r.soundActions.collectSessionSamples();
    });

    await bounce.bounceClip(clipId);

    expect(recolectado).toBe(true);
    const nuevos = nuevosEnElMotor(r, new Set());
    expect(nuevos).toHaveLength(1);
    const id = nuevos[0]!;
    // La recolección corrió DENTRO de la ventana y aun así pidió conservarlo.
    expect(lastKeep(r.send)).toContain(id);
    expect(r.app.store.project.samples[id]).toBeDefined();
    // El clip consolidado apunta a ese sample y el motor lo tiene.
    const audio = Object.values(r.app.store.project.clips).filter((c) => c.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]!.sampleId).toBe(id);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('SIN la sujeción el consolidado se pierde y el clip queda mudo (el control)', async () => {
    const r = await rig({ sujeta: false });
    const bounce = await import('../src/state/bounce');
    const clipId = clipDePatron(r.core, r.app.store);
    r.onUpload(() => r.soundActions.collectSessionSamples());

    await bounce.bounceClip(clipId);

    const audio = Object.values(r.app.store.project.clips).filter((c) => c.kind === 'audio');
    expect(audio).toHaveLength(1);
    const id = audio[0]!.sampleId!;
    // El modelo queda perfecto y el sonido no.
    expect(r.app.store.project.samples[id]).toBeDefined();
    expect(loaded(r.app.engine).has(id)).toBe(false);
    expect(lastKeep(r.send)).not.toContain(id);
  });

  it('si el consolidado se aborta a mitad, la sujeción se suelta igual', async () => {
    const r = await rig();
    const bounce = await import('../src/state/bounce');
    const clipId = clipDePatron(r.core, r.app.store);
    // El clip destino desaparece mientras se renderiza: `bounceClips` avisa y
    // se va por su `return`, sin dispatch. El `finally` de `withPinnedSample`
    // es lo único que impide que ese id quede protegido para siempre.
    r.onUpload(() => {
      r.app.store.dispatch({ type: 'removeClips', clipIds: [clipId] });
    });

    await bounce.bounceClip(clipId);

    expect(bounce.useBounceStore.getState().notice).toMatch(/no se consolidó/i);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });
});

// ── Grabar la salida de una pista ───────────────────────────────────────────

/** Empuja audio a la captura de pista hasta pasar el mínimo de duración. */
function empujarCaptura(capture: typeof import('../src/state/track-capture'), engineRate: number): void {
  const frames = Math.ceil((engineRate * 0.2) / 128);
  for (let i = 0; i < frames; i++) {
    capture.pushCaptureChunk(new Float32Array(128).fill(0.3), new Float32Array(128).fill(0.3));
  }
}

describe('un collectSessionSamples en la ventana de una captura de pista', () => {
  it('con la sujeción, la pasada en vivo sobrevive', async () => {
    const r = await rig();
    const capture = await import('../src/state/track-capture');
    await capture.toggleTrackCapture(1);
    expect(capture.useTrackCapture.getState().error).toBeNull();
    empujarCaptura(capture, r.app.engine.sampleRate);

    r.onUpload(() => r.soundActions.collectSessionSamples());
    await capture.stopTrackCapture();

    expect(capture.useTrackCapture.getState().error).toBeNull();
    const nuevos = nuevosEnElMotor(r, new Set());
    expect(nuevos).toHaveLength(1);
    expect(lastKeep(r.send)).toContain(nuevos[0]!);
    const audio = Object.values(r.app.store.project.clips).filter((c) => c.kind === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]!.sampleId).toBe(nuevos[0]!);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('SIN la sujeción la pasada se pierde (el control)', async () => {
    const r = await rig({ sujeta: false });
    const capture = await import('../src/state/track-capture');
    await capture.toggleTrackCapture(1);
    empujarCaptura(capture, r.app.engine.sampleRate);

    r.onUpload(() => r.soundActions.collectSessionSamples());
    await capture.stopTrackCapture();

    const audio = Object.values(r.app.store.project.clips).filter((c) => c.kind === 'audio');
    expect(audio).toHaveLength(1);
    const id = audio[0]!.sampleId!;
    expect(r.app.store.project.samples[id]).toBeDefined();
    // Y el audio de esa pasada ya no está en ningún sitio: no hay archivo que
    // volver a leer en esta sesión ni forma de re-renderizarla.
    expect(loaded(r.app.engine).has(id)).toBe(false);
  });
});

// ── Cargar sonidos del Explorador ───────────────────────────────────────────

function entrada(n: number): SoundEntry {
  return {
    id: `factory:kick-0${n}`,
    name: `Kick 0${n}`,
    category: 'drums',
    file: `drums/kick-0${n}.wav`,
    tags: [],
    durationSec: 1,
  } as SoundEntry;
}

describe('un collectSessionSamples mientras el Explorador carga un grupo', () => {
  it('con la sujeción, los TRES sonidos sobreviven aunque la recolección caiga entre ellos', async () => {
    const r = await rig();
    const trackId = Object.keys(r.app.store.project.playlistTracks)[0]!;
    const recolecciones: string[] = [];
    // El reparto es de cuatro en cuatro: cuando se lee el tercero, el primero
    // ya está subido al kernel y no lo nombra nadie.
    r.onRead((nth) => {
      if (nth === 3) {
        recolecciones.push('leyendo el 3.º');
        r.soundActions.collectSessionSamples();
      }
    });
    // Y con los tres subidos, todavía queda el `sha1Hex` de cada uno antes del
    // dispatch: la ventana no acaba cuando acaba la carga.
    r.onUpload((nth) => {
      if (nth === 3) {
        recolecciones.push('los tres subidos');
        r.soundActions.collectSessionSamples();
      }
    });

    await r.soundActions.addAudioClips([entrada(1), entrada(2), entrada(3)], trackId, 0);

    expect(recolecciones).toEqual(['leyendo el 3.º', 'los tres subidos']);
    const ids = [entrada(1).id, entrada(2).id, entrada(3).id];
    for (const id of ids) {
      expect(loaded(r.app.engine).has(id), id).toBe(true);
      expect(r.app.store.project.samples[id], id).toBeDefined();
    }
    expect(lastKeep(r.send)).toEqual(expect.arrayContaining(ids));
    const audio = Object.values(r.app.store.project.clips).filter((c) => c.kind === 'audio');
    expect(audio.map((c) => c.sampleId)).toEqual(ids);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });

  it('SIN la sujeción se los lleva a los tres y los clips quedan mudos (el control)', async () => {
    const r = await rig({ sujeta: false });
    const trackId = Object.keys(r.app.store.project.playlistTracks)[0]!;
    r.onRead((nth) => {
      if (nth === 3) r.soundActions.collectSessionSamples();
    });
    r.onUpload((nth) => {
      if (nth === 3) r.soundActions.collectSessionSamples();
    });

    await r.soundActions.addAudioClips([entrada(1), entrada(2), entrada(3)], trackId, 0);

    const ids = [entrada(1).id, entrada(2).id, entrada(3).id];
    for (const id of ids) {
      expect(loaded(r.app.engine).has(id), id).toBe(false);
      expect(r.app.store.project.samples[id], id).toBeDefined();
    }
  });

  it('la sujeción cubre TODO el grupo, no el sonido en curso', async () => {
    const r = await rig();
    const trackId = Object.keys(r.app.store.project.playlistTracks)[0]!;
    let sujetos: string[] = [];
    r.onRead((nth) => {
      if (nth === 3) sujetos = r.gc.pinnedSamples();
    });

    await r.soundActions.addAudioClips([entrada(1), entrada(2), entrada(3)], trackId, 0);

    // Los tres están sujetos desde antes de la primera lectura: los ids se
    // saben de antemano (`loadJobs`), así que una lectura que reviente a mitad
    // no deja sujeto lo que ya subió — el `finally` suelta la lista entera.
    expect(sujetos.sort()).toEqual([entrada(1).id, entrada(2).id, entrada(3).id]);
  });

  it('si una lectura revienta, no queda nada sujeto', async () => {
    const r = await rig();
    const trackId = Object.keys(r.app.store.project.playlistTracks)[0]!;
    r.onRead((nth) => {
      if (nth === 2) throw new Error('el archivo ya no está');
    });

    await expect(
      r.soundActions.addAudioClips([entrada(1), entrada(2)], trackId, 0),
    ).rejects.toThrow(/ya no está/);
    expect(r.gc.pinnedSamples()).toEqual([]);
  });
});

// ── Que los archivos de verdad lo hagan ─────────────────────────────────────

/**
 * Los bloques `withPinnedSample(...)` de un archivo, cortados por la sangría de
 * su propia línea: así se puede afirmar qué queda DENTRO del pin, que es lo
 * único que importa — sujetar y soltar antes del dispatch no arregla nada.
 * (Mismo cortador que `audio-editor-sample-pin.test.ts`.)
 */
function bloquesSujetos(src: string): string[] {
  const out: string[] = [];
  for (
    let at = src.indexOf('withPinnedSample(');
    at >= 0;
    at = src.indexOf('withPinnedSample(', at + 1)
  ) {
    const lineStart = src.lastIndexOf('\n', at) + 1;
    const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
    const close = src.indexOf(`\n${indent}});`, at);
    expect(close).toBeGreaterThan(at);
    out.push(src.slice(at, close));
  }
  return out;
}

describe('los tres archivos sujetan de verdad, y hasta después del dispatch', () => {
  for (const [rel, cuantos] of [
    ['state/bounce.ts', 1],
    ['state/track-capture.ts', 1],
  ] as const) {
    it(`${rel}: su loadSample está dentro de un bloque sujeto que se cierra tras el dispatch`, () => {
      const file = readSource(rel);
      const bloques = bloquesSujetos(file);
      expect(bloques).toHaveLength(cuantos);
      // Si mañana aparece otro `loadSample` sin sujetar, esta cuenta deja de
      // cuadrar antes de que se note como un clip mudo.
      expect(file.split('engine.loadSample(').length - 1).toBe(cuantos);
      for (const bloque of bloques) {
        expect(bloque).toContain('engine.loadSample(');
        expect(bloque).toContain("type: 'registerSample'");
        expect(bloque.indexOf('engine.loadSample(')).toBeLessThan(
          bloque.indexOf("type: 'registerSample'"),
        );
        expect(bloque).toContain('store.dispatch(');
      }
      // Un `pinSample` a mano dependería de que no haya una excepción en medio.
      expect(file).not.toMatch(/\bpinSample\(/);
    });
  }

  it('sound-actions.ts: loadAll solo se entra por withLoadedSounds, y el dispatch va dentro', () => {
    const file = readSource('browser/sound-actions.ts');
    // La única llamada a `loadAll` es la de dentro del envoltorio que sujeta:
    // una función que cargue y devuelva dejaría el agujero abierto a los dos
    // lados (el reparto de cuatro en cuatro por dentro, el `sha1Hex` de
    // `registerCommands` por fuera).
    const llamadas = file.split('loadAll(entries').length - 1;
    expect(llamadas).toBe(2); // la definición y la de `withLoadedSounds`
    expect(file).toMatch(/return await run\(await loadAll\(entries, jobs\)\);/);
    expect(file).toMatch(/\}\s*finally\s*\{\s*for \(const job of jobs\) unpinSample\(job\.id\);/);
    // Y las tres rutas que cargan sonidos pasan por él.
    expect(file.split('withLoadedSounds(entries').length - 1).toBe(3);
    for (const fn of ['addSamplerChannels', 'addKeymapZones', 'addAudioClips']) {
      const desde = file.indexOf(`export async function ${fn}(`);
      expect(desde, fn).toBeGreaterThan(0);
      const hasta = file.indexOf('\n}', desde);
      const cuerpo = file.slice(desde, hasta);
      expect(cuerpo, fn).toContain('withLoadedSounds(entries');
      // El dispatch queda DENTRO: soltar antes de registrar no arreglaría nada.
      expect(cuerpo.indexOf('withLoadedSounds(entries'), fn).toBeLessThan(
        cuerpo.indexOf('store.dispatch('),
      );
    }
  });
});
