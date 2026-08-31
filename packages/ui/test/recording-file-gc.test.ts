/**
 * La otra mitad de la fuga de la v3.9: el `.wav` que cada Normalizar / Reverse
 * / Fade / Afinar deja en la carpeta de grabaciones y que no borra nadie.
 *
 * Aquí se prueba la política de DISCO de `state/sample-gc.ts`, y el orden de
 * los tests no es casual: el primero es el que evita el desastre. Soltar una
 * entrada de un `Map` cuesta una relectura; dar de baja un archivo que todavía
 * puede volver por un Ctrl+Z le cuesta al usuario audio de verdad, y no hay
 * undo que lo traiga. Por eso lo primero que se afirma no es que libere, sino
 * que NO libere:
 *
 *  1. Un archivo que un undo/redo puede volver a nombrar se conserva —incluso
 *     cuando el proyecto ya no lo nombra, que es justo cuando un GC ingenuo
 *     por «lo que el proyecto registra» lo daría por muerto.
 *  2. Y si ese redo se abandonó y quedó archivado como RAMA del historial,
 *     también: la respuesta la da `ProjectStore.unreachableIds`, que ya mira
 *     las ramas, y por eso no se reinventó aquí.
 *  3. Un sample SUJETO (`withPinnedSample`) está vivo por definición: es el que
 *     se está creando ahora mismo.
 *  4. Lo que sí se reclama: el archivo de una operación que reventó a mitad
 *     —nada llegó a nombrarlo nunca— y el del sample cuya entrada ya se cayó
 *     del historial de verdad.
 *  5. Sin capacidad de baja en el almacén, no se manda nada (mismo criterio que
 *     `keepOnlySamples` en el kernel: mejor no recuperar que recuperar mal), y
 *     el libro solo se poda con lo que el almacén CONFIRMÓ.
 *
 * Contra un `ProjectStore` de verdad, no contra un mock: la mitad difícil del
 * test es el historial, y un historial de mentira no probaría nada.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clip, ProjectStore, SampleRef } from '@orbit/core';
import { readSource } from './read-source';

/** Un clip de audio de 30 s: el "clip largo" del reporte. */
const TAKE: SampleRef = {
  id: 'toma',
  name: 'toma',
  path: 'recording:Toma 1.wav',
  hash: 'h-toma',
  duration: 30,
};

/** Bytes de un .wav estéreo de 30 s a 48 kHz y 24 bits (44 + 30·48000·2·3). */
const WAV_BYTES = 44 + 30 * 48000 * 2 * 3;

type Gc = typeof import('../src/state/sample-gc');

async function freshRig() {
  vi.resetModules();
  const core = await import('@orbit/core');
  const gc: Gc = await import('../src/state/sample-gc');
  const store = new core.ProjectStore();

  store.dispatch({ type: 'registerSample', sample: TAKE });
  const playlistTrackId = Object.keys(store.project.playlistTracks)[0]!;
  const clipId = core.newId();
  const clip: Clip = {
    id: clipId,
    kind: 'audio',
    playlistTrackId,
    start: 0,
    length: 16,
    muted: false,
    sampleId: TAKE.id,
  };
  store.dispatch({ type: 'addClips', clips: [clip] });

  /** Lo que `reclaimableRecordings` necesita del mundo. */
  const deps = () => ({
    project: store.project,
    unreachableIds: (ids: Iterable<string>) => store.unreachableIds(ids),
  });
  return { core, gc, store, clipId, deps };
}

type Rig = Awaited<ReturnType<typeof freshRig>>;

/**
 * Una operación destructiva del editor, en el mismo orden que `runOp`: escribe
 * el archivo, lo ANOTA, y solo entonces registra el sample y repunta el clip.
 */
function runOpLikeEditor(rig: Rig, opts: { n: number; contenido?: string }): {
  sampleId: string;
  file: string;
} {
  const hash = `h-${opts.contenido ?? opts.n}`;
  const file = `Normalizar ${hash}.wav`;
  const path = `recording:${file}`;
  const sampleId = `edit-${opts.n}`;
  rig.gc.noteRecordingWritten({ sampleId, path, bytes: WAV_BYTES });
  const label = `Normalizar "toma"`;
  rig.store.dispatch(
    {
      type: 'batch',
      label,
      commands: [
        {
          type: 'registerSample',
          sample: { id: sampleId, name: sampleId, path, hash, duration: 30 },
        },
        { type: 'patchClips', patches: [{ id: rig.clipId, sampleId }] },
      ],
    },
    { label },
  );
  return { sampleId, file };
}

/** Empuja `n` cambios triviales para que las entradas viejas se caigan del tope de 500. */
function envejecerHistorial(store: ProjectStore, n: number): void {
  for (let i = 0; i < n; i++) store.dispatch({ type: 'setTempo', tempo: 90 + (i % 40) });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 1. El test que evita el desastre ────────────────────────────────────────

describe('un archivo que todavía puede volver por un undo NO se da de baja', () => {
  it('tras Normalizar + Ctrl+Z el proyecto ya no lo nombra, y aun así se conserva', async () => {
    const rig = await freshRig();
    const { file, sampleId } = runOpLikeEditor(rig, { n: 1 });

    // Ctrl+Z: el inverso del batch desregistra el sample y devuelve el clip a
    // la toma original. A partir de aquí `project.samples` NO lo nombra — que
    // es exactamente el estado en el que un GC por "lo que el proyecto
    // registra" (la cota correcta para la MEMORIA) daría el archivo por muerto.
    expect(rig.store.undo()).toBe(true);
    expect(rig.store.project.samples[sampleId]).toBeUndefined();
    expect(rig.store.project.clips[rig.clipId]!.sampleId).toBe(TAKE.id);

    const plan = rig.gc.reclaimableRecordings(rig.deps());
    expect(plan.reclaim).toEqual([]);
    expect(plan.bytes).toBe(0);
    expect(plan.keep).toHaveLength(1);
    expect(plan.keep[0]!.entry.file).toBe(file);
    expect(plan.keep[0]!.reason).toMatch(/undo, un redo o una rama archivada/);

    // Y el motivo por el que importa: el redo lo devuelve, y el archivo tiene
    // que seguir ahí para que el clip suene.
    expect(rig.store.redo()).toBe(true);
    expect(rig.store.project.samples[sampleId]!.path).toBe(`recording:${file}`);
    expect(rig.store.project.clips[rig.clipId]!.sampleId).toBe(sampleId);
  });

  it('lo mismo con los cuatro intermedios de cinco Normalizar seguidos', async () => {
    const rig = await freshRig();
    for (let n = 1; n <= 5; n++) runOpLikeEditor(rig, { n, contenido: `c${n}` });
    expect(rig.gc.recordingLedgerStats()).toEqual({ files: 5, bytes: 5 * WAV_BYTES });

    // Cinco pasos atrás disponibles: ni uno solo de los cinco archivos es
    // reclamable, y da igual cuántos undos se hayan hecho ya.
    for (let deshechos = 0; deshechos <= 5; deshechos++) {
      const plan = rig.gc.reclaimableRecordings(rig.deps());
      expect(plan.reclaim).toEqual([]);
      expect(plan.keep).toHaveLength(5);
      if (deshechos < 5) expect(rig.store.undo()).toBe(true);
    }
  });

  it('el que el proyecto SÍ nombra se conserva por su propio motivo, no por el historial', async () => {
    const rig = await freshRig();
    const { file } = runOpLikeEditor(rig, { n: 1 });
    const plan = rig.gc.reclaimableRecordings(rig.deps());
    expect(plan.reclaim).toEqual([]);
    expect(plan.keep[0]!.entry.file).toBe(file);
    expect(plan.keep[0]!.reason).toBe('el proyecto lo nombra');
  });
});

// ── 2. La rama archivada: la política de memoria dice "conserva"; en disco, más ─

describe('un archivo vivo en una rama ARCHIVADA del historial se conserva', () => {
  it('el redo abandonado se guarda como rama, y la rama sigue nombrando el archivo', async () => {
    const rig = await freshRig();
    const { file, sampleId } = runOpLikeEditor(rig, { n: 1 });

    // Ctrl+Z y luego otra cosa: el futuro que quedaba pendiente no se tira, se
    // ARCHIVA como rama (`history-tree.ts`), así que el usuario puede volver.
    expect(rig.store.undo()).toBe(true);
    rig.store.dispatch({ type: 'setTempo', tempo: 142 }, { label: 'Tempo' });

    const tree = rig.store.historyTree();
    expect(tree.branches).toHaveLength(1);
    expect(tree.branches[0]!.reachable).toBe(true);
    // Ya no está ni en el proyecto ni en el redo: SOLO en la rama.
    expect(rig.store.project.samples[sampleId]).toBeUndefined();
    expect(rig.store.redo()).toBe(false);

    const plan = rig.gc.reclaimableRecordings(rig.deps());
    expect(plan.reclaim).toEqual([]);
    expect(plan.keep[0]!.entry.file).toBe(file);
    expect(plan.keep[0]!.reason).toMatch(/rama archivada/);

    // Y volver a la rama devuelve el sample entero, archivo incluido.
    expect(rig.store.switchToBranch(tree.branches[0]!.id)).toBeGreaterThan(0);
    expect(rig.store.project.samples[sampleId]!.path).toBe(`recording:${file}`);
  });

  it('la respuesta la da unreachableIds, no una copia de la regla en este módulo', () => {
    // La razón de que las ramas salgan gratis: el módulo no sabe qué es una
    // rama. Si alguien reimplementara "vivo" aquí dentro, las ramas volverían a
    // ser un caso que hay que acordarse de mirar.
    const file = readSource('state/sample-gc.ts');
    const at = file.indexOf('export function reclaimableRecordings(');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = file.slice(at, file.indexOf('\n}', at));
    expect(body).toContain('deps.unreachableIds(names)');
    expect(body).not.toMatch(/branch|undoStack|redoStack/);
  });
});

// ── 3. Sujeto = vivo por definición ─────────────────────────────────────────

describe('un sample sujeto está vivo: su archivo no se toca', () => {
  it('dentro de withPinnedSample no es reclamable, y al salir vuelve a decidirse', async () => {
    const rig = await freshRig();
    const path = 'recording:Normalizar h-vuelo.wav';
    rig.gc.noteRecordingWritten({ sampleId: 'en-vuelo', path, bytes: WAV_BYTES });

    // La ventana de `runOp`: el archivo ya está escrito y el sample todavía no
    // lo nombra nada del modelo. Sin el pin, esto sería reclamable justo
    // mientras se crea — se borraría el archivo del audio que se acaba de hacer.
    await rig.gc.withPinnedSample('en-vuelo', async () => {
      const plan = rig.gc.reclaimableRecordings(rig.deps());
      expect(plan.reclaim).toEqual([]);
      expect(plan.keep[0]!.reason).toMatch(/sujeto/);
    });

    // Fuera del pin y sin que nada lo haya registrado (la operación no llegó a
    // despachar): ahí sí sobra.
    expect(rig.gc.reclaimableRecordings(rig.deps()).reclaim.map((e) => e.path)).toEqual([path]);
  });
});

// ── 4. Lo que sí se reclama ─────────────────────────────────────────────────

describe('lo que sí se puede dar de baja', () => {
  it('el .wav de una operación que reventó a mitad: nada llegó a nombrarlo nunca', async () => {
    const rig = await freshRig();
    // `runOp` anota pegado al `recording.save`, ANTES del dispatch, justo para
    // que este caso sea reclamable en vez de invisible.
    rig.gc.noteRecordingWritten({
      sampleId: 'edit-roto',
      path: 'recording:Normalizar h-roto.wav',
      bytes: WAV_BYTES,
    });
    const plan = rig.gc.reclaimableRecordings(rig.deps());
    expect(plan.reclaim.map((e) => e.file)).toEqual(['Normalizar h-roto.wav']);
    expect(plan.bytes).toBe(WAV_BYTES);
  });

  it('el del sample cuya entrada de historial ya se cayó del tope de 500', async () => {
    const rig = await freshRig();
    const { file, sampleId } = runOpLikeEditor(rig, { n: 1 });

    // El sample deja de estar en uso y la sesión lo desregistra (lo que hace
    // `collectSessionSamples` cuando ya nadie lo nombra). Con eso todavía NO
    // basta: el inverso de ese mismo desregistro guarda el ref entero.
    rig.store.dispatch({ type: 'patchClips', patches: [{ id: rig.clipId, sampleId: TAKE.id }] });
    rig.store.dispatch({ type: 'unregisterSample', sampleId }, { origin: 'gc' });
    expect(rig.gc.reclaimableRecordings(rig.deps()).reclaim).toEqual([]);

    // Solo cuando esas entradas se caen del historial de verdad deja de haber
    // forma de volver, y entonces el archivo sobra.
    envejecerHistorial(rig.store, 501);
    expect(rig.store.unreachableIds([`recording:${file}`])).toEqual([`recording:${file}`]);
    expect(rig.gc.reclaimableRecordings(rig.deps()).reclaim.map((e) => e.file)).toEqual([file]);
  });
});

// ── 5. El barrido: qué se le pide al almacén, y qué se hace con la respuesta ─

describe('sweepRecordingFiles', () => {
  it('sin capacidad de baja en el almacén no se manda nada, y lo dice', async () => {
    const rig = await freshRig();
    rig.gc.noteRecordingWritten({
      sampleId: 'huerfano',
      path: 'recording:Normalizar h-x.wav',
      bytes: WAV_BYTES,
    });
    const sweep = await rig.gc.sweepRecordingFiles(rig.deps(), {});
    expect(sweep.sent).toBe(false);
    expect(sweep.reason).toBeTruthy();
    expect(sweep.discarded).toEqual([]);
    // Y el libro queda intacto: lo que no se pudo dar de baja se reintenta.
    expect(sweep.after).toEqual(sweep.before);
    expect(rig.gc.recordingLedgerStats().files).toBe(1);
  });

  it('da de baja solo lo reclamable y poda el libro con lo que el almacén CONFIRMÓ', async () => {
    const rig = await freshRig();
    // Uno vivo (lo nombra el proyecto) y dos huérfanos, de los que el almacén
    // solo consigue dar de baja uno.
    runOpLikeEditor(rig, { n: 1 });
    for (const n of [2, 3]) {
      rig.gc.noteRecordingWritten({
        sampleId: `roto-${n}`,
        path: `recording:Normalizar h-roto-${n}.wav`,
        bytes: WAV_BYTES,
      });
    }
    const pedidos: string[][] = [];
    const almacen = {
      discard: async (files: readonly string[]) => {
        pedidos.push([...files]);
        return files.slice(0, 1); // el otro falló (disco ocupado, permisos…)
      },
    };

    const sweep = await rig.gc.sweepRecordingFiles(rig.deps(), almacen);
    expect(sweep.sent).toBe(true);
    expect(pedidos[0]).toEqual([
      'Normalizar h-roto-2.wav',
      'Normalizar h-roto-3.wav',
    ]);
    expect(sweep.discarded).toEqual(['Normalizar h-roto-2.wav']);
    expect(sweep.before).toEqual({ files: 3, bytes: 3 * WAV_BYTES });
    expect(sweep.after).toEqual({ files: 2, bytes: 2 * WAV_BYTES });
    // El que falló sigue anotado (se reintenta), el vivo también.
    expect(rig.gc.recordingLedgerEntries().map((e) => e.file).sort()).toEqual([
      'Normalizar h-1.wav',
      'Normalizar h-roto-3.wav',
    ]);
    // Y el vivo se reportó con su motivo, no en silencio.
    expect(sweep.kept.map((k) => k.reason)).toContain('el proyecto lo nombra');
  });

  it('reemplazar el proyecto no barre: olvida, que es la respuesta conservadora', async () => {
    const rig = await freshRig();
    runOpLikeEditor(rig, { n: 1 });
    expect(rig.gc.recordingLedgerStats().files).toBe(1);
    // Sin el proyecto y su historial, la pregunta "¿sigue vivo?" no tiene
    // sujeto; sin respuesta, se conserva el archivo y se tira el libro.
    rig.gc.forgetRecordingLedger();
    expect(rig.gc.recordingLedgerStats()).toEqual({ files: 0, bytes: 0 });
    expect(rig.gc.reclaimableRecordings(rig.deps()).reclaim).toEqual([]);
  });

  it('el libro tiene tope, y desbordarlo olvida (nunca da de baja de más)', async () => {
    const rig = await freshRig();
    const { RECORDING_LEDGER_ENTRIES } = rig.gc;
    for (let i = 0; i < RECORDING_LEDGER_ENTRIES + 10; i++) {
      rig.gc.noteRecordingWritten({
        sampleId: `s-${i}`,
        path: `recording:Normalizar h-${i}.wav`,
        bytes: 1,
      });
    }
    expect(rig.gc.recordingLedgerStats().files).toBe(RECORDING_LEDGER_ENTRIES);
    // Se fueron los más VIEJOS, y "irse del libro" es dejar de ser candidato.
    const files = new Set(rig.gc.recordingLedgerEntries().map((e) => e.file));
    expect(files.has('Normalizar h-0.wav')).toBe(false);
    expect(files.has('Normalizar h-209.wav')).toBe(true);
  });

  it('el mismo archivo escrito por dos ediciones idénticas guarda los dos ids', async () => {
    const rig = await freshRig();
    // Normalizar, Ctrl+Z, Normalizar: mismos bytes → mismo nombre por
    // contenido → un solo archivo, pero dos `newId()` que lo nombran. La baja
    // tiene que exigir que los DOS estén muertos.
    const path = 'recording:Normalizar h-mismo.wav';
    rig.gc.noteRecordingWritten({ sampleId: 'edit-a', path, bytes: WAV_BYTES });
    rig.gc.noteRecordingWritten({ sampleId: 'edit-b', path, bytes: WAV_BYTES });
    const [entry] = rig.gc.recordingLedgerEntries();
    expect(entry!.sampleIds).toEqual(['edit-a', 'edit-b']);
    expect(rig.gc.recordingLedgerStats()).toEqual({ files: 1, bytes: WAV_BYTES });

    // Basta con que UNO de los dos siga vivo para conservar el archivo.
    rig.store.dispatch({
      type: 'registerSample',
      sample: { id: 'edit-b', name: 'b', path: 'recording:otro.wav', hash: 'h', duration: 1 },
    });
    expect(rig.gc.reclaimableRecordings(rig.deps()).reclaim).toEqual([]);
  });
});

// ── 6. Que el editor de verdad pase por ahí ─────────────────────────────────

describe('AudioEditor.tsx anota lo que escribe, y nombra por contenido', () => {
  const file = readSource('editors/audio/AudioEditor.tsx');

  it('las dos operaciones destructivas anotan el archivo que acaban de escribir', () => {
    expect(file.split('noteRecordingWritten(').length - 1).toBe(2);
    expect(file.split('recording.save(').length - 1).toBe(2);
  });

  it('la anotación va pegada al save y ANTES del dispatch que lo registra', () => {
    for (const trozo of file.split('recording.save(').slice(1)) {
      const anota = trozo.indexOf('noteRecordingWritten(');
      const registra = trozo.indexOf("type: 'registerSample'");
      expect(anota).toBeGreaterThanOrEqual(0);
      expect(registra).toBeGreaterThan(anota);
    }
  });

  it('anota los bytes de verdad del wav, no una estimación', () => {
    expect(file.split('bytes: wav.byteLength').length - 1).toBe(2);
  });

  it('el nombre del archivo sale del hash del contenido, no del reloj', () => {
    expect(file).toContain('function editFileName(');
    expect(file.split('editFileName(').length - 1).toBe(3); // la definición + los dos usos
    // El nombre por reloj era un borrado silencioso: `recording:save` pisa por
    // nombre, y `Edit 14.03.22.wav` de hoy pisaba el de ayer.
    expect(file).not.toContain('stamp.getHours()');
    expect(file).not.toMatch(/Edit \$\{/);
    // Y el hash se calcula ANTES del save, que es lo que hace posible el nombre.
    for (const trozo of file.split('recording.save(')) {
      expect(trozo).not.toMatch(/hash: \(await sha1Hex/);
    }
  });
});

// ── 7. El barrido de disco NO cuelga de la recolección de memoria ───────────

describe('la baja de archivos no va enganchada a collectWorkletSamples', () => {
  it('collectWorkletSamples sigue sin tocar disco (decisión 1 de la política)', () => {
    const file = readSource('state/sample-gc.ts');
    const at = file.indexOf('export function collectWorkletSamples(');
    const body = file.slice(at, file.indexOf('\n}', at));
    // Un `Map.delete` a mitad de sesión es gratis; una baja de archivo ahí
    // dentro la dispararía hasta un Ctrl+Z.
    expect(body).not.toContain('sweepRecordingFiles');
    expect(body).not.toContain('discard');
  });
});
