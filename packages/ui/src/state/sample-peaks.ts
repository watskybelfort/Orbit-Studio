/**
 * Picos (min/max por columna) de los samples, en una caché compartida.
 *
 * Decodificar es lo caro; dibujar no. Y del PCM decodificado solo interesan los
 * picos: guardar el buffer entero de un pad de 30 s son megas por sample para
 * pintar cuatro píxeles. La caché va por `id:hash` para que dos clips del mismo
 * archivo compartan el trabajo, y por eso vive aquí y no dentro de un
 * componente: la usan el editor de canal (SampleWave) y los clips de audio de
 * la playlist.
 *
 * `peaksOf` es asíncrono y `peaksCached` es la vista síncrona que necesita un
 * canvas: en pleno dibujado no se puede esperar a nada, así que el que pinta
 * consulta lo que ya hay y pide lo que falta para el siguiente frame.
 */

import type { SampleRef } from '@orbit/core';
import { readSampleBytes } from '../browser/sound-actions';

/** Columnas de picos que se guardan por sample (de sobra para cualquier ancho). */
export const PEAK_COLS = 1400;

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  duration: number;
}

const cache = new Map<string, Peaks>();
/** Decodificaciones en vuelo: dos clips del mismo sample no decodifican dos veces. */
const inflight = new Map<string, Promise<Peaks | null>>();
/** Lo que ya se intentó y no salió (para no reintentar en cada frame). */
const failed = new Set<string>();
/** Avisos de "ya hay picos nuevos" para que los canvas se repinten. */
const listeners = new Set<() => void>();

function keyOf(sample: Pick<SampleRef, 'id' | 'hash'>): string {
  return `${sample.id}:${sample.hash}`;
}

/** Picos ya calculados, o undefined si aún no están (sin bloquear). */
export function peaksCached(sample: Pick<SampleRef, 'id' | 'hash'>): Peaks | undefined {
  return cache.get(keyOf(sample));
}

/** ¿Se intentó y no hubo forma? (sample que no está en esta máquina). */
export function peaksFailed(sample: Pick<SampleRef, 'id' | 'hash'>): boolean {
  return failed.has(keyOf(sample));
}

/** Se suscribe a "hay picos nuevos"; devuelve la baja. */
export function onPeaksReady(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Pide los picos sin esperarlos: si no están, arranca la decodificación y
 * avisa por `onPeaksReady` cuando terminen. Es lo que llama un canvas.
 */
export function requestPeaks(sample: SampleRef): Peaks | undefined {
  const hit = peaksCached(sample);
  if (hit) return hit;
  if (!failed.has(keyOf(sample))) void peaksOf(sample);
  return undefined;
}

/** Picos del sample, decodificando si hace falta. null = no se pudo leer. */
export async function peaksOf(sample: SampleRef): Promise<Peaks | null> {
  const key = keyOf(sample);
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<Peaks | null> => {
    try {
      const bytes = await readSampleBytes(sample.path);
      if (!bytes) {
        failed.add(key);
        return null;
      }
      const ctx = new OfflineAudioContext(2, 1, 48000);
      const decoded = await ctx.decodeAudioData(bytes);
      const peaks = peaksFromChannels(
        decoded.getChannelData(0),
        decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0),
        decoded.duration,
      );
      cache.set(key, peaks);
      failed.delete(key);
      for (const cb of listeners) cb();
      return peaks;
    } catch {
      failed.add(key);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/**
 * Reduce dos canales a PEAK_COLS columnas de min/max.
 *
 * Muestreo salteado a propósito: con un pad de 30 s, recorrer muestra a muestra
 * congela la UI y el pico visible no cambia.
 */
export function peaksFromChannels(
  left: Float32Array,
  right: Float32Array,
  duration: number,
): Peaks {
  const min = new Float32Array(PEAK_COLS);
  const max = new Float32Array(PEAK_COLS);
  const n = left.length;
  for (let c = 0; c < PEAK_COLS; c++) {
    const i0 = Math.floor((c / PEAK_COLS) * n);
    const i1 = Math.max(i0 + 1, Math.floor(((c + 1) / PEAK_COLS) * n));
    const stride = Math.max(1, Math.floor((i1 - i0) / 48));
    let lo = 1;
    let hi = -1;
    for (let i = i0; i < i1; i += stride) {
      const s = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    // Un tramo vacío (sample de longitud 0) dejaría lo>hi y pintaría al revés.
    min[c] = Math.min(lo, hi);
    max[c] = Math.max(lo, hi);
  }
  return { min, max, duration };
}
