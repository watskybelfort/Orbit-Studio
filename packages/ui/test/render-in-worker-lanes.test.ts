/**
 * Cancelar un render no puede matar el render de OTRO dueño.
 *
 * El bug que este test fija: había un worker de render único y
 * `cancelActiveRenderWorker()` lo tiraba entero. Cancelar un export a mitad
 * rechazaba también la promesa del Consolidar/Congelar que estuviera corriendo
 * (su catch no era "cancelado por el usuario", así que se reportaba como
 * fallo) y su WAV no se escribía nunca. Ahora cada dueño tiene su carril y su
 * worker.
 *
 * Se usa un `Worker` de mentira: en Node no hay worker real, y lo que hay que
 * probar es la fontanería (a quién se le rechaza, a quién se le termina), no
 * el DSP — ese ya tiene sus tests contra `renderProject`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompiledProject } from '@orbit/engine';
import {
  cancelActiveRenderWorker,
  renderProjectInWorker,
  renderStemsInWorker,
  resetRenderWorkerLanes,
} from '../src/export/render-in-worker';

interface Sent {
  id: number;
  kind: string;
}

class FakeWorker {
  static all: FakeWorker[] = [];
  sent: Sent[] = [];
  terminated = false;
  private listeners = new Map<string, ((e: unknown) => void)[]>();

  constructor() {
    FakeWorker.all.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  postMessage(msg: Sent): void {
    this.sent.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(payload: Record<string, unknown>, id = this.sent.at(-1)!.id): void {
    for (const cb of this.listeners.get('message') ?? []) {
      cb({ data: { id, ok: true, ...payload } });
    }
  }
}

const COMPILED = { tracks: [], channels: [] } as unknown as CompiledProject;

function lastWorker(): FakeWorker {
  const worker = FakeWorker.all.at(-1);
  if (!worker) throw new Error('no se creó ningún worker');
  return worker;
}

beforeEach(() => {
  resetRenderWorkerLanes();
  FakeWorker.all = [];
  vi.stubGlobal('Worker', FakeWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cancelActiveRenderWorker('export');
  cancelActiveRenderWorker('bounce');
  cancelActiveRenderWorker('default');
});

describe('carriles del worker de render', () => {
  it('export y bounce usan workers distintos', async () => {
    const exportJob = renderProjectInWorker(COMPILED, {}, 'export');
    const bounceJob = renderProjectInWorker(COMPILED, {}, 'bounce');
    expect(FakeWorker.all).toHaveLength(2);

    const exportWorker = FakeWorker.all[0]!;
    const bounceWorker = FakeWorker.all[1]!;
    expect(exportWorker.sent[0]!.kind).toBe('project');
    expect(bounceWorker.sent[0]!.kind).toBe('project');

    // Resolver los dos para no dejar promesas pendientes.
    exportWorker.respond({ result: { left: new Float32Array(1), right: new Float32Array(1), sampleRate: 48000 } });
    bounceWorker.respond({ result: { left: new Float32Array(1), right: new Float32Array(1), sampleRate: 48000 } });
    await Promise.all([exportJob, bounceJob]);
  });

  it('cancelar el export NO toca el worker del bounce', async () => {
    const exportJob = renderProjectInWorker(COMPILED, {}, 'export').catch((e: Error) => e);
    const bounceJob = renderProjectInWorker(COMPILED, {}, 'bounce');
    const [exportWorker, bounceWorker] = FakeWorker.all as [FakeWorker, FakeWorker];

    cancelActiveRenderWorker('export');

    const error = await exportJob;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/cancelado/i);
    expect(exportWorker.terminated).toBe(true);
    // El de bounce sigue vivo, sin terminar y con su petición pendiente.
    expect(bounceWorker.terminated).toBe(false);

    bounceWorker.respond({ result: { left: new Float32Array(1), right: new Float32Array(1), sampleRate: 48000 } });
    await expect(bounceJob).resolves.toBeTruthy();
  });

  it('cancelar el bounce NO toca el worker del export', async () => {
    const exportJob = renderProjectInWorker(COMPILED, {}, 'export');
    const bounceError = renderProjectInWorker(COMPILED, {}, 'bounce').catch((e: Error) => e);
    const [exportWorker, bounceWorker] = FakeWorker.all as [FakeWorker, FakeWorker];

    cancelActiveRenderWorker('bounce');
    expect(bounceWorker.terminated).toBe(true);
    expect(exportWorker.terminated).toBe(false);
    await expect(bounceError).resolves.toBeInstanceOf(Error);

    exportWorker.respond({ result: { left: new Float32Array(1), right: new Float32Array(1), sampleRate: 48000 } });
    await expect(exportJob).resolves.toBeTruthy();
  });

  it('tras cancelar, el carril se rearma con un worker nuevo', async () => {
    const first = renderProjectInWorker(COMPILED, {}, 'export').catch((e: Error) => e);
    const firstWorker = lastWorker();
    cancelActiveRenderWorker('export');
    await first;
    expect(firstWorker.terminated).toBe(true);

    const second = renderProjectInWorker(COMPILED, {}, 'export');
    expect(FakeWorker.all).toHaveLength(2);
    const secondWorker = lastWorker();
    expect(secondWorker).not.toBe(firstWorker);
    secondWorker.respond({ result: { left: new Float32Array(1), right: new Float32Array(1), sampleRate: 48000 } });
    await expect(second).resolves.toBeTruthy();
  });

  it('los stems del export van por el carril del export', async () => {
    const job = renderStemsInWorker(COMPILED, [0, 1], {}, undefined, 'export');
    const worker = lastWorker();
    expect(worker.sent[0]!.kind).toBe('stems');
    worker.respond({ stems: [{ idx: 0, result: { sampleRate: 48000 } }], failed: [] });
    const result = await job;
    expect(result.results.get(0)).toBeTruthy();
    expect(result.errors.size).toBe(0);
  });

  it('cancelar un carril sin nada corriendo no crea ni tira nada', () => {
    cancelActiveRenderWorker('bounce');
    expect(FakeWorker.all).toHaveLength(0);
  });
});
