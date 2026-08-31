/**
 * La política común de las TRES cachés de audio decodificado del hilo de UI.
 *
 * La v3.7 arregló una (`sampleCache`, en `export/render-inputs.ts`) y dejó dos:
 * la de picos (`state/sample-peaks.ts`) y —la peor— la PCM del editor de audio
 * (`editors/audio/AudioEditor.tsx`), que crecía GARANTIZADO. Aquí se prueba la
 * regla que ahora comparten y, sobre todo, las dos afirmaciones de las que
 * depende todo lo demás:
 *
 * 1. **La memoria vuelve tras cinco Normalizar seguidos.** Bytes reales de los
 *    `Float32Array`, medidos por `stats()`, no estimados.
 * 2. **Por qué el editor necesita un tope y las otras dos no**: el barrido por
 *    proyecto NO acota la caché del editor, porque los cinco samples que dejan
 *    cinco Normalizar siguen registrados en el proyecto. Eso está probado en
 *    negativo, con una caché sin tope al lado que se queda con las cinco.
 * 3. **El barrido corre cuando cambia el mundo, no solo al exportar**:
 *    `collectWorkletSamples` —el único sitio donde está escrito «acaba de
 *    cambiar el mundo»— barre las tres, y las cuatro puertas que reemplazan el
 *    proyecto entero pasan por ahí.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createEmptyProject, type Project, type SampleRef } from '@orbit/core';
import type { ToKernel } from '@orbit/engine';
import { readSource } from './read-source';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** El PCM que guarda el editor: dos canales completos + metadatos. */
interface Channels {
  left: Float32Array;
  right: Float32Array;
  rate: number;
  duration: number;
}

const RATE = 48000;
/** Un segundo estéreo a 48 kHz: 48000 × 2 × 4 = 384 000 bytes por entrada. */
const FRAMES = RATE;
const BYTES_PER_ENTRY = FRAMES * 2 * 4;

function pcm(): Channels {
  return {
    left: new Float32Array(FRAMES),
    right: new Float32Array(FRAMES),
    rate: RATE,
    duration: 1,
  };
}

function ref(id: string, hash: string): SampleRef {
  return { id, name: id, path: `recording:${id}.wav`, hash, duration: 1 };
}

/** Proyecto que registra esos samples por el camino de verdad (`applyCommand`). */
function projectWith(refs: SampleRef[]): Project {
  const project = createEmptyProject('Editor');
  for (const sample of refs) applyCommand(project, { type: 'registerSample', sample });
  return project;
}

function fakeEngine() {
  const sent: ToKernel[] = [];
  return {
    sent,
    send: (msg: ToKernel) => void sent.push(msg),
    keepOnlySamples: () => {},
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 1. La memoria vuelve tras cinco Normalizar ──────────────────────────────

describe('cinco Normalizar seguidos: la memoria del editor vuelve', () => {
  it('la caché PCM se queda en el tope de recencia, no en cinco buffers enteros', async () => {
    vi.resetModules();
    const { AUDIO_EDITOR_PCM_ENTRIES, createUiAudioCache, sampleCacheKey } = await import(
      '../src/state/sample-gc'
    );

    // Idéntica a la del editor: mismo tope, mismo contador de bytes.
    const pcmCache = createUiAudioCache<Channels>({
      name: 'editor-pcm',
      capacity: AUDIO_EDITOR_PCM_ENTRIES,
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });

    // El sample abierto en el editor, y los cinco que dejan cinco Normalizar:
    // cada operación hace `newId()` + `registerSample` y el clip repunta al
    // nuevo, así que el `useEffect` vuelve a llamar `loadChannels` con una
    // clave DISTINTA — entrada nueva cada vez.
    const original = ref('take', 'h0');
    pcmCache.set(sampleCacheKey(original.id, original.hash), pcm());
    expect(pcmCache.stats()).toEqual({ entries: 1, bytes: BYTES_PER_ENTRY });

    const edits: SampleRef[] = [];
    for (let i = 1; i <= 5; i++) {
      const edited = ref(`take-norm-${i}`, `h${i}`);
      edits.push(edited);
      pcmCache.set(sampleCacheKey(edited.id, edited.hash), pcm());
    }

    // Antes: seis entradas vivas para siempre (sobre un pad estéreo de 30 s eso
    // son ~69 MB que no volvían). Ahora: el tope, medido en bytes reales.
    const after = pcmCache.stats();
    expect(after.entries).toBe(AUDIO_EDITOR_PCM_ENTRIES);
    expect(after.bytes).toBe(AUDIO_EDITOR_PCM_ENTRIES * BYTES_PER_ENTRY);
    expect(after.bytes).toBeLessThan(6 * BYTES_PER_ENTRY);

    // Y lo que sobrevive es lo útil: el último y el anterior — el par que hace
    // que el Ctrl+Z de después de Normalizar no vuelva a leer del disco.
    expect(pcmCache.has(sampleCacheKey('take-norm-5', 'h5'))).toBe(true);
    expect(pcmCache.has(sampleCacheKey('take-norm-4', 'h4'))).toBe(true);
    // La original y los tres intermedios ya no los retiene nadie.
    expect(pcmCache.has(sampleCacheKey(original.id, original.hash))).toBe(false);
    for (const edited of edits.slice(0, 3)) {
      expect(pcmCache.has(sampleCacheKey(edited.id, edited.hash))).toBe(false);
    }
  });

  it('leer una entrada la rescata del desalojo (deshacer no relee el disco)', async () => {
    vi.resetModules();
    const { AUDIO_EDITOR_PCM_ENTRIES, createUiAudioCache, sampleCacheKey } = await import(
      '../src/state/sample-gc'
    );
    const pcmCache = createUiAudioCache<Channels>({
      name: 'editor-pcm',
      capacity: AUDIO_EDITOR_PCM_ENTRIES,
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });

    pcmCache.set(sampleCacheKey('a', 'ha'), pcm());
    pcmCache.set(sampleCacheKey('b', 'hb'), pcm());
    // Ctrl+Z: el clip vuelve a apuntar a "a" y el editor lo relee de la caché.
    expect(pcmCache.get(sampleCacheKey('a', 'ha'))).toBeDefined();
    // Otra operación destructiva encima: la que se cae es "b", no "a".
    pcmCache.set(sampleCacheKey('c', 'hc'), pcm());
    expect(pcmCache.has(sampleCacheKey('a', 'ha'))).toBe(true);
    expect(pcmCache.has(sampleCacheKey('b', 'hb'))).toBe(false);
    expect(pcmCache.stats().entries).toBe(AUDIO_EDITOR_PCM_ENTRIES);
  });
});

// ── 2. Por qué el editor necesita su propia mitad de la política ────────────

describe('el barrido por proyecto no acota la caché del editor (y por eso lleva tope)', () => {
  it('los cinco samples de cinco Normalizar SIGUEN registrados: sin tope, el barrido los conserva todos', async () => {
    vi.resetModules();
    const { createUiAudioCache, sampleCacheKey, AUDIO_EDITOR_PCM_ENTRIES } = await import(
      '../src/state/sample-gc'
    );

    const edits = Array.from({ length: 5 }, (_, i) => ref(`norm-${i}`, `h${i}`));
    // Esto es lo que hace `runOp`: cada Normalizar despacha `registerSample`,
    // así que el proyecto los NOMBRA a los cinco. "Lo que el proyecto registra"
    // —la cota correcta para el render y para los picos— aquí no quita nada.
    const project = projectWith(edits);

    const sinTope = createUiAudioCache<Channels>({
      name: 'editor-pcm-sin-tope',
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });
    const conTope = createUiAudioCache<Channels>({
      name: 'editor-pcm-con-tope',
      capacity: AUDIO_EDITOR_PCM_ENTRIES,
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });
    for (const edited of edits) {
      const key = sampleCacheKey(edited.id, edited.hash);
      sinTope.set(key, pcm());
      conTope.set(key, pcm());
    }

    const barridoSinTope = sinTope.gc(project);
    // Cero liberado: el barrido por proyecto es un no-op para este caso de uso.
    expect(barridoSinTope.after).toEqual(barridoSinTope.before);
    expect(barridoSinTope.after.entries).toBe(5);
    expect(barridoSinTope.after.bytes).toBe(5 * BYTES_PER_ENTRY);

    // Con tope, la memoria ya había vuelto antes de que nadie barriera nada.
    expect(conTope.stats().bytes).toBe(AUDIO_EDITOR_PCM_ENTRIES * BYTES_PER_ENTRY);
  });

  it('un tope de entradas en la caché del render sería el error opuesto: la prueba es que no lo tiene', () => {
    // El render sirve al proyecto ENTERO a la vez; cualquier tope de entradas
    // desalojaría a mitad del export justo lo que ese export sigue pidiendo.
    // Se afirma sobre el código: la caché del render se crea SIN `capacity`.
    const file = readSource('export/render-inputs.ts');
    expect(file).toContain('createUiAudioCache<SampleData>({');
    const call = file.slice(file.indexOf('createUiAudioCache<SampleData>({'));
    expect(call.slice(0, call.indexOf('});'))).not.toContain('capacity');
  });
});

// ── 3. El barrido corre cuando cambia el mundo, no solo al exportar ─────────

describe('collectWorkletSamples barre también el hilo de UI', () => {
  it('las tres cachés registradas encogen a lo que el proyecto nuevo nombra', async () => {
    vi.resetModules();
    const { collectWorkletSamples, createUiAudioCache, sampleCacheKey } = await import(
      '../src/state/sample-gc'
    );

    const bytesOf = (ch: Channels) => (ch.left.length + ch.right.length) * 4;
    const render = createUiAudioCache<Channels>({ name: 'render', bytesOf });
    const peaks = createUiAudioCache<Channels>({ name: 'peaks', bytesOf });
    const editor = createUiAudioCache<Channels>({ name: 'editor-pcm', capacity: 2, bytesOf });

    // Proyecto A: dos samples que pasaron por las tres cachés.
    for (const cache of [render, peaks, editor]) {
      cache.set(sampleCacheKey('a1', 'ha1'), pcm());
      cache.set(sampleCacheKey('a2', 'ha2'), pcm());
    }
    expect(render.stats().bytes).toBe(2 * BYTES_PER_ENTRY);

    // Se abre el proyecto B (o se restaura una versión, o se recupera el
    // autosave): las cuatro puertas pasan por aquí.
    const engine = fakeEngine();
    const result = collectWorkletSamples(engine, projectWith([ref('b1', 'hb1')]));

    expect(result.sent).toBe(true);
    expect(result.ui.map((s) => s.name).sort()).toEqual(['editor-pcm', 'peaks', 'render']);
    for (const sweep of result.ui) {
      expect(sweep.before).toEqual({ entries: 2, bytes: 2 * BYTES_PER_ENTRY });
      expect(sweep.after).toEqual({ entries: 0, bytes: 0 });
    }
    expect(render.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(peaks.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(editor.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it('barre el hilo de UI aunque NO se pueda recolectar en el kernel', async () => {
    vi.resetModules();
    const { collectWorkletSamples, createUiAudioCache, sampleCacheKey } = await import(
      '../src/state/sample-gc'
    );
    const render = createUiAudioCache<Channels>({
      name: 'render',
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });
    render.set(sampleCacheKey('viejo', 'hv'), pcm());

    // Motor sin `keepOnlySamples`: NO se manda nada al worklet (soltar ahí sin
    // vaciar su caché deja samplers mudos). Pero eso no es razón para dejar el
    // audio del proyecto anterior en el renderer, donde una entrada de menos
    // solo cuesta releer del disco.
    const sinOlvido = { send: () => {} };
    const result = collectWorkletSamples(sinOlvido, createEmptyProject('B'));

    expect(result.sent).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(render.stats()).toEqual({ entries: 0, bytes: 0 });
    expect(result.ui[0]!.before.bytes).toBe(BYTES_PER_ENTRY);
    expect(result.ui[0]!.after.bytes).toBe(0);
  });

  it('lo que el proyecto SÍ registra sobrevive a su propio barrido', async () => {
    vi.resetModules();
    const { collectWorkletSamples, createUiAudioCache, sampleCacheKey } = await import(
      '../src/state/sample-gc'
    );
    const render = createUiAudioCache<Channels>({
      name: 'render',
      bytesOf: (ch) => (ch.left.length + ch.right.length) * 4,
    });
    const vivo = ref('kick', 'hk');
    render.set(sampleCacheKey(vivo.id, vivo.hash), pcm());
    render.set(sampleCacheKey('huerfano', 'hh'), pcm());

    collectWorkletSamples(fakeEngine(), projectWith([vivo]));

    // Si las claves del que guarda y del que barre divergieran, esto sería 0 y
    // el "ahorro" se convertiría en una relectura de disco por llamada.
    expect(render.has(sampleCacheKey(vivo.id, vivo.hash))).toBe(true);
    expect(render.has(sampleCacheKey('huerfano', 'hh'))).toBe(false);
  });
});

// ── La equivalencia de claves de la que depende todo el barrido ─────────────

describe('la clave del que guarda y la del que barre son la misma', () => {
  it('project.samples[id].id === id tras un registerSample de verdad', async () => {
    vi.resetModules();
    const { liveSampleKeys, sampleCacheKey } = await import('../src/state/sample-gc');

    const sample = ref('take', 'hash-1');
    const project = projectWith([sample]);
    const live = liveSampleKeys(project);

    // El que GUARDA usa la clave del mapa (`id`, de `neededSampleIds`); el que
    // BARRE usa `ref.id`. Son el mismo string porque `applyCommand` escribe
    // `project.samples[cmd.sample.id] = cmd.sample`. Si eso cambiara, el GC
    // desalojaría en cada llamada justo lo que se acaba de guardar.
    for (const [id, storedRef] of Object.entries(project.samples)) {
      expect(storedRef.id).toBe(id);
      expect(live.has(sampleCacheKey(id, storedRef.hash))).toBe(true);
    }
    expect(live.has(sampleCacheKey('take', 'hash-1'))).toBe(true);
    // Y el hash es parte de la identidad: el mismo id con otro contenido no vale.
    expect(live.has(sampleCacheKey('take', 'hash-2'))).toBe(false);
  });
});

// ── Los picos: misma política, y el `failed` se va con ellos ────────────────

describe('la caché de picos se acota igual, y arrastra su Set de fallidos', () => {
  it('un sample que no se pudo leer deja de estar marcado al cambiar de proyecto', async () => {
    vi.resetModules();
    vi.doMock('../src/browser/sound-actions', () => ({
      readSampleBytes: async () => null, // "no está en esta máquina"
    }));
    const { peaksOf, peaksFailed, peaksCacheStats } = await import('../src/state/sample-peaks');
    const { collectWorkletSamples } = await import('../src/state/sample-gc');

    const perdido = ref('perdido', 'hp');
    expect(await peaksOf(perdido)).toBeNull();
    expect(peaksFailed(perdido)).toBe(true);

    // Se cambia de proyecto: ni los picos ni la marca de "imposible" tienen ya
    // nada que ver con lo que hay abierto.
    collectWorkletSamples(fakeEngine(), createEmptyProject('otro'));
    expect(peaksFailed(perdido)).toBe(false);
    expect(peaksCacheStats()).toEqual({ entries: 0, bytes: 0 });
    vi.doUnmock('../src/browser/sound-actions');
  });
});

// ── Que el editor de verdad use la caché acotada (no en teoría) ─────────────

describe('AudioEditor.tsx usa la caché acotada de verdad', () => {
  const file = readSource('editors/audio/AudioEditor.tsx');

  it('no queda ningún Map suelto haciendo de caché de PCM', () => {
    expect(file).not.toContain('new Map<string, Channels>()');
    expect(file).toContain('createUiAudioCache<Channels>({');
  });

  it('la crea con el tope de la política, no con un número escrito a mano', () => {
    const call = file.slice(file.indexOf('createUiAudioCache<Channels>({'));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toContain('capacity: AUDIO_EDITOR_PCM_ENTRIES');
    expect(args).toMatch(/bytesOf:.*length \+ .*length\) \* 4/s);
  });

  it('loadChannels comparte la función de clave, no una copia de la plantilla', () => {
    expect(file).toContain('const key = sampleCacheKey(sample.id, sample.hash);');
    // La plantilla `id:hash` escrita a mano, que es de lo que se salió.
    expect(file).not.toMatch(/\$\{sample\.id\}:\$\{sample\.hash\}/);
  });
});

// ── Las cuatro puertas que reemplazan el proyecto entero ────────────────────

describe('el barrido cuelga de "cambió el mundo", no de "se exportó"', () => {
  it('rehydrateSamples() —abrir .orbit, plantilla, autosave y restaurar versión— llama a collectWorkletSamples', () => {
    const soundActions = readSource('browser/sound-actions.ts');
    expect(soundActions).toContain('collectWorkletSamples(engine, store.project);');

    // Las cuatro puertas pasan por rehydrateSamples: si alguna dejara de
    // hacerlo, este test lo dice antes de que se note como memoria.
    expect(readSource('state/project-file.ts')).toContain('rehydrateSamples()');
    expect(readSource('state/versions.ts')).toContain('rehydrateSamples()');
    expect(readSource('state/autosave.ts')).toContain('rehydrateSamples()');
  });

  it('newProject() —que no rehidrata nada— recolecta por su cuenta', () => {
    const file = readSource('state/project-file.ts');
    const at = file.indexOf('export function newProject()');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = file.slice(at, file.indexOf('\n}', at));
    expect(body).toContain('collectWorkletSamples(engine, store.project)');
  });

  it('el barrido de las cachés de UI vive dentro de collectWorkletSamples, no en cada llamante', () => {
    const file = readSource('state/sample-gc.ts');
    const at = file.indexOf('export function collectWorkletSamples(');
    const body = file.slice(at, file.indexOf('\n}', at));
    expect(body).toContain('collectUiAudioCaches(project)');
    // Antes del retorno temprano por motor sin `keepOnlySamples`.
    expect(body.indexOf('collectUiAudioCaches(project)')).toBeLessThan(
      body.indexOf("typeof engine.keepOnlySamples !== 'function'"),
    );
  });
});
