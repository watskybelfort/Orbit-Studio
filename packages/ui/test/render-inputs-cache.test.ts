/**
 * El caché de render (`sampleCache`, módulo `render-inputs.ts`) es la otra
 * fuga de audio de la v3.5: igual que `this.samples` en `kernel-core.ts`, se
 * escribía y no se borraba nunca — con la diferencia de que este vive en el
 * hilo de la UI, no en el de audio. Cada export, bounce o freeze dejaba ahí
 * el audio decodificado del proyecto y nadie lo soltaba.
 *
 * Esto prueba el barrido que se añadió DENTRO de `collectSamples`
 * (`gcRenderSampleCache`, después de resolver — nunca antes):
 *
 * - el caché encoge cuando un sample deja de estar registrado en el proyecto
 *   (borrado, o cambiado de proyecto entero);
 * - un export QUE YA TIENE su propio `Map` de samples no pierde nada aunque
 *   el barrido de OTRA llamada (otro export, un bounce) le suelte la entrada
 *   de `sampleCache` por debajo — `Map.delete` en el caché nunca toca el
 *   `SampleData` que ya se entregó;
 * - repetir un export del MISMO proyecto sigue sin releer disco (el barrido
 *   no convierte el ahorro en una relectura constante).
 *
 * Los tamaños de aquí son bytes REALES de los `Float32Array` que crea
 * `collectSamples` (frames × 2 canales × 4 bytes) — medidos por
 * `renderSampleCacheStats()`, no estimados.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProject, type Project, type SampleRef } from '@orbit/core';
import type { CompiledChannel, CompiledProject } from '@orbit/engine';

const readSampleBytesMock = vi.fn<(path: string) => Promise<ArrayBuffer | null>>();
vi.mock('../src/browser/sound-actions', () => ({
  readSampleBytes: (path: string) => readSampleBytesMock(path),
}));

// ── Fixtures (mismo estilo que render-inputs.test.ts) ───────────────────────

function channel(patch: Partial<CompiledChannel> = {}): CompiledChannel {
  return {
    id: 'ch1',
    kind: 'sampler',
    params: {},
    volume: 1,
    pan: 0,
    audible: true,
    mixerTrack: 1,
    ...patch,
  };
}

function compiled(patch: Partial<CompiledProject> = {}): CompiledProject {
  return {
    tempo: 120,
    swing: 0,
    timeSigNum: 4,
    lengthBeats: 16,
    channels: [],
    events: [],
    audioClips: [],
    automation: [],
    lfos: [],
    mixer: [],
    mixerOrder: [],
    ...patch,
  } as CompiledProject;
}

function sampleRef(id: string, hash: string): SampleRef {
  return { id, name: id, path: `user:${id}.wav`, hash, duration: 1 };
}

function projectWithSamples(refs: SampleRef[]): Project {
  const project = createEmptyProject('Test');
  for (const ref of refs) project.samples[ref.id] = ref;
  return project;
}

/** Bytes de un "wav" de mentira: `frames` muestras estéreo sin comprimir. */
function fakeWavBytes(frames: number): ArrayBuffer {
  return new ArrayBuffer(frames * 4);
}

/** OfflineAudioContext de mentira: decodifica al tamaño exacto de `bytes`. */
class FakeOfflineAudioContext {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  decodeAudioData(buf: ArrayBuffer): Promise<{
    sampleRate: number;
    numberOfChannels: number;
    getChannelData: (ch: number) => Float32Array;
  }> {
    const frames = buf.byteLength / 4;
    return Promise.resolve({
      sampleRate: 44100,
      numberOfChannels: 2,
      getChannelData: () => new Float32Array(frames),
    });
  }
}

function rig(): void {
  vi.resetModules();
  readSampleBytesMock.mockReset();
  vi.stubGlobal('window', { orbit: {} });
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gcRenderSampleCache: el caché encoge al quedar huérfanos', () => {
  it('un sample borrado del proyecto desaparece del caché en el siguiente collectSamples', async () => {
    rig();
    const { collectSamples, renderSampleCacheStats } = await import('../src/export/render-inputs');

    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(1000));
    const refA = sampleRef('a', 'hashA');
    const refB = sampleRef('b', 'hashB');
    const refC = sampleRef('c', 'hashC');
    const project1 = projectWithSamples([refA, refB, refC]);
    const compiled1 = compiled({
      channels: [
        channel({ id: 'ch-a', sampleId: 'a' }),
        channel({ id: 'ch-b', sampleId: 'b' }),
        channel({ id: 'ch-c', sampleId: 'c' }),
      ],
    });

    await collectSamples(project1, compiled1);
    const filled = renderSampleCacheStats();
    expect(filled.entries).toBe(3);
    // 1000 frames × 2 canales × 4 bytes = 8000 bytes por sample, x3.
    expect(filled.bytes).toBe(3 * 1000 * 2 * 4);

    // El mundo cambió: b y c ya no están registrados (se borraron, o se
    // cambió de proyecto entero). Solo "a" sigue vivo.
    const project2 = projectWithSamples([refA]);
    const compiled2 = compiled({ channels: [channel({ id: 'ch-a', sampleId: 'a' })] });

    await collectSamples(project2, compiled2);
    const shrunk = renderSampleCacheStats();
    expect(shrunk.entries).toBe(1);
    expect(shrunk.bytes).toBe(1000 * 2 * 4);
    // "a" no se releyó del disco: seguía en caché con el mismo hash.
    expect(readSampleBytesMock).toHaveBeenCalledTimes(3);
  });

  it('re-grabar un id con hash nuevo no sirve el audio viejo desde caché, y lo huérfano se suelta', async () => {
    rig();
    const { collectSamples, renderSampleCacheStats } = await import('../src/export/render-inputs');

    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(500));
    const project1 = projectWithSamples([sampleRef('voz', 'hash-v1')]);
    const compiled1 = compiled({ channels: [channel({ sampleId: 'voz' })] });
    await collectSamples(project1, compiled1);
    expect(renderSampleCacheStats().entries).toBe(1);

    // Mismo id, hash nuevo (re-grabado): la entrada vieja "voz:hash-v1" queda
    // huérfana y hay que releer para "voz:hash-v2".
    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(750));
    const project2 = projectWithSamples([sampleRef('voz', 'hash-v2')]);
    const compiled2 = compiled({ channels: [channel({ sampleId: 'voz' })] });
    const { samples } = await collectSamples(project2, compiled2);

    expect(renderSampleCacheStats().entries).toBe(1); // sigue habiendo 1: la vieja se soltó, la nueva entró
    expect(samples.get('voz')!.left.length).toBe(750); // el contenido NUEVO, no el viejo
    expect(readSampleBytesMock).toHaveBeenCalledTimes(2); // una lectura por hash distinto
  });

  it('repetir un export del MISMO proyecto no vuelve a leer disco (el barrido no rompe la reutilización)', async () => {
    rig();
    const { collectSamples } = await import('../src/export/render-inputs');
    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(2000));

    const project = projectWithSamples([sampleRef('kick', 'h1'), sampleRef('snare', 'h2')]);
    const compiledProj = compiled({
      channels: [channel({ id: 'k', sampleId: 'kick' }), channel({ id: 's', sampleId: 'snare' })],
    });

    await collectSamples(project, compiledProj);
    await collectSamples(project, compiledProj);
    await collectSamples(project, compiledProj);

    // Tres exports seguidos del mismo proyecto: solo 2 lecturas de disco en
    // total (una por sample), no 6.
    expect(readSampleBytesMock).toHaveBeenCalledTimes(2);
  });
});

describe('gcRenderSampleCache: un export en curso no se queda sin sus samples', () => {
  it('el Map que ya devolvió collectSamples sigue intacto aunque OTRA llamada barra el caché por debajo', async () => {
    rig();
    const { collectSamples, renderSampleCacheStats } = await import('../src/export/render-inputs');
    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(4410)); // 0.1s a 44.1kHz

    const project1 = projectWithSamples([sampleRef('808', 'h808')]);
    const compiled1 = compiled({ channels: [channel({ sampleId: '808' })] });

    // Este es "el export en marcha": ya tiene SU Map de samples resuelto.
    const inFlight = await collectSamples(project1, compiled1);
    const heldData = inFlight.samples.get('808');
    expect(heldData).toBeDefined();
    expect(heldData!.left.length).toBe(4410);
    expect(heldData!.right.length).toBe(4410);

    // Mientras tanto, otra operación (un bounce, o el proyecto que se
    // reemplazó por completo) ya no registra ese sample y dispara su propio
    // collectSamples — que internamente barre `sampleCache`.
    const project2 = projectWithSamples([]); // "808" ya no existe en este proyecto
    const compiled2 = compiled(); // nada que renderizar
    await collectSamples(project2, compiled2);

    // El caché SÍ se vació de esa entrada...
    expect(renderSampleCacheStats().entries).toBe(0);
    // ...pero el Map que ya tenía el export en marcha sigue con su audio
    // intacto: el barrido nunca toca el SampleData ya entregado, solo la
    // referencia que guardaba el caché.
    expect(inFlight.samples.get('808')).toBe(heldData);
    expect(heldData!.left.length).toBe(4410);
    expect(heldData!.right.length).toBe(4410);
    expect(Array.from(heldData!.left).every((v) => v === 0)).toBe(true);
  });

  it('lotes de stems sucesivos del mismo export (mismo Map, reutilizado varias veces) no se ven afectados por un barrido intermedio', async () => {
    rig();
    const { collectSamples, gcRenderSampleCache, renderSampleCacheStats } = await import(
      '../src/export/render-inputs'
    );
    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(100));

    const project = projectWithSamples([sampleRef('bajo', 'hb')]);
    const compiledProj = compiled({ channels: [channel({ sampleId: 'bajo' })] });
    const { samples } = await collectSamples(project, compiledProj);

    // Simula un barrido disparado por otra parte de la app a mitad de los
    // lotes de stems de ESTE mismo export (p. ej. un proyecto vacío de
    // referencia, o una limpieza de sesión concurrente).
    gcRenderSampleCache(createEmptyProject('otro'));
    expect(renderSampleCacheStats().entries).toBe(0);

    // El render de los lotes 2, 3... sigue usando el MISMO `samples` Map de
    // arriba durante todo `runExport` (ver render-inputs.ts / run-export.ts):
    // nunca vuelve a mirar `sampleCache`, así que el barrido no le rompe nada.
    expect(samples.get('bajo')!.left.length).toBe(100);
  });
});

describe('renderSampleCacheStats / gcRenderSampleCache: números reales, no estimados', () => {
  it('cambiar de proyecto dos veces seguidas mantiene el caché acotado al proyecto ABIERTO, no a la suma de los que pasaron', async () => {
    rig();
    const { collectSamples, renderSampleCacheStats } = await import('../src/export/render-inputs');
    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(44100)); // 1s a 44.1kHz por sample
    const BYTES_PER_SAMPLE = 44100 * 2 * 4; // 352 800 bytes por sample decodificado

    // Sesión larga simulada: proyecto A con 5 samples de 1s.
    const refsA = Array.from({ length: 5 }, (_, i) => sampleRef(`a${i}`, `ha${i}`));
    const projectA = projectWithSamples(refsA);
    const compiledA = compiled({
      channels: refsA.map((r) => channel({ id: `ch-${r.id}`, sampleId: r.id })),
    });
    await collectSamples(projectA, compiledA);
    const afterA = renderSampleCacheStats();
    expect(afterA.entries).toBe(5);
    expect(afterA.bytes).toBe(5 * BYTES_PER_SAMPLE); // 1 764 000 bytes, medidos

    // Se cierra A y se abre B (otros 5 samples) y se exporta/bouncea ahí:
    // SIN el barrido esto es exactamente la fuga descrita en la tarea — el
    // caché solo suma, y quedarían 10 entradas / 3 528 000 bytes vivos por
    // un proyecto que ya ni está abierto.
    const refsB = Array.from({ length: 5 }, (_, i) => sampleRef(`b${i}`, `hb${i}`));
    const projectB = projectWithSamples(refsB);
    const compiledB = compiled({
      channels: refsB.map((r) => channel({ id: `ch-${r.id}`, sampleId: r.id })),
    });
    await collectSamples(projectB, compiledB);
    const afterB = renderSampleCacheStats();
    // Medido, no estimado: sigue en 5 entradas / 1 764 000 bytes — los de A
    // se soltaron dentro de ESTE MISMO collectSamples(B, ...), no quedaron
    // esperando a que alguien más lo disparara.
    expect(afterB.entries).toBe(5);
    expect(afterB.bytes).toBe(5 * BYTES_PER_SAMPLE);
  });

  it('gcRenderSampleCache expone el antes/después exactos en bytes de una llamada aislada', async () => {
    rig();
    const { collectSamples, gcRenderSampleCache } = await import('../src/export/render-inputs');
    readSampleBytesMock.mockImplementation(async () => fakeWavBytes(200));
    const BYTES_PER_SAMPLE = 200 * 2 * 4; // 1600 bytes

    const project = projectWithSamples([sampleRef('x', 'hx'), sampleRef('y', 'hy')]);
    const compiledProj = compiled({
      channels: [channel({ id: 'cx', sampleId: 'x' }), channel({ id: 'cy', sampleId: 'y' })],
    });
    await collectSamples(project, compiledProj); // caché queda en 2 entradas, ambas vivas

    // Un barrido explícito contra un proyecto vacío: nada sobrevive.
    const result = gcRenderSampleCache(createEmptyProject('vacío'));
    expect(result.before).toEqual({ entries: 2, bytes: 2 * BYTES_PER_SAMPLE });
    expect(result.after).toEqual({ entries: 0, bytes: 0 });
  });
});
