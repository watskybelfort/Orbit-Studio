/**
 * Render offline: el MISMO KernelCore que suena en vivo, en un bucle puro.
 * Determinista (misma entrada → mismos samples) y más rápido que tiempo real.
 * Corre en Node (export CLI/tests) y en el navegador (Web Worker o directo).
 */

import { KernelCore, MAX_BLOCK } from '../kernel-core';
import type { CompiledProject } from '../protocol';
import type { SampleData } from '../dsp/voices';

export interface RenderOptions {
  sampleRate?: number;
  /** Cola de reverb/delay tras el final, en segundos. */
  tailSeconds?: number;
  samples?: Map<string, SampleData>;
  /** Plugins JS de usuario (pluginId → código fuente) usados por el proyecto. */
  plugins?: Map<string, string>;
  /**
   * Renderiza solo un tramo del timeline (consolidar un clip, por ejemplo).
   * Automatización y LFOs se derivan de la posición, así que arrancar en
   * `startBeat` da EXACTAMENTE lo mismo que renderizar todo y recortar; lo
   * único que no viaja es la cola de lo que sonaba antes del tramo.
   */
  startBeat?: number;
  endBeat?: number;
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
}

const HARD_CAP_SECONDS = 60 * 20;

export function renderProject(
  fullProject: CompiledProject,
  opts: RenderOptions = {},
): RenderResult {
  const sr = opts.sampleRate ?? 44100;
  const tail = opts.tailSeconds ?? 2;
  const core = new KernelCore(sr);

  // El kernel para cuando la posición alcanza lengthBeats: acortar el timeline
  // es lo que define el final del tramo.
  const startBeat = Math.max(0, opts.startBeat ?? 0);
  const project =
    opts.endBeat !== undefined && opts.endBeat < fullProject.lengthBeats
      ? { ...fullProject, lengthBeats: Math.max(startBeat + 1e-6, opts.endBeat) }
      : fullProject;

  if (opts.samples) {
    for (const [id, s] of opts.samples) {
      core.handleMessage({
        type: 'loadSample',
        sampleId: id,
        left: s.left,
        right: s.right,
        sampleRate: s.rate,
      });
    }
  }
  if (opts.plugins) {
    for (const [id, code] of opts.plugins) {
      core.handleMessage({ type: 'registerPlugin', pluginId: id, code });
    }
  }
  core.handleMessage({ type: 'snapshot', project });
  core.handleMessage({ type: 'setLoop', start: 0, end: project.lengthBeats, enabled: false });
  core.handleMessage({ type: 'play', fromBeat: startBeat });

  const estSeconds =
    ((Math.max(0, project.lengthBeats - startBeat) * 60) / project.tempo) + tail;
  const capSamples = Math.ceil(Math.min(HARD_CAP_SECONDS, estSeconds * 3 + 10) * sr);
  const chunks: Float32Array[] = [];
  const chunksR: Float32Array[] = [];
  const blockL = new Float32Array(MAX_BLOCK);
  const blockR = new Float32Array(MAX_BLOCK);

  let written = 0;
  let tailLeft = Math.ceil(tail * sr);
  const estTotal = Math.ceil(estSeconds * sr);

  while (written < capSamples) {
    core.process(blockL, blockR, MAX_BLOCK);
    chunks.push(blockL.slice());
    chunksR.push(blockR.slice());
    written += MAX_BLOCK;
    if (!core.playing) {
      tailLeft -= MAX_BLOCK;
      if (tailLeft <= 0) break;
    }
    if (opts.onProgress && written % (MAX_BLOCK * 64) === 0) {
      opts.onProgress(Math.min(0.99, written / estTotal));
    }
  }

  // El kernel se tira aquí, pero sus voces pueden seguir vivas (cola cortada,
  // tope duro alcanzado). Hay que soltarlas: los pools de recursos que usan
  // algunos instrumentos son de módulo, así que lo que no se devuelva se
  // pierde para el resto del proceso, no solo para este render.
  core.dispose();

  const left = new Float32Array(written);
  const right = new Float32Array(written);
  for (let i = 0; i < chunks.length; i++) {
    left.set(chunks[i]!, i * MAX_BLOCK);
    right.set(chunksR[i]!, i * MAX_BLOCK);
  }
  opts.onProgress?.(1);
  return { left, right, sampleRate: sr };
}

/**
 * Stems: un render por pista audible del mixer (solo esa pista + master),
 * pasando por la cadena completa (incluidos efectos de master).
 */
export function renderStems(
  project: CompiledProject,
  trackIndices: number[],
  opts: RenderOptions = {},
): Map<number, RenderResult> {
  const out = new Map<number, RenderResult>();
  for (const idx of trackIndices) {
    const solo: CompiledProject = {
      ...project,
      mixer: project.mixer.map((t, i) => ({
        ...t,
        slots: t.slots.map((s) => (s ? { ...s, params: { ...s.params } } : null)),
        sends: t.sends.map((s) => ({ ...s })),
        audible: i === 0 || i === idx ? t.audible : false,
      })),
    };
    out.set(idx, renderProject(solo, opts));
  }
  return out;
}
