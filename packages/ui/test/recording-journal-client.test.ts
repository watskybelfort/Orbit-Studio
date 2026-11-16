/**
 * Cliente del diario de toma (`state/recording-journal.ts`) con un API de
 * mentira. Lo que importa:
 *
 *  - los bloques se agrupan y llegan al append con el PCM concatenado;
 *  - al terminar, si todo se escribió, el diario se borra;
 *  - si un append falla, NO se borra: queda para la recuperación del arranque
 *    y la grabación no se rompe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discardRecordingJournal,
  finishRecordingJournal,
  flushRecordingJournal,
  journalChunk,
  startRecordingJournal,
} from '../src/state/recording-journal';

interface Appended {
  id: string;
  routeIndex: number;
  left: Float32Array;
  right: Float32Array;
}

function rig(fail = false) {
  const appended: Appended[] = [];
  const calls = { start: 0, finish: 0, discard: 0 };
  const api = {
    start: async () => {
      calls.start++;
    },
    append: async (id: string, routeIndex: number, left: Uint8Array, right: Uint8Array) => {
      if (fail) throw new Error('disco lleno');
      appended.push({
        id,
        routeIndex,
        left: new Float32Array(left.buffer, left.byteOffset, left.byteLength / 4),
        right: new Float32Array(right.buffer, right.byteOffset, right.byteLength / 4),
      });
    },
    finish: async () => {
      calls.finish++;
    },
    list: async () => [],
    read: async () => {
      throw new Error('no usado');
    },
    discard: async () => {
      calls.discard++;
    },
  };
  vi.stubGlobal('window', { orbit: { recording: { journal: api } } });
  return { appended, calls };
}

function meta() {
  return {
    title: 'Canción',
    projectId: 'p',
    arrangementId: 'a',
    tempo: 120,
    sampleRate: 48000,
    start: 0,
    latency: 0,
    loop: null,
    routes: [{ index: 0, name: 'Voz' }],
  };
}

afterEach(() => {
  discardRecordingJournal();
  vi.unstubAllGlobals();
});

describe('diario de toma (renderer)', () => {
  it('agrupa bloques y los manda concatenados al volcar', async () => {
    const { appended } = rig();
    startRecordingJournal(meta());
    journalChunk(0, new Float32Array([0.1, 0.2]), new Float32Array([-0.1, -0.2]));
    journalChunk(0, new Float32Array([0.3]), new Float32Array([-0.3]));
    await flushRecordingJournal();

    expect(appended).toHaveLength(1);
    expect(appended[0]!.routeIndex).toBe(0);
    expect(Array.from(appended[0]!.left)).toEqual([Math.fround(0.1), Math.fround(0.2), Math.fround(0.3)]);
    expect(Array.from(appended[0]!.right)).toEqual([
      Math.fround(-0.1), Math.fround(-0.2), Math.fround(-0.3),
    ]);
  });

  it('al terminar con todo escrito, el diario se borra', async () => {
    const { calls } = rig();
    startRecordingJournal(meta());
    journalChunk(0, new Float32Array([0.5]), new Float32Array([0.5]));
    await finishRecordingJournal();
    expect(calls.start).toBe(1);
    expect(calls.finish).toBe(1);
  });

  it('si un append falla, no se borra el diario (queda para recuperar)', async () => {
    const { calls } = rig(true);
    startRecordingJournal(meta());
    journalChunk(0, new Float32Array([0.5]), new Float32Array([0.5]));
    await finishRecordingJournal();
    expect(calls.finish).toBe(0);
  });

  it('sin puente de escritorio no hace nada', () => {
    vi.stubGlobal('window', {});
    expect(() => {
      startRecordingJournal(meta());
      journalChunk(0, new Float32Array([1]), new Float32Array([1]));
    }).not.toThrow();
  });
});
