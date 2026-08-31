/**
 * La quinta puerta: entrar en una sala REEMPLAZA el proyecto entero.
 *
 * La v3.9 colgó el barrido de las cachés de audio de `collectWorkletSamples` y
 * lo cableó a las cinco puertas que reemplazan el proyecto entero —abrir un
 * `.orbit` o un reciente, cargar plantilla, restaurar versión, recuperar
 * autosave y «Proyecto nuevo»—. Faltaba una sexta:
 * `CommandLogBinding.join()` y `.replay()`
 * (`collab/command-log.ts`) también hacen `store.replaceProject()`, avisan por
 * `onProjectReplaced`, y el único que escuchaba —`collab-state.ts`— solo subía
 * al kernel lo que hacía falta. Nunca barría. El audio del proyecto anterior se
 * quedaba en el worklet y en las tres cachés del renderer hasta cerrar la app,
 * y el `replay()` de un merge cruzado puede pasar varias veces por sesión.
 *
 * Aquí se prueba el escenario de verdad —proyecto A con samples, la sala manda
 * el proyecto B, `syncSamplesAfterProjectReplaced`— y las tres cosas que no
 * pueden salir mal:
 *
 * 1. Las cachés y el kernel quedan con lo de B y sin lo de A.
 * 2. **El orden**: primero sube lo que B necesita, DESPUÉS barre. El barrido
 *    no puede deshacer lo que la sincronización acaba de hacer.
 * 3. **Lo que otro colaborador todavía necesita no se va con esto**: lo suyo
 *    son los bytes publicados en la sala, que el barrido no toca ni puede.
 *
 * Y la trampa que el arreglo mismo abre: soltar en el kernel sin podar el
 * `loadedIds` de `sample-sync` dejaría el sample MUDO y ni siquiera contado
 * como ausente.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createEmptyProject, type Project, type SampleRef } from '@orbit/core';
import type { CollabSession } from '@orbit/collab';
import type { ToKernel } from '@orbit/engine';
import { readSource } from './read-source';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Lo que guarda una caché de audio decodificado del renderer. */
interface Channels {
  left: Float32Array;
  right: Float32Array;
}

const RATE = 48000;
/** Un segundo estéreo a 48 kHz: 48000 × 2 × 4 = 384 000 bytes por entrada. */
const BYTES_PER_ENTRY = RATE * 2 * 4;

function pcm(): Channels {
  return { left: new Float32Array(RATE), right: new Float32Array(RATE) };
}

const bytesOf = (ch: Channels): number => (ch.left.length + ch.right.length) * 4;

function ref(id: string, hash: string): SampleRef {
  return { id, name: id, path: `recording:${id}.wav`, hash, duration: 1 };
}

/** Proyecto que registra esos samples por el camino de verdad (`applyCommand`). */
function projectWith(name: string, refs: SampleRef[]): Project {
  const project = createEmptyProject(name);
  for (const sample of refs) applyCommand(project, { type: 'registerSample', sample });
  return project;
}

/** La sala: un `Y.Map` 'assets' de mentira, indexado por hash como el de verdad. */
function fakeRoom() {
  const assets = new Map<string, Uint8Array>();
  const session = {
    hasSample: (hash: string) => assets.has(hash),
    getSample: (hash: string) => assets.get(hash) ?? null,
    publishSample: (bytes: Uint8Array, meta: { hash: string; name: string }) => {
      if (assets.has(meta.hash)) return 'duplicate';
      assets.set(meta.hash, bytes.slice());
      return 'published';
    },
  };
  return { assets, session: session as unknown as CollabSession };
}

function isCollect(msg: ToKernel): msg is Extract<ToKernel, { type: 'collectSamples' }> {
  return msg.type === 'collectSamples';
}

/**
 * Monta `sample-sync` sobre un kernel y un store de mentira.
 *
 * `store.project` es reasignable a propósito: eso es lo que hace
 * `store.replaceProject(B)` desde el punto de vista de este módulo.
 */
async function setup(project: Project, onDisk: readonly string[] = []) {
  vi.resetModules();

  /** El orden real de los eventos del kernel, que es medio test por sí solo. */
  const trace: string[] = [];
  const sent: ToKernel[] = [];
  const loaded: string[] = [];
  const forgotten: string[][] = [];
  const store = { project };
  const engine = {
    async loadSample(id: string): Promise<number> {
      trace.push(`sube:${id}`);
      loaded.push(id);
      return 1;
    },
    send(msg: ToKernel): void {
      if (isCollect(msg)) trace.push('suelta-worklet');
      sent.push(msg);
    },
    keepOnlySamples(keep: readonly string[]): void {
      trace.push('olvida-cache-motor');
      forgotten.push([...keep]);
    },
  };

  const disk = new Set<string>(onDisk);
  vi.doMock('../src/state/app', () => ({ engine, store }));
  vi.doMock('../src/browser/sound-actions', () => ({
    readSampleBytes: async (path: string) => (disk.has(path) ? new ArrayBuffer(8) : null),
  }));

  const gc = await import('../src/state/sample-gc');
  const sync = await import('../src/collab/sample-sync');

  /** Las tres cachés del renderer, con la misma forma que las de verdad. */
  const render = gc.createUiAudioCache<Channels>({ name: 'render', bytesOf });
  const peaks = gc.createUiAudioCache<Channels>({ name: 'peaks', bytesOf });
  const editor = gc.createUiAudioCache<Channels>({
    name: 'editor-pcm',
    capacity: gc.AUDIO_EDITOR_PCM_ENTRIES,
    bytesOf,
  });
  const caches = { render, peaks, editor };

  const fill = (sample: SampleRef): void => {
    for (const cache of Object.values(caches)) {
      cache.set(gc.sampleCacheKey(sample.id, sample.hash), pcm());
    }
  };
  const cached = (sample: SampleRef): boolean[] =>
    Object.values(caches).map((cache) => cache.has(gc.sampleCacheKey(sample.id, sample.hash)));

  const lastKeep = (): string[] => {
    const collects = sent.filter(isCollect);
    const last = collects[collects.length - 1];
    return last ? [...last.keep].sort() : [];
  };

  return { trace, sent, loaded, forgotten, store, engine, disk, gc, sync, caches, fill, cached, lastKeep };
}

afterEach(() => {
  vi.doUnmock('../src/state/app');
  vi.doUnmock('../src/browser/sound-actions');
  vi.restoreAllMocks();
});

// ── 1. El escenario A → B por la vía de collab ──────────────────────────────

describe('la sala reemplaza el proyecto: las cachés quedan con lo de B', () => {
  it('suelta el audio de A en los dos hilos y conserva el de B', async () => {
    const a1 = ref('a1', 'ha1');
    const a2 = ref('a2', 'ha2');
    const b1 = ref('b1', 'hb1');
    const h = await setup(projectWith('A', [a1, a2]), [a1.path, a2.path]);
    const room = fakeRoom();

    // Proyecto A abierto y sonando: el kernel tiene sus samples y las tres
    // cachés del renderer, su audio decodificado.
    await h.sync.syncSamplesWithRoom(room.session);
    h.fill(a1);
    h.fill(a2);
    expect(h.loaded).toEqual(['a1', 'a2']);
    expect(h.caches.render.stats()).toEqual({ entries: 2, bytes: 2 * BYTES_PER_ENTRY });

    // La sala manda: join() aplica el snapshot y hace replaceProject(B). B trae
    // un sample que aquí no está en disco; sus bytes vienen de la sala.
    h.store.project = projectWith('B', [b1]);
    room.assets.set(b1.hash, new Uint8Array(8));
    // Y el renderer repinta B mientras tanto (la playlist dibuja sus clips):
    // por eso hay entradas de B en las cachés antes de que nadie barra.
    h.fill(b1);

    await h.sync.syncSamplesAfterProjectReplaced(room.session);

    // El hilo de la UI: fuera lo de A, dentro lo de B.
    expect(h.cached(a1)).toEqual([false, false, false]);
    expect(h.cached(a2)).toEqual([false, false, false]);
    expect(h.cached(b1)).toEqual([true, true, true]);
    for (const cache of Object.values(h.caches)) {
      expect(cache.stats()).toEqual({ entries: 1, bytes: BYTES_PER_ENTRY });
    }

    // El hilo de audio: al worklet se le pide que suelte todo lo que no sea B,
    // y la caché del AudioEngine se vacía con él (si no, el próximo
    // `loadSample` devolvería la duración cacheada y no subiría el audio).
    expect(h.lastKeep()).toEqual(['b1']);
    expect(h.forgotten.at(-1)).toEqual(['b1']);
    // Y el sample de B llegó de verdad al kernel, que era la mitad que ya
    // funcionaba y que no se puede haber roto por el camino.
    expect(h.loaded).toEqual(['a1', 'a2', 'b1']);
  });

  it('sin proyecto que reemplace no barre nada: `syncSamplesWithRoom` a secas no toca el kernel', async () => {
    // La misma pasada por la vía normal (un registerSample nuevo, un asset que
    // llega, crear una sala) NO puede barrer: ahí nadie reemplazó el proyecto.
    const a1 = ref('a1', 'ha1');
    const h = await setup(projectWith('A', [a1]), [a1.path]);
    const room = fakeRoom();

    h.fill(a1);
    await h.sync.syncSamplesWithRoom(room.session);

    expect(h.sent.filter(isCollect)).toHaveLength(0);
    expect(h.forgotten).toHaveLength(0);
    expect(h.cached(a1)).toEqual([true, true, true]);
  });
});

// ── 2. El orden: subir primero, barrer después ──────────────────────────────

describe('el orden respecto de syncSamplesWithRoom', () => {
  it('primero sube lo que B necesita y solo entonces suelta', async () => {
    const b1 = ref('b1', 'hb1');
    const b2 = ref('b2', 'hb2');
    const h = await setup(projectWith('B', [b1, b2]), [b1.path, b2.path]);
    const room = fakeRoom();

    await h.sync.syncSamplesAfterProjectReplaced(room.session);

    // La traza completa, en orden: las dos subidas y DESPUÉS el barrido (que
    // son dos mensajes, olvidar la caché del motor y soltar en el worklet).
    // Al revés habría una ventana en la que el kernel no tiene ni lo viejo ni
    // lo nuevo, y lo que se oye en esa ventana es silencio.
    expect(h.trace).toEqual(['sube:b1', 'sube:b2', 'olvida-cache-motor', 'suelta-worklet']);
  });

  it('el barrido no puede deshacer lo que la sincronización acaba de subir', async () => {
    // El invariante del que sale la decisión: `pass()` solo sube ids que están
    // en `store.project.samples`, y el `keep` del barrido —con `keepRegistered`,
    // el valor por defecto— contiene TODO lo registrado. Barrer después es, por
    // construcción, incapaz de tirar lo recién subido.
    const refs = ['b1', 'b2', 'b3'].map((id) => ref(id, `h${id}`));
    const h = await setup(
      projectWith('B', refs),
      refs.map((r) => r.path),
    );
    const room = fakeRoom();

    await h.sync.syncSamplesAfterProjectReplaced(room.session);

    for (const id of h.loaded) expect(h.lastKeep()).toContain(id);
  });

  it('la fuente lo dice igual: el barrido va después del await, no antes', () => {
    const file = readSource('collab/sample-sync.ts');
    const at = file.indexOf('export async function syncSamplesAfterProjectReplaced(');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = file.slice(at, file.indexOf('\n}', at));
    expect(body).toContain('await syncSamplesWithRoom(session)');
    expect(body).toContain('collectWorkletSamples(engine, store.project)');
    expect(body.indexOf('await syncSamplesWithRoom(session)')).toBeLessThan(
      body.indexOf('collectWorkletSamples(engine, store.project)'),
    );
  });

  it('salir de la sala a mitad de la pasada cancela el barrido', async () => {
    // `resetSampleSync()` sube la generación. Barrer después de eso sería
    // calcular el `keep` contra un proyecto que ya no es de esta sesión.
    const a1 = ref('a1', 'ha1');
    const h = await setup(projectWith('A', [a1]), [a1.path]);
    const room = fakeRoom();

    const inFlight = h.sync.syncSamplesAfterProjectReplaced(room.session);
    h.sync.resetSampleSync(); // leaveRoom() mientras la pasada estaba en el aire
    await inFlight;

    expect(h.sent.filter(isCollect)).toHaveLength(0);
    expect(h.forgotten).toHaveLength(0);
  });
});

// ── 3. Lo que otro colaborador todavía puede necesitar ──────────────────────

describe('un sample que el proyecto local ya no nombra pero la sala sí', () => {
  it('el barrido suelta nuestra copia y NO toca lo publicado en la sala', async () => {
    const a1 = ref('a1', 'ha1');
    const b1 = ref('b1', 'hb1');
    const h = await setup(projectWith('A', [a1]), [a1.path]);
    const room = fakeRoom();

    // Trabajando en A publicamos sus bytes en la sala (por hash): eso es lo que
    // hace que a los demás les SUENE nuestro sonido.
    await h.sync.syncSamplesWithRoom(room.session);
    expect(room.session.hasSample(a1.hash)).toBe(true);

    // Ahora la sala nos re-deriva a B, que ya no nombra a1.
    h.store.project = projectWith('B', [b1]);
    room.assets.set(b1.hash, new Uint8Array(8));
    await h.sync.syncSamplesAfterProjectReplaced(room.session);

    // Nuestra copia local se fue (es lo que se venía a arreglar)…
    expect(h.lastKeep()).toEqual(['b1']);
    // …pero lo que el otro necesita son los BYTES DE LA SALA, y ahí siguen: el
    // barrido mira el worklet, la caché del AudioEngine y las del renderer, y
    // ninguna de las tres es el `Y.Map` 'assets'. Un peer que deshaga hasta
    // volver a nombrar a1 lo sigue sacando con getSample(hash).
    expect(room.session.hasSample(a1.hash)).toBe(true);
    expect(room.session.getSample(a1.hash)).not.toBeNull();
  });

  it('barrer no reduce lo que podemos publicar: se publica desde el disco, no desde el kernel', async () => {
    const a1 = ref('a1', 'ha1');
    const h = await setup(projectWith('A', [a1]), [a1.path]);
    const room = fakeRoom();

    // Se barre ANTES de publicar nada (el proyecto pasa a estar vacío y vuelve).
    h.store.project = createEmptyProject('vacío');
    await h.sync.syncSamplesAfterProjectReplaced(room.session);
    expect(h.lastKeep()).toEqual([]);

    // a1 vuelve al proyecto: se lee del disco y se publica igual.
    h.store.project = projectWith('A otra vez', [a1]);
    await h.sync.syncSamplesAfterProjectReplaced(room.session);
    expect(room.session.hasSample(a1.hash)).toBe(true);
  });
});

// ── La trampa que abre el propio arreglo: mudo y sin decirlo ────────────────

describe('podar loadedIds con el keep que recibió el kernel', () => {
  it('un sample que vuelve tras el barrido se vuelve a subir (no se queda mudo)', async () => {
    const a1 = ref('a1', 'ha1');
    const b1 = ref('b1', 'hb1');
    const h = await setup(projectWith('A', [a1]), [a1.path]);
    const room = fakeRoom();

    await h.sync.syncSamplesWithRoom(room.session);
    expect(h.loaded).toEqual(['a1']);

    // replay() nº 1: la sala re-deriva a B y el barrido suelta a1 del kernel.
    h.store.project = projectWith('B', [b1]);
    room.assets.set(b1.hash, new Uint8Array(8));
    await h.sync.syncSamplesAfterProjectReplaced(room.session);
    expect(h.lastKeep()).toEqual(['b1']);

    // replay() nº 2 (otro merge cruzado, o el undo de un peer): a1 vuelve a
    // estar en el proyecto. Sin podar `loadedIds`, la pasada haría `continue`
    // sobre él —"eso ya está arriba"— y el sample sonaría a NADA sin salir
    // siquiera en `missing`: el fallo silencioso que documenta keepOnlySamples.
    h.store.project = projectWith('A otra vez', [a1]);
    const report = await h.sync.syncSamplesAfterProjectReplaced(room.session);

    expect(h.loaded).toEqual(['a1', 'b1', 'a1']);
    expect(report.missing).toEqual([]);
    expect(h.lastKeep()).toEqual(['a1']);
  });

  it('lo que el kernel SÍ conserva no se re-sube por gusto', async () => {
    // La otra cara: podar de más costaría una relectura de disco y una subida
    // por cada barrido. `keep` es la lista exacta, no una aproximación.
    const a1 = ref('a1', 'ha1');
    const a2 = ref('a2', 'ha2');
    const h = await setup(projectWith('A', [a1, a2]), [a1.path, a2.path]);
    const room = fakeRoom();

    await h.sync.syncSamplesWithRoom(room.session);
    expect(h.loaded).toEqual(['a1', 'a2']);

    // El proyecto nuevo comparte a1 y suelta a2.
    h.store.project = projectWith('A′', [a1]);
    await h.sync.syncSamplesAfterProjectReplaced(room.session);
    await h.sync.syncSamplesAfterProjectReplaced(room.session);

    expect(h.loaded).toEqual(['a1', 'a2']);
  });
});

// ── Que la vía de collab de verdad use la variante que barre ────────────────

describe('collab-state.ts cablea el barrido donde toca (y solo donde toca)', () => {
  const file = readSource('collab/collab-state.ts');

  it('onProjectReplaced —join() y replay()— usa la variante que barre', () => {
    const at = file.indexOf('onProjectReplaced: () => {');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = file.slice(at, file.indexOf('\n    },', at));
    expect(body).toContain('runSampleSync(s, syncSamplesAfterProjectReplaced)');
  });

  it('onAsset NO barre: un asset que llega AÑADE, no reemplaza el proyecto', () => {
    const at = file.indexOf('onAsset: () => {');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = file.slice(at, file.indexOf('\n    },', at));
    expect(body).toContain('runSampleSync(s);');
    expect(body).not.toContain('syncSamplesAfterProjectReplaced');
  });

  it('crear una sala tampoco barre: ahí el proyecto abierto es el del usuario', () => {
    const at = file.indexOf('sampleSetChanged();');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = file.slice(at, at + 200);
    expect(body).toContain('runSampleSync(s);');
    expect(body).not.toContain('syncSamplesAfterProjectReplaced');
  });

  it('el comentario del listener cuenta las DOS mitades, no solo llenar', () => {
    const at = file.indexOf('onProjectReplaced: () => {');
    const comment = file.slice(file.lastIndexOf('// Unirse o re-derivar', at), at);
    expect(comment).toMatch(/LLENAR/);
    expect(comment).toMatch(/VACIAR/);
  });
});
