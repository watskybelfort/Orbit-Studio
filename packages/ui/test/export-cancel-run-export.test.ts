/**
 * Cancelar un export a medias (`cancelExport`/`ExportCancelledError` en
 * `run-export.ts`). Mismo estilo que `run-export.test.ts`: un `window.orbit`
 * de mentira que solo anota qué se escribió, y `renderStems` real (envuelto
 * en un espía) para que las peticiones al motor sean las de verdad — la
 * cancelación del render en sí (`isCancelled`/`RenderCancelledError`) tiene
 * su propio test en `export-cancel-render.test.ts`, contra `@orbit/engine`
 * directo.
 *
 * Lo que hay que probar, que no prueba `run-export.test.ts`:
 *
 * - Cancelar ENTRE lotes deja los stems ya escritos en disco (se QUEDAN, no
 *   se borran — ver el porqué en el comentario de `cancelExport`) y corta
 *   antes de pedir el siguiente lote al motor de render.
 * - El resumen de la cancelación (`ExportCancelledError.partial`) dice la
 *   verdad: cuántos stems se escribieron, cuántos había en total, y si el WAV
 *   principal llegó a escribirse.
 * - Cancelar NO dice "no se pudo renderizar el stem" de los que ni se llegó a
 *   pedir — eso sería mentir sobre por qué faltan.
 * - Tras cancelar, el estado queda limpio: se puede lanzar OTRO export justo
 *   después sin el "ya hay un export en marcha" (checklist: "cancelar deja
 *   el estado limpio y se puede volver a exportar").
 * - `repeatLastExport` no llama a `rememberExport` con un export cancelado:
 *   "Repetir" no debe apuntar a algo que nunca terminó.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExportOptions } from '../src/export/run-export';

const renderStemsSpy = vi.fn();
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
      return actual.renderStems(project, trackIndices, opts);
    },
  };
});

const BASE_OPTS = {
  source: 'song' as const,
  patternId: null,
  region: null,
  normalize: false,
  stems: true,
  midi: false,
  mp3: false,
  flac: false,
  ogg: false,
  opus: false,
  opusBitrate: 128000,
  depth: 16 as const,
  sampleRate: 44100,
  // Corto a propósito, igual que run-export.test.ts: no hay motivo para
  // esperar 2s reales de cola de silencio en cada test.
  tailSeconds: 0.02,
};

interface Written {
  path: string;
  bytes: Uint8Array;
}

type RunExportFn = typeof import('../src/export/run-export')['runExport'];
type CancelExportFn = typeof import('../src/export/run-export')['cancelExport'];
type ExportCancelledErrorClass = typeof import('../src/export/run-export')['ExportCancelledError'];
type RepeatLastExportFn = typeof import('../src/export/run-export')['repeatLastExport'];

interface Rig {
  runExport: RunExportFn;
  cancelExport: CancelExportFn;
  ExportCancelledError: ExportCancelledErrorClass;
  repeatLastExport: RepeatLastExportFn;
  rememberExportModule: typeof import('../src/export/run-export');
  writes: Written[];
  settingsSet: ReturnType<typeof vi.fn>;
  addChannelOnTrack: (mixerTrack: number) => string;
  /** Dispara `cancelExport()` en cuanto `orbit.file.write` reciba esta ruta (sufijo). */
  cancelOnWriteEndingWith: (suffix: string) => void;
}

/**
 * Igual que el `rig()` de `run-export.test.ts`, con un añadido: `writeImpl`
 * puede disparar `cancelExport()` justo cuando se escribe un archivo concreto
 * — es el mismo punto en el que, en la app real, el usuario habría tenido
 * tiempo de pulsar "Cancelar" mientras el archivo ANTERIOR se grababa. Llamar
 * a `cancelExport()` nada más invocar `runExport(...)` (sin pasar por ningún
 * `write`) NO sirve para probar "cancelar entre lotes": la primera línea de
 * `renderAndWrite` tras el primer `await` ya es un checkpoint, así que
 * cancelar ahí corta ANTES de que exista ningún stem — hace falta dejar que
 * algo real se escriba primero.
 */
async function rig(): Promise<Rig> {
  vi.resetModules();

  const writes: Written[] = [];
  let cancelSuffix: string | null = null;
  let cancelFn: (() => void) | null = null;
  const writeImpl = async (path: string, data: Uint8Array): Promise<void> => {
    writes.push({ path, bytes: data });
    if (cancelSuffix && path.endsWith(cancelSuffix)) cancelFn?.();
  };
  const settingsSet = vi.fn(async (p: Record<string, unknown>) => p);

  vi.stubGlobal('window', {
    orbit: {
      file: {
        write: (p: string, d: Uint8Array) => writeImpl(p, d),
        saveDialog: vi.fn(async (name: string) => `/elegido/${name}`),
      },
      settings: {
        get: async () => ({}),
        set: settingsSet,
      },
    },
  });
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
  cancelFn = mod.cancelExport;

  return {
    runExport: mod.runExport,
    cancelExport: mod.cancelExport,
    ExportCancelledError: mod.ExportCancelledError,
    repeatLastExport: mod.repeatLastExport,
    rememberExportModule: mod,
    writes,
    settingsSet,
    addChannelOnTrack,
    cancelOnWriteEndingWith: (suffix: string) => {
      cancelSuffix = suffix;
    },
  };
}

describe('cancelar un export: entre lotes de stems', () => {
  afterEach(() => {
    renderStemsSpy.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('corta ANTES del segundo lote: deja los 4 stems del primero en disco y no pide el segundo', async () => {
    const { runExport, ExportCancelledError, writes, addChannelOnTrack, cancelOnWriteEndingWith } =
      await rig();
    // El canal de rig() ya usa Master (pista 0); se suman 1..7 para llegar a
    // 8 pistas de stem ⇒ 2 lotes de 4: [Master,1,2,3] y [4,5,6,7].
    for (let t = 1; t <= 7; t++) addChannelOnTrack(t);
    // El último stem del PRIMER lote: cuando se escribe, el lote ya terminó
    // de principio a fin, así que cancelar aquí es justo "entre lotes".
    cancelOnWriteEndingWith('beat-insert-3.wav');

    const result: unknown = await runExport('/salida/beat.wav', BASE_OPTS).catch((e: unknown) => e);

    expect(result).toBeInstanceOf(ExportCancelledError);
    const err = result as InstanceType<typeof ExportCancelledError>;

    // Solo se pidió el primer lote al motor de render — nunca el segundo.
    expect(renderStemsSpy).toHaveBeenCalledTimes(1);
    expect(renderStemsSpy.mock.calls[0]![0]).toEqual([0, 1, 2, 3]);

    // Los 4 stems del primer lote se quedan en disco (decisión: no se borran).
    expect(writes.map((w) => w.path).sort()).toEqual(
      [
        '/salida/beat.wav',
        '/salida/beat-master.wav',
        '/salida/beat-insert-1.wav',
        '/salida/beat-insert-2.wav',
        '/salida/beat-insert-3.wav',
      ].sort(),
    );

    // El resumen de la cancelación no miente: 4 de 8, y el WAV principal
    // —que se escribe ANTES que ningún stem— ya estaba en disco.
    expect(err.partial.path).toBe('/salida/beat.wav');
    expect(err.partial.stemsWritten).toBe(4);
    expect(err.partial.totalStems).toBe(8);
    // Los 4 stems del segundo lote faltan porque nunca se pidieron, no porque
    // reventaran: no debe haber ningún aviso de "no se pudo renderizar".
    expect(err.partial.warnings.some((w) => /no se pudo renderizar/i.test(w))).toBe(false);
  });

  it('cancelar deja el estado limpio: el export siguiente no dice "ya hay un export en marcha"', async () => {
    const { runExport, cancelExport, ExportCancelledError } = await rig();

    // Cancelar SÍNCRONO justo después de invocar: `runExport` corre hasta su
    // primer `await` (el `report('Renderizando…')` inicial) y devuelve una
    // promesa pendiente ANTES de que esta línea siguiente se ejecute, así que
    // `cancelExport()` ya encuentra `running === true` y pide cortar antes de
    // que se renderice nada — el checkpoint más temprano de todos.
    const running = runExport('/salida/a.wav', BASE_OPTS);
    cancelExport();
    const cancelled = await running.catch((e: unknown) => e);
    expect(cancelled).toBeInstanceOf(ExportCancelledError);

    // Si `running`/el flag de cancelación no se limpiaran en el `finally` de
    // `runExport`, esto fallaría con "ya hay un export en marcha" o se
    // cortaría solo de nuevo sin que nadie pidiera cancelar ESTE.
    const summary = await runExport('/salida/b.wav', BASE_OPTS);
    expect(summary.path).toBe('/salida/b.wav');

    // Llamar a `cancelExport()` de más, sin nada corriendo, no rompe nada.
    cancelExport();
  });

  it('repeatLastExport: un export cancelado no se convierte en "el último" para Ctrl+E', async () => {
    const { runExport, repeatLastExport, settingsSet, cancelOnWriteEndingWith, rememberExportModule } =
      await rig();

    // Un export normal primero: es el "último" real, el que Ctrl+E debe
    // seguir repitiendo después del intento cancelado. Con stems (1 pista,
    // Master) para que el repetido de abajo tenga una fase DESPUÉS del WAV
    // principal donde el checkpoint pueda atender la cancelación.
    await runExport('/salida/ok.wav', BASE_OPTS);
    await rememberExportModule.rememberExport('/salida/ok.wav', BASE_OPTS, 1);
    settingsSet.mockClear();

    // Ahora un `repeatLastExport()` que se cancela justo al escribir su WAV
    // (nextExportPath('/salida/ok.wav', 2) === '/salida/ok-2.wav').
    cancelOnWriteEndingWith('/salida/ok-2.wav');
    await repeatLastExport();

    // `rememberExport` (settings.set con `lastExport`) NUNCA se llega a
    // llamar: en `repeatLastExport`, esa llamada vive DESPUÉS del `await
    // runExport(...)` dentro del mismo `try`, así que una excepción ahí la
    // salta entera.
    expect(settingsSet).not.toHaveBeenCalled();
  });
});
