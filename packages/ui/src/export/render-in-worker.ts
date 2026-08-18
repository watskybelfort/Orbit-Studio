/**
 * Cliente del worker de render (render-worker.ts): mismas firmas que
 * `renderProject`/`renderStems` del engine, pero el cómputo (y la ejecución de
 * los plugins JS) ocurre en un worker aislado, no en el hilo de la UI.
 *
 * Un solo worker reutilizado; las peticiones se casan por id. Si el worker no
 * está disponible (test/Node), el llamante debe caer al render directo.
 */

import type { CompiledProject, RenderResult, SampleData } from '@orbit/engine';

export interface WorkerRenderOpts {
  samples?: Map<string, SampleData>;
  plugins?: Map<string, string>;
  sampleRate?: number;
  tailSeconds?: number;
  startBeat?: number;
  endBeat?: number;
}

interface Resp {
  id: number;
  ok: boolean;
  error?: string;
  result?: RenderResult;
  stems?: { idx: number; result: RenderResult }[];
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: Resp) => void; reject: (e: Error) => void }>();

/** ¿Se puede usar el worker aquí? (No en Node/tests). */
export function canUseRenderWorker(): boolean {
  return typeof Worker !== 'undefined';
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<Resp>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error ?? 'Fallo en el worker de render'));
    });
    worker.addEventListener('error', (e) => {
      // Un error del worker deja las peticiones vivas colgadas: se rechazan todas.
      for (const [, p] of pending) p.reject(new Error(e.message || 'Error del worker de render'));
      pending.clear();
    });
  }
  return worker;
}

function request(msg: Record<string, unknown>): Promise<Resp> {
  const id = ++seq;
  const w = getWorker();
  return new Promise<Resp>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...msg, id });
  });
}

export async function renderProjectInWorker(
  compiled: CompiledProject,
  opts: WorkerRenderOpts,
): Promise<RenderResult> {
  const resp = await request({ kind: 'project', compiled, opts });
  if (!resp.result) throw new Error('El worker no devolvió el render');
  return resp.result;
}

export async function renderStemsInWorker(
  compiled: CompiledProject,
  trackIndices: number[],
  opts: WorkerRenderOpts,
): Promise<Map<number, RenderResult>> {
  const resp = await request({ kind: 'stems', compiled, trackIndices, opts });
  const out = new Map<number, RenderResult>();
  for (const s of resp.stems ?? []) out.set(s.idx, s.result);
  return out;
}
