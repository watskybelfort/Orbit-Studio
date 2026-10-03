/**
 * El barrido de DISCO del renderer, por su dos puntas:
 *
 * 1. El contrato de `sweepRecordingFiles` con el almacén: con capacidad
 *    (`discard`) devuelve `sent: true` y la lista que pidió; sin ella,
 *    `sent: false` con motivo — mejor no recuperar disco que recuperarlo mal.
 * 2. El cableado ANTES de que el proyecto se sustituya, que es donde vive la
 *    dificultad: la decisión tiene que mirar el proyecto y el historial que se
 *    VAN, no los que llegan (si mirara el nuevo, todo se vería abandonado y se
    tiraría audio que el `.orbit` guardado sigue nombrando). Se prueba contra
 *    el `ProjectStore` de verdad y el hook real que instala `state/app` (la
 *    política, en `sample-gc.ts`), sin montar la UI.
 *
 * Y el borde de la confirmación tardía: el almacén responde por IPC, o sea
 * DESPUÉS de que el proyecto ya se sustituyó y de que el libro se haya
 * olvidado; si la respuesta pudiera borrar por clave, se llevaría por delante
 * una escritura NUEVA del proyecto entrante que cayó en el mismo nombre de
 * archivo (nombres por contenido: la misma edición repetida).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Arnés: store y sample-gc de verdad, y `window.orbit.recording.discard` con
 * una promesa que el test controla (la confirmación tardía, literal).
 */
async function rig() {
  vi.resetModules();
  let pedido: string[] | null = null;
  let resolver: (ok: readonly string[]) => void = () => undefined;
  vi.stubGlobal('window', {
    orbit: {
      recording: {
        save: async (name: string) => name,
        read: async () => new ArrayBuffer(8),
        discard: (files: readonly string[]) => {
          pedido = [...files];
          return new Promise<readonly string[]>((r) => (resolver = r));
        },
      },
      settings: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('navigator', {});

  const core = await import('@orbit/core');
  // `state/app` instala el hook del barrido al crearse (ver `sample-gc.ts`).
  const app = await import('../src/state/app');
  vi.spyOn(app.engine, 'init').mockResolvedValue(undefined);
  const gc = await import('../src/state/sample-gc');

  return {
    core,
    store: app.store,
    gc,
    pedido: () => pedido,
    resolverDescarte: (ok: readonly string[]) => resolver(ok),
  };
}

function ref(id: string, path: string) {
  return { id, name: id, path, hash: id, duration: 1 };
}

describe('sweepRecordingFiles: el contrato con el almacén', () => {
  it('con discard devuelve sent: true, la lista correcta y poda el libro', async () => {
    const { core, gc } = await rig();
    gc.noteRecordingWritten({ sampleId: 's1', path: 'recording:a.wav', bytes: 10 });
    gc.noteRecordingWritten({ sampleId: 's2', path: 'recording:b.wav', bytes: 20 });
    const pedidos: string[][] = [];
    const result = await gc.sweepRecordingFiles(
      {
        project: core.createEmptyProject('X'),
        unreachableIds: (ids) => [...ids],
      },
      { discard: async (files) => (pedidos.push([...files]), files) },
    );

    expect(result.sent).toBe(true);
    expect(pedidos).toEqual([['a.wav', 'b.wav']]);
    expect(result.discarded.sort()).toEqual(['a.wav', 'b.wav']);
    expect(gc.recordingLedgerEntries()).toEqual([]);
  });

  it('sin discard devuelve sent: false con motivo, y no toca el libro', async () => {
    const { core, gc } = await rig();
    gc.noteRecordingWritten({ sampleId: 's1', path: 'recording:a.wav', bytes: 10 });

    const result = await gc.sweepRecordingFiles(
      {
        project: core.createEmptyProject('X'),
        unreachableIds: (ids) => [...ids],
      },
      {},
    );

    expect(result.sent).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(gc.recordingLedgerEntries()).toHaveLength(1);
  });
});

describe('el barrido va ANTES de que el proyecto se sustituya', () => {
  it('la decisión mira el proyecto que SE VA: lo que él nombra no se descarta', async () => {
    const r = await rig();
    const viejo = r.core.createEmptyProject('Viejo');
    r.store.replaceProject(viejo); // el proyecto que va a ser sustituido
    gc_note(r, 's1', 'recording:viva.wav');
    r.core.applyCommand(viejo, {
      type: 'registerSample',
      sample: ref('s1', 'recording:viva.wav'),
    });

    r.store.replaceProject(r.core.createEmptyProject('Nuevo'));

    // El proyecto viejo nombraba el archivo: se conserva, y como no hay nada
    // que reclamar ni se le pide nada al almacén. Si la decisión se tomara
    // contra el proyecto NUEVO (vacío), el archivo se vería abandonado y aquí
    // se pediría descartarlo — `pedido()` sería ['viva.wav'] en vez de null.
    expect(r.pedido()).toBeNull();
  });

  it('una confirmación tardía no olvida una escritura nueva del proyecto entrante', async () => {
    const r = await rig();
    gc_note(r, 's1', 'recording:F.wav');

    // La sustitución dispara el barrido: decide con el mundo viejo (aquí, todo
    // reclamable) y manda la petición… que queda PENDIENTE de confirmación.
    r.store.replaceProject(r.core.createEmptyProject('Nuevo'));
    expect(r.pedido()).toEqual(['F.wav']);

    // Llega una escritura NUEVA del proyecto entrante con el mismo nombre de
    // archivo (nombres por contenido: la misma edición repetida cae en el
    // mismo archivo)…
    gc_note(r, 's2', 'recording:F.wav');

    // …y entonces se resuelve la confirmación de la generación anterior.
    r.resolverDescarte(['F.wav']);
    await new Promise((done) => setTimeout(done, 0));

    // El libro nuevo se conserva: la poda es por IDENTIDAD de la entrada que
    // se planificó, no por clave.
    const libro = r.gc.recordingLedgerEntries();
    expect(libro).toHaveLength(1);
    expect(libro[0]!.file).toBe('F.wav');
    expect(libro[0]!.sampleIds).toEqual(['s2']);
  });
});

/** Anota una escritura de esta sesión en el libro del barrido. */
function gc_note(r: { gc: typeof import('../src/state/sample-gc') }, sampleId: string, path: string) {
  r.gc.noteRecordingWritten({ sampleId, path, bytes: 64 });
}
