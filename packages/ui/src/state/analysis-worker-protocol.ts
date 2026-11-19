/**
 * Contrato entre el hilo de UI y el worker del analizador.
 *
 * Se transfiere MONO ya mezclado: el tempo vive por debajo de 40 Hz y la
 * tonalidad por debajo de 4 kHz, así que el canal derecho no aporta nada que el
 * izquierdo no tenga y duplicaría la memoria del viaje.
 */

import type { AudioAnalysis } from '@orbit/engine';

export interface AnalysisWorkerRequest {
  mono: Float32Array;
  sampleRate: number;
}

export type AnalysisWorkerResponse =
  | { ok: true; analysis: AudioAnalysis }
  | { ok: false; error: string };
