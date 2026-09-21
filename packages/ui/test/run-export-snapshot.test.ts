/**
 * El export es una FOTO: lo que se renderiza, lo que se etiqueta y lo que se
 * escribe tienen que salir del mismo proyecto.
 *
 * El WAV sí salía bien porque el render compila una copia, pero el `.mid` y
 * los tags del `.opus` se codificaban al FINAL, leyendo `store.project` —el
 * proyecto vivo, que lleva minutos de export abierto—. Editar el tempo
 * mientras exporta (o que lo edite la sala, o Claude) dejaba el WAV a 140 y
 * el `.mid` a 200, y el archivo que iba a servir para seguir en FL quedaba
 * desincronizado de la mezcla que lo acompaña.
 *
 * Este test edita el tempo justo después de escribirse el WAV —o sea, antes
 * de codificar el `.mid`— y exige que el `.mid` siga diciendo 140.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Mismo motivo que en `input-monitor-hot-unplug.test.ts`: reimportar el grafo
// de state/app en cada test paga la transformación en frío, y con la máquina
// bajo carga (varios agentes a la vez) el primer import supera los 5 s de fábrica.
vi.setConfig({ testTimeout: 60_000 });
import type { ExportOptions } from '../src/export/run-export';

/**
 * El render de la mezcla se sustituye por silencio: lo que este test mide es
 * de QUÉ proyecto se codifica el `.mid`, no el DSP (eso lo fijan los golden
 * del engine). Así el test tampoco depende del estado de `kernel-core`, que
 * otras tareas tocan a la vez.
 */
vi.mock('@orbit/engine', async () => {
  const actual = await vi.importActual<typeof import('@orbit/engine')>('@orbit/engine');
  return {
    ...actual,
    renderProject: (_project: unknown, opts: { sampleRate?: number } = {}) => ({
      left: new Float32Array(64),
      right: new Float32Array(64),
      sampleRate: opts.sampleRate ?? 44100,
    }),
  };
});

const BASE_OPTS: ExportOptions = {
  source: 'song',
  patternId: null,
  region: null,
  normalize: false,
  stems: false,
  midi: true,
  mp3: false,
  flac: false,
  ogg: false,
  opus: false,
  opusBitrate: 128000,
  depth: 16,
  sampleRate: 44100,
  tailSeconds: 0.02,
};

interface Written {
  path: string;
  bytes: Uint8Array;
}

/** Microsegundos por negra del primer meta tempo (FF 51 03) del archivo. */
function tempoMicros(midi: Uint8Array): number {
  for (let i = 0; i + 5 < midi.length; i++) {
    if (midi[i] === 0xff && midi[i + 1] === 0x51 && midi[i + 2] === 0x03) {
      return (midi[i + 3]! << 16) | (midi[i + 4]! << 8) | midi[i + 5]!;
    }
  }
  throw new Error('el .mid no lleva meta tempo');
}

interface Rig {
  runExport: typeof import('../src/export/run-export')['runExport'];
  writes: Written[];
  store: typeof import('../src/state/app')['store'];
  /** Se llama con la ruta de cada escritura, antes de anotarla. */
  setOnWrite: (fn: (path: string) => void) => void;
}

async function rig(): Promise<Rig> {
  vi.resetModules();
  const writes: Written[] = [];
  let onWrite: (path: string) => void = () => undefined;
  vi.stubGlobal('window', {
    orbit: {
      file: {
        write: async (path: string, data: Uint8Array) => {
          onWrite(path);
          writes.push({ path, bytes: data });
        },
        saveDialog: vi.fn(),
      },
      settings: { get: async () => ({}), set: async (p: Record<string, unknown>) => p },
    },
  });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => setTimeout(() => cb(0), 0));

  const core = await import('@orbit/core');
  const { store } = await import('../src/state/app');
  const channel = core.createChannel('synth', 0, 'Lead');
  store.dispatch({ type: 'addChannel', channel }, { label: 'canal de prueba' });

  const mod = await import('../src/export/run-export');
  return {
    runExport: mod.runExport,
    writes,
    store,
    setOnWrite: (fn) => {
      onWrite = fn;
    },
  };
}

describe('runExport: la foto del proyecto manda en TODO el export', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('editar el tempo a mitad del export no desincroniza el .mid de la mezcla', async () => {
    const { runExport, writes, store, setOnWrite } = await rig();
    // El proyecto de fábrica va a 140 BPM. Justo después del WAV —antes de que
    // se codifique el .mid— alguien sube el tempo a 200.
    setOnWrite((path) => {
      if (path.endsWith('.wav')) store.dispatch({ type: 'setTempo', tempo: 200 }, { label: 'tempo' });
    });

    const summary = await runExport('/salida/beat.wav', BASE_OPTS);

    expect(summary.midiPath).toBe('/salida/beat.mid');
    const midi = writes.find((w) => w.path.endsWith('.mid'));
    expect(midi).toBeDefined();
    expect(tempoMicros(midi!.bytes)).toBe(Math.round(60_000_000 / 140));
  });
});
