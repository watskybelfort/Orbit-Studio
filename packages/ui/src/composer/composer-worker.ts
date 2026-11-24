/**
 * Worker que mide una pista para el perfil de estilo del compositor.
 *
 * Medir un tema son ~2 s de FFT (tempo, tonalidad y onsets por banda): en el
 * hilo de UI congelaría la ventana mientras se entrena con una carpeta
 * entera. Igual que el del analizador de tempo, un worker por pista: se
 * termina al acabar y suelta su copia del PCM.
 */

import { extractTrackFeatures } from '@orbit/sound-library';
import type { ComposerWorkerRequest, ComposerWorkerResponse } from './composer-worker-protocol';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ComposerWorkerRequest>) => void) | null;
  postMessage(message: ComposerWorkerResponse): void;
  close(): void;
}

const ctx = self as unknown as WorkerScope;
const post = ctx.postMessage.bind(ctx);

ctx.onmessage = (e) => {
  let response: ComposerWorkerResponse;
  try {
    response = { ok: true, features: extractTrackFeatures(e.data.mono, e.data.sampleRate, e.data.name) };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : 'No se pudo medir la pista.' };
  }
  post(response);
  ctx.close();
};
