/** Mensajes del worker que mide pistas para los perfiles de estilo. */

import type { TrackFeatures } from '@orbit/sound-library';

export interface ComposerWorkerRequest {
  mono: Float32Array;
  sampleRate: number;
  name: string;
}

export type ComposerWorkerResponse =
  | { ok: true; features: TrackFeatures | null }
  | { ok: false; error: string };
