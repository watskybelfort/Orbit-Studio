/**
 * `run-export.ts` es de solo lectura para este test: se prueba desde fuera,
 * llamando a `runExport` de verdad con un `window.orbit` de mentira que se
 * limita a anotar qué se escribió.
 *
 * El comentario del propio archivo lo dice: "es donde un error sale como
 * archivo mal escrito y no como excepción". Eso es justo lo que hace falta
 * cubrir — no que el render suene bien (para eso están los golden del
 * engine), sino que:
 *
 * - un formato que falla al escribir se convierte en un AVISO, no tira abajo
 *   el WAV principal que sí se pudo escribir;
 * - una ruta no autorizada cae al diálogo en vez de perder el export entero;
 * - MP3 por encima de 48 kHz y Opus fuera de 48 kHz se SALTAN con aviso en
 *   vez de escribir un archivo corrupto;
 * - la región de "Selección" recorta con el mapa de tempo, no con el tempo
 *   plano — y si cae fuera de lo que suena, avisa con una excepción clara en
 *   vez de devolver la canción entera diciendo que exportó la selección.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportOptions, RunExportConfig } from '../src/export/run-export';

/**
 * Espía de `renderStems` del engine, para las pruebas de multi-lote más abajo
 * ("stems: por lotes de 4"): cada llamada real que hace `run-export.ts` a
 * `renderStems` —una por lote, sea por el worker o directo— es una petición
 * real al motor de render, así que contarlas cuenta las peticiones de
 * verdad, no una simulación de ellas. `failStemIndex`, si no es null, hace
 * que la pista de ese índice "revienta" en el resultado que ve run-export.ts:
 * se deja correr el render real y se le quita esa entrada de `results` para
 * ponerla en `errors`, tal como haría un `renderStems` real cuyo kernel
 * reventó en esa pista (packages/engine/src/render/offline.ts ya prueba,
 * aparte, que ESE aislamiento por pista funciona; esto prueba que
 * `run-export.ts` consume bien un lote a medias).
 */
const renderStemsSpy = vi.fn();
let failStemIndex: number | null = null;
vi.mock('@orbit/engine', async () => {
  const actual = await vi.importActual<typeof import('@orbit/engine')>('@orbit/engine');
  return {
    ...actual,
    renderStems: (
      project: Parameters<typeof actual.renderStems>[0],
      trackIndices: Parameters<typeof actual.renderStems>[1],
      opts: Parameters<typeof actual.renderStems>[2],
    ) => {
      renderStemsSpy(trackIndices);
      const outcome = actual.renderStems(project, trackIndices, opts);
      if (failStemIndex !== null && outcome.results.has(failStemIndex)) {
        outcome.results.delete(failStemIndex);
        outcome.errors.set(failStemIndex, 'fallo simulado en el render del stem (test)');
      }
      return outcome;
    },
  };
});

const BASE_OPTS = {
  source: 'song' as const,
  patternId: null,
  region: null,
  normalize: false,
  stems: false,
  midi: false,
  mp3: false,
  flac: false,
  ogg: false,
  opus: false,
  opusBitrate: 128000,
  depth: 16 as const,
  sampleRate: 44100,
  // Corto a propósito: es la cola de silencio que se añade al final, no hay
  // motivo para que un test espere 2s reales de audio de silencio.
  tailSeconds: 0.02,
};

interface Written {
  path: string;
  bytes: Uint8Array;
}

interface Rig {
  runExport: (
    path: string,
    opts: ExportOptions,
    config?: RunExportConfig,
  ) => ReturnType<typeof import('../src/export/run-export')['runExport']>;
  writes: Written[];
  writeImpl: (path: string, data: Uint8Array) => Promise<void>;
  saveDialog: ReturnType<typeof vi.fn>;
  channelId: string;
  /** Añade un canal más, enrutado a la pista de mixer pedida. Devuelve su id. */
  addChannelOnTrack: (mixerTrack: number) => string;
}

/**
 * Un `run-export` recién nacido, con un proyecto vacío (silencio) y un
 * `window.orbit.file` que solo apunta qué se escribió, en vez de tocar disco.
 * `vi.resetModules()` aísla el flag `running` (module-level) y el store del
 * proyecto entre tests.
 */
async function rig(): Promise<Rig> {
  vi.resetModules();

  const writes: Written[] = [];
  const saveDialog = vi.fn(async (name: string) => `/elegido/${name}`);
  const writeImpl = async (path: string, data: Uint8Array): Promise<void> => {
    writes.push({ path, bytes: data });
  };

  vi.stubGlobal('window', {
    orbit: {
      file: { write: (p: string, d: Uint8Array) => writeImpl(p, d), saveDialog },
      settings: {
        get: async () => ({}),
        set: async (p: Record<string, unknown>) => p,
      },
    },
  });
  // `nextPaint()` (los avisos de progreso entre pasos) usa el global
  // `requestAnimationFrame` directo, no `window.requestAnimationFrame`.
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0));

  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const addChannelOnTrack = (mixerTrack: number): string => {
    const ch = core.createChannel('synth', store.project.channelOrder.length, `Canal ${mixerTrack}`);
    ch.mixerTrack = mixerTrack;
    store.dispatch({ type: 'addChannel', channel: ch }, { label: `canal pista ${mixerTrack}` });
    return ch.id;
  };

  const mod = await import('../src/export/run-export');

  return {
    runExport: mod.runExport,
    writes,
    writeImpl,
    saveDialog,
    addChannelOnTrack,
    channelId: channel.id,
  };
}

describe('runExport: orquestación de render, corte y formatos', () => {
  afterEach(() => {
    renderStemsSpy.mockClear();
    failStemIndex = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('escribe el WAV principal y devuelve un resumen coherente', async () => {
    const { runExport, writes } = await rig();
    const summary = await runExport('/salida/beat.wav', BASE_OPTS);

    expect(summary.path).toBe('/salida/beat.wav');
    expect(writes.map((w) => w.path)).toEqual(['/salida/beat.wav']);
    expect(writes[0]!.bytes.length).toBeGreaterThan(0);
    expect(summary.stemsWritten).toBe(0);
    expect(summary.midiPath).toBeNull();
    expect(summary.warnings).toEqual([]);
  });

  it('no deja lanzar dos exports a la vez', async () => {
    const { runExport } = await rig();
    const first = runExport('/salida/a.wav', BASE_OPTS);
    await expect(runExport('/salida/b.wav', BASE_OPTS)).rejects.toThrow(/ya hay un export/i);
    await first; // no dejar la promesa colgada entre tests
  });

  it('Selección sin región marcada: falla con un mensaje claro, no exporta la canción entera', async () => {
    const { runExport } = await rig();
    await expect(
      runExport('/salida/sel.wav', { ...BASE_OPTS, source: 'selection', region: null }),
    ).rejects.toThrow(/ninguna región marcada/i);
  });

  it('Patrón con un id que ya no existe en el proyecto: falla en vez de exportar cualquier cosa', async () => {
    const { runExport } = await rig();
    await expect(
      runExport('/salida/pat.wav', { ...BASE_OPTS, source: 'pattern', patternId: 'no-existe' }),
    ).rejects.toThrow(/patrón.*ya no existe/i);
  });

  it('una región que cae fuera de lo que suena avisa con excepción, no exporta la canción entera', async () => {
    const { runExport } = await rig();
    // tailSeconds=0.02 a 140 BPM: la cola es minúscula. Un región lejísimos
    // (beat 10000..10004) cae fuera de lo renderizado con seguridad.
    await expect(
      runExport('/salida/sel.wav', {
        ...BASE_OPTS,
        source: 'selection',
        region: { start: 10000, end: 10004 },
      }),
    ).rejects.toThrow(/fuera de lo que suena/i);
  });

  it('MP3 por encima de 48 kHz se salta con aviso: el WAV se escribe igual', async () => {
    const { runExport, writes } = await rig();
    const summary = await runExport('/salida/hi.wav', {
      ...BASE_OPTS,
      sampleRate: 96000,
      mp3: true,
    });
    expect(summary.mp3Path).toBeNull();
    expect(summary.warnings.some((w) => /MP3.*48/i.test(w))).toBe(true);
    // El WAV, que SÍ se puede escribir a 96 kHz, no se pierde por el aviso.
    expect(writes.map((w) => w.path)).toEqual(['/salida/hi.wav']);
  });

  it('Opus fuera de 48 kHz se salta con aviso, no escribe un archivo a la frecuencia que no toca', async () => {
    const { runExport, writes } = await rig();
    const summary = await runExport('/salida/beat.wav', {
      ...BASE_OPTS,
      sampleRate: 44100,
      opus: true,
    });
    expect(summary.opusPath).toBeNull();
    expect(summary.warnings.some((w) => /Opus.*48/i.test(w))).toBe(true);
    expect(writes.some((w) => w.path.endsWith('.opus'))).toBe(false);
  });

  it('FLAC a 32 bits avisa y cae a 24: no intenta escribir float donde no cabe', async () => {
    const { runExport, writes } = await rig();
    const summary = await runExport('/salida/beat.wav', {
      ...BASE_OPTS,
      depth: 32,
      flac: true,
    });
    expect(summary.flacPath).toBe('/salida/beat.flac');
    expect(summary.warnings.some((w) => /FLAC.*float/i.test(w))).toBe(true);
    expect(writes.map((w) => w.path)).toContain('/salida/beat.flac');
  });

  it('un formato secundario que falla al escribir queda como aviso: el WAV ya escrito no se pierde', async () => {
    const { runExport, writeImpl, writes } = await rig();
    // Sustituye el mock de escritura: el .flac falla, el resto no.
    const original = writeImpl;
    vi.stubGlobal('window', {
      orbit: {
        file: {
          write: async (path: string, data: Uint8Array) => {
            if (path.endsWith('.flac')) throw new Error('disco lleno');
            return original(path, data);
          },
          saveDialog: vi.fn(),
        },
        settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
      },
    });
    const summary = await runExport('/salida/beat.wav', { ...BASE_OPTS, flac: true, midi: true });

    expect(summary.flacPath).toBeNull();
    expect(summary.warnings.some((w) => /disco lleno/.test(w))).toBe(true);
    // El WAV Y el .mid, que no dependían del FLAC, se escribieron igual.
    expect(writes.map((w) => w.path).sort()).toEqual(['/salida/beat.mid', '/salida/beat.wav']);
  });

  it('ruta no autorizada: cae al diálogo de guardado en vez de perder el export', async () => {
    const { writeImpl } = await rig();
    let calls = 0;
    const saveDialog = vi.fn(async () => '/autorizada/beat.wav');
    vi.stubGlobal('window', {
      orbit: {
        file: {
          write: async (path: string, data: Uint8Array) => {
            calls++;
            if (calls === 1) throw new Error('esa carpeta no permitida');
            return writeImpl(path, data);
          },
          saveDialog,
        },
        settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
      },
    });
    const { runExport } = await import('../src/export/run-export');
    const summary = await runExport('/fuera/beat.wav', BASE_OPTS, { allowDialogFallback: true });

    expect(saveDialog).toHaveBeenCalledTimes(1);
    expect(summary.path).toBe('/autorizada/beat.wav');
    expect(summary.warnings.some((w) => /no estaba autorizada/i.test(w))).toBe(true);
  });

  it('ruta no autorizada SIN respaldo permitido: no pregunta, deja el error subir', async () => {
    await rig();
    vi.stubGlobal('window', {
      orbit: {
        file: {
          write: async () => {
            throw new Error('esa carpeta no permitida');
          },
          saveDialog: vi.fn(),
        },
        settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
      },
    });
    const { runExport } = await import('../src/export/run-export');
    await expect(
      runExport('/fuera/beat.wav', BASE_OPTS, { allowDialogFallback: false }),
    ).rejects.toThrow(/no permitida/i);
  });

  it('stems: una pista de mixer usada por un canal produce un .wav hermano', async () => {
    const { runExport, writes } = await rig();
    const summary = await runExport('/salida/beat.wav', { ...BASE_OPTS, stems: true });

    expect(summary.stemsWritten).toBe(1); // un canal, en Master
    expect(writes.some((w) => /beat-master\.wav$/.test(w.path))).toBe(true);
  });

  it('stems: 12 pistas piden EXACTAMENTE 3 lotes de 4 al motor de render, no 12 ni 1', async () => {
    const { runExport, addChannelOnTrack } = await rig();
    // El canal de rig() ya usa Master (pista 0); se suman las pistas 1..11
    // para llegar a 12 pistas de stem en total.
    for (let t = 1; t <= 11; t++) addChannelOnTrack(t);

    const summary = await runExport('/salida/beat.wav', { ...BASE_OPTS, stems: true });

    expect(summary.stemsWritten).toBe(12);
    // La tarea que introdujo el batching se tituló "una sola petición al
    // worker": lo que de verdad hace es ceil(12/4) = 3 peticiones reales al
    // motor de render, contadas aquí — ni una petición por stem ni las 12
    // juntas de una sola vez.
    expect(renderStemsSpy).toHaveBeenCalledTimes(3);
    expect(renderStemsSpy.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([4, 4, 4]);
  });

  it('stems: 13 pistas piden 4 lotes, el último de una sola pista suelta', async () => {
    const { runExport, addChannelOnTrack } = await rig();
    for (let t = 1; t <= 12; t++) addChannelOnTrack(t);

    const summary = await runExport('/salida/beat.wav', { ...BASE_OPTS, stems: true });

    expect(summary.stemsWritten).toBe(13);
    expect(renderStemsSpy).toHaveBeenCalledTimes(4);
    expect(renderStemsSpy.mock.calls.map((c) => (c[0] as number[]).length)).toEqual([4, 4, 4, 1]);
  });

  it('stems: un stem que revienta no se lleva a los hermanos ya renderizados en su mismo lote', async () => {
    const { runExport, writes, addChannelOnTrack } = await rig();
    // 4 pistas de stem en UN SOLO lote (Master + 1, 2, 3): la pista 2 revienta.
    addChannelOnTrack(1);
    addChannelOnTrack(2);
    addChannelOnTrack(3);
    failStemIndex = 2;

    const summary = await runExport('/salida/beat.wav', { ...BASE_OPTS, stems: true });

    // Antes del fix, la excepción de la pista 2 sin capturar tiraba con ella
    // TODO el lote: los stems de Master, 1 y 3 (ya renderizados con éxito)
    // también se perdían. Con el fix, los tres se escriben igual.
    expect(summary.stemsWritten).toBe(3);
    expect(writes.some((w) => /beat-master\.wav$/.test(w.path))).toBe(true);
    expect(writes.some((w) => /beat-insert-1\.wav$/.test(w.path))).toBe(true);
    expect(writes.some((w) => /beat-insert-3\.wav$/.test(w.path))).toBe(true);
    // La pista rota no se escribe (nada corrupto ni a medias)...
    expect(writes.some((w) => /beat-insert-2\.wav$/.test(w.path))).toBe(false);
    // ...pero tampoco desaparece en silencio: queda un aviso con cuál faltó.
    expect(
      summary.warnings.some((w) => /insert 2/i.test(w) && /fallo simulado/.test(w)),
    ).toBe(true);
  });
});

describe('utilidades puras de nombre y ruta', () => {
  it('sanitizeFileName: fuera los caracteres que Windows no admite', async () => {
    const { sanitizeFileName } = await import('../src/export/run-export');
    expect(sanitizeFileName('beat: trap? "top"')).toBe('beat- trap- -top-');
    expect(sanitizeFileName('   ')).toBe('export'); // nada usable: nombre por defecto
  });

  it('fileNameOf: solo el nombre, sin la carpeta, en cualquier separador', async () => {
    const { fileNameOf } = await import('../src/export/run-export');
    expect(fileNameOf('/salida/beat.wav')).toBe('beat.wav');
    expect(fileNameOf('C:\\salida\\beat.wav')).toBe('beat.wav');
    expect(fileNameOf('beat.wav')).toBe('beat.wav');
  });

  it('nextExportPath: la copia 1 es la ruta tal cual; de ahí en más, sufijo -N', async () => {
    const { nextExportPath } = await import('../src/export/run-export');
    expect(nextExportPath('/salida/beat.wav', 1)).toBe('/salida/beat.wav');
    expect(nextExportPath('/salida/beat.wav', 2)).toBe('/salida/beat-2.wav');
    expect(nextExportPath('/salida/beat.wav', 3)).toBe('/salida/beat-3.wav');
  });

  it('suggestedExportName: patrón usa su nombre; canción usa el título del proyecto', async () => {
    const core = await import('@orbit/core');
    const { suggestedExportName } = await import('../src/export/run-export');
    const project = core.createEmptyProject('Mi Beat');
    const patternId = project.patternOrder[0]!;

    expect(suggestedExportName(project, { ...BASE_OPTS, source: 'song' })).toBe('Mi Beat.wav');
    expect(
      suggestedExportName(project, { ...BASE_OPTS, source: 'selection' }),
    ).toBe('Mi Beat-seleccion.wav');
    expect(
      suggestedExportName(project, { ...BASE_OPTS, source: 'pattern', patternId }),
    ).toBe(`${project.patterns[patternId]!.name}.wav`);
  });

  it('usedMixerTracks: solo las pistas con al menos un canal enrutado, en orden', async () => {
    const core = await import('@orbit/core');
    const { usedMixerTracks } = await import('../src/export/run-export');
    const project = core.createEmptyProject();
    const a = core.createChannel('synth', 0, 'A');
    const b = core.createChannel('synth', 1, 'B');
    b.mixerTrack = 3;
    project.channels[a.id] = a;
    project.channels[b.id] = b;
    project.channelOrder = [a.id, b.id];

    expect(usedMixerTracks(project)).toEqual([
      { idx: 0, name: 'Master' },
      { idx: 3, name: 'Insert 3' },
    ]);
  });

  it('usedMixerTracks: un canal enrutado a una pista que ya no existe no revienta', async () => {
    const core = await import('@orbit/core');
    const { usedMixerTracks } = await import('../src/export/run-export');
    const project = core.createEmptyProject();
    const a = core.createChannel('synth', 0, 'A');
    a.mixerTrack = 999;
    project.channels[a.id] = a;
    project.channelOrder = [a.id];

    expect(usedMixerTracks(project)).toEqual([]);
  });
});
