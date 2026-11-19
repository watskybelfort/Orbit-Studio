/**
 * Worker del analizador de tempo/tonalidad.
 *
 * El DSP es determinista y puro, pero sobre un tema de cinco minutos son
 * segundos de FFT: hacerlo en el hilo de UI congelaría la ventana justo después
 * de soltar el archivo. Aquí corre fuera, con el PCM ya decodificado y
 * transferido, y el hilo de UI solo recibe el resultado.
 *
 * Un worker por trabajo: el análisis es esporádico y terminar el worker libera
 * su copia del PCM sin esperar a que al navegador le apetezca recolectar.
 */

import { analyzeAudio } from '@orbit/engine';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-protocol';

interface WorkerScope {
  onmessage: ((e: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  postMessage(message: AnalysisWorkerResponse): void;
  close(): void;
}

const ctx = self as unknown as WorkerScope;
const post = ctx.postMessage.bind(ctx);

ctx.onmessage = (e) => {
  let response: AnalysisWorkerResponse;
  try {
    response = { ok: true, analysis: analyzeAudio(e.data.mono, e.data.sampleRate) };
  } catch (error) {
    response = {
      ok: false,
      error: error instanceof Error ? error.message : 'El analizador no pudo con la señal.',
    };
  }
  post(response);
  ctx.close();
};
