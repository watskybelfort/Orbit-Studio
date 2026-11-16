/**
 * El diario de la toma en curso (`main/recording-journal.ts`) contra una
 * carpeta temporal, sin Electron. Lo que se fija:
 *
 *  1. start/append/read/list: el PCM crudo vuelve igual, con sus frames.
 *  2. Un crash a mitad de append deja un frame partido: `read` recorta a
 *     frames enteros y al canal más corto.
 *  3. `finish` borra el diario; `list` deja de ofrecerlo.
 *  4. Las rutas y los ids no se salen de `.diario/`.
 *  5. La purga por antigüedad y el tope de tamaño de un append.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JOURNAL_DIR,
  JOURNAL_MAX_APPEND_BYTES,
  createRecordingJournal,
  parseJournalMeta,
  type JournalMeta,
} from '../src/main/recording-journal';

let dir = '';

const META: JournalMeta = {
  id: 'diario-0001',
  title: 'Canción',
  projectId: 'proj-1',
  arrangementId: 'arr-1',
  tempo: 120,
  sampleRate: 48000,
  start: 4,
  latency: 0,
  loop: { start: 0, end: 8 },
  routes: [
    { index: 0, name: 'Voz' },
    { index: 1, name: 'Guitarra' },
  ],
  startedAt: Date.now(),
};

function floats(values: number[]): Float32Array {
  return new Float32Array(values);
}
function bytes(samples: Float32Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orbit-diario-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('diario de toma', () => {
  it('guarda PCM por ruta y lo devuelve igual', async () => {
    const journal = createRecordingJournal(() => dir);
    await journal.start(META);
    await journal.append(META.id, 0, bytes(floats([0.1, 0.2, 0.3, 0.4])), bytes(floats([-0.1, -0.2, -0.3, -0.4])));
    await journal.append(META.id, 0, bytes(floats([0.5, 0.6])), bytes(floats([-0.5, -0.6])));
    await journal.append(META.id, 1, bytes(floats([1, 1])), bytes(floats([1, 1])));

    const read = await journal.read(META.id);
    // La ruta 1 tiene 2 muestras por canal: el mínimo entre rutas es 2.
    expect(read.frames).toBe(2);
    const voice = read.routes.find((route) => route.index === 0)!;
    const f32 = (buffer: ArrayBuffer) => Array.from(new Float32Array(buffer)).map((v) => Math.fround(v));
    expect(f32(voice.left)).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((v) => Math.fround(v)));
    expect(f32(voice.right)).toEqual([-0.1, -0.2, -0.3, -0.4, -0.5, -0.6].map((v) => Math.fround(v)));

    const list = await journal.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.frames).toBe(2);
    expect(list[0]!.title).toBe('Canción');
    expect(list[0]!.bytes).toBeGreaterThan(0);
  });

  it('un frame partido por un crash se recorta a frames enteros', async () => {
    const journal = createRecordingJournal(() => dir);
    await journal.start(META);
    const base = join(dir, JOURNAL_DIR);
    // 8 bytes = 1 frame entero + 4 bytes del siguiente a medias.
    await appendFile(join(base, `${META.id}.0.L.f32`), new Uint8Array(12));
    await appendFile(join(base, `${META.id}.0.R.f32`), new Uint8Array(12));
    await appendFile(join(base, `${META.id}.1.L.f32`), new Uint8Array(8));
    await appendFile(join(base, `${META.id}.1.R.f32`), new Uint8Array(8));

    const read = await journal.read(META.id);
    expect(read.frames).toBe(2);
    expect(read.routes[0]!.left.byteLength).toBe(12);
    expect((await journal.list())[0]!.frames).toBe(2);
  });

  it('finish borra el diario y deja de ofrecerlo', async () => {
    const journal = createRecordingJournal(() => dir);
    await journal.start(META);
    await journal.append(META.id, 0, bytes(floats([0.1])), bytes(floats([0.1])));
    await journal.finish(META.id);
    expect(await journal.list()).toEqual([]);
    expect(await readdir(join(dir, JOURNAL_DIR))).toEqual([]);
  });

  it('rechaza ids y rutas que se salen del diario', async () => {
    const journal = createRecordingJournal(() => dir);
    await expect(journal.start({ ...META, id: '../fuera' })).rejects.toThrow(/inválidos/);
    await expect(journal.append('../../etc/passwd', 0, bytes(floats([1])), bytes(floats([1])))).rejects.toThrow();
    expect(parseJournalMeta({ ...META, id: 'corto' })).toBeNull();
  });

  it('rechaza canales que no miden lo mismo y trozos gigantes', async () => {
    const journal = createRecordingJournal(() => dir);
    await journal.start(META);
    await expect(
      journal.append(META.id, 0, bytes(floats([1, 2])), bytes(floats([1]))),
    ).rejects.toThrow(/mismo/);
    const huge = new Uint8Array(JOURNAL_MAX_APPEND_BYTES + 4);
    await expect(journal.append(META.id, 0, huge, huge)).rejects.toThrow(/grande/);
  });

  it('el diario viejo se purga y el reciente se queda', async () => {
    const journal = createRecordingJournal(() => dir);
    await journal.start(META);
    await journal.append(META.id, 0, bytes(floats([0.1])), bytes(floats([0.1])));
    await journal.append(META.id, 1, bytes(floats([0.1])), bytes(floats([0.1])));
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const base = join(dir, JOURNAL_DIR);
    for (const file of await readdir(base)) await utimes(join(base, file), old, old);

    expect(await journal.list()).toHaveLength(1);
    expect(await journal.purge()).toEqual([META.id]);
    expect(await journal.list()).toEqual([]);
  });

  it('un metadato corrupto no impide leer los demás', async () => {
    const journal = createRecordingJournal(() => dir);
    await journal.start(META);
    await journal.append(META.id, 0, bytes(floats([0.1])), bytes(floats([0.1])));
    await journal.append(META.id, 1, bytes(floats([0.1])), bytes(floats([0.1])));
    await writeFile(join(dir, JOURNAL_DIR, 'roto-0001.json'), '{no es json');
    expect((await journal.list()).map((item) => item.id)).toEqual([META.id]);
  });
});
