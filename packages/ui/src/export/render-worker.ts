/**
 * Worker de render offline: corre `renderProject`/`renderStems` FUERA del hilo
 * de la UI y sin `window`. Aquí es donde se compilan y ejecutan los plugins JS
 * del usuario (el kernel usa `new Function`), así que aislarlos aquí les quita el
 * acceso a `window.orbit`, al DOM y a la API del puente; la CSP del documento
 * (que el worker hereda) además corta la exfiltración por red. De paso, el export
 * deja de bloquear la UI.
 *
 * El renderer recoge las entradas privilegiadas (bytes de samples por IPC,
 * fuentes de plugins) y las manda ya listas; aquí solo se hace el cómputo puro.
 */

import { renderProject, renderStems } from '@orbit/engine';
import type { CompiledProject, RenderResult } from '@orbit/engine';
import type { SampleData } from '@orbit/engine';

interface RenderOpts {
  samples?: Map<string, SampleData>;
  plugins?: Map<string, string>;
  sampleRate?: number;
  tailSeconds?: number;
  startBeat?: number;
  endBeat?: number;
}

type Req =
  | { id: number; kind: 'project'; compiled: CompiledProject; opts: RenderOpts }
  | { id: number; kind: 'stems'; compiled: CompiledProject; trackIndices: number[]; opts: RenderOpts };

// El tsconfig usa la lib DOM, así que `self` sale tipado como Window (cuyo
// postMessage no acepta una lista de transferibles). Se castea al scope real del
// worker con lo justo que se usa aquí, sin tocar las libs globales.
interface WorkerScope {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

function transferOf(r: RenderResult): Transferable[] {
  return [r.left.buffer, r.right.buffer];
}

ctx.onmessage = (e: MessageEvent<Req>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'project') {
      const result = renderProject(msg.compiled, msg.opts);
      ctx.postMessage({ id: msg.id, ok: true, result }, transferOf(result));
      return;
    }
    // stems: un RenderResult por pista; se transfieren todos los buffers.
    const map = renderStems(msg.compiled, msg.trackIndices, msg.opts);
    const stems = [...map.entries()].map(([idx, result]) => ({ idx, result }));
    const transfer = stems.flatMap((s) => transferOf(s.result));
    ctx.postMessage({ id: msg.id, ok: true, stems }, transfer);
  } catch (err) {
    ctx.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
