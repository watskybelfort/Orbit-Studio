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
 *
 * La caché se acota contra el proyecto abierto como las otras dos del hilo de
 * UI; la política común y el porqué están en `state/sample-gc.ts`.
 */

import type { SampleRef } from '@orbit/core';
import { readSampleBytes } from '../browser/sound-actions';
import { createUiAudioCache, sampleCacheKey } from './sample-gc';

/** Columnas de picos que se guardan por sample (de sobra para cualquier ancho). */
export const PEAK_COLS = 1400;

export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  duration: number;
}

/** Decodificaciones en vuelo: dos clips del mismo sample no decodifican dos veces. */
const inflight = new Map<string, Promise<Peaks | null>>();
/** Lo que ya se intentó y no salió (para no reintentar en cada frame). */
const failed = new Set<string>();
/**
 * Avisos de "ya hay picos nuevos" para que los canvas se repinten.
 *
 * Es la misma clase de fuga que una caché sin barrer —se da de alta y la baja
 * la tiene que hacer otro— con dos agravantes: lo que se queda dentro son
 * CLOSURES, y una closure retiene todo lo que capturó (aquí, el `draw` de un
 * canvas con su proyecto, sus refs y su estado, o sea bastante más que los 8
 * bytes de la función); y no hay ningún byte visible que delate el crecimiento,
 * así que una baja perdida no se nota nunca — se deduce.
 *
 * La baja en sí ya es estructural y se queda como está: `onPeaksReady` DEVUELVE
 * su baja y el único llamante la devuelve tal cual desde un `useEffect`
 * (`Playlist.tsx`), que es el contrato que React garantiza al desmontar. Lo que
 * faltaba —y es lo que se añade aquí— es poder VERLA: un contador consultable y
 * un aviso cuando el número deja de ser plausible.
 */
const listeners = new Set<() => void>();

/**
 * Cuántos suscriptores tienen sentido a la vez.
 *
 * Hoy hay UNO: el canvas de la playlist. El editor de canal no se suscribe
 * (`SampleWave` espera su promesa) y no hay ningún sitio más. Treinta y dos deja
 * sitio de sobra para varias vistas futuras y sigue siendo dos órdenes de
 * magnitud menos que una fuga de verdad, que crece con cada repintado. Se elige
 * alto a propósito: un aviso que salta por churn normal se aprende a ignorar.
 */
export const PEAKS_LISTENERS_PLAUSIBLE = 32;

/** Se avisa una vez por desborde, no una vez por alta: si no, sería ruido. */
let overflowWarned = false;

/**
 * Suscriptores vivos ahora mismo — para VER una baja perdida en vez de
 * deducirla. Se teclea en la consola del renderer igual que `peaksCacheStats()`;
 * en régimen debería decir 1 (la playlist) o 0 (con la playlist cerrada), y
 * cualquier número que sube y no baja es una baja que alguien no hizo.
 */
export function peaksListenerCount(): number {
  return listeners.size;
}

/**
 * La caché de picos sigue la misma política que la del render y por el mismo
 * motivo: la sirve al proyecto ENTERO a la vez —la playlist pinta todos los
 * clips de audio del mismo frame y el rack todos los samplers—, así que su cota
 * es el conjunto vivo del proyecto y no un tope de entradas (ver
 * `state/sample-gc.ts`). Aquí el volumen es tres órdenes de magnitud menor
 * —11,2 KB por entrada contra megas— pero la forma de la fuga era idéntica: se
 * escribía y no la vaciaba nadie, y mil samples auditados en una sesión larga
 * son ~11 MB que no vuelven hasta cerrar la app.
 *
 * `failed` se barre con la misma llave en el mismo gesto: es un `Set` de las
 * MISMAS claves, así que sobrevivir al proyecto que lo generó lo convierte en
 * la misma fuga con otro tipo (y, de paso, un sample que volvió a aparecer en
 * el disco merece un reintento en vez de quedar marcado como imposible para
 * siempre).
 */
const cache = createUiAudioCache<Peaks>({
  name: 'peaks',
  bytesOf: (peaks) => (peaks.min.length + peaks.max.length) * 4,
  sweepExtra: (live) => {
    for (const key of failed) {
      if (!live.has(key)) failed.delete(key);
    }
  },
});

/** Tamaño real de la caché de picos ahora mismo — para medir, no para estimar. */
export function peaksCacheStats(): { entries: number; bytes: number } {
  return cache.stats();
}

function keyOf(sample: Pick<SampleRef, 'id' | 'hash'>): string {
  return sampleCacheKey(sample.id, sample.hash);
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
  if (!overflowWarned && listeners.size > PEAKS_LISTENERS_PLAUSIBLE) {
    overflowWarned = true;
    console.warn(
      `[sample-peaks] ${listeners.size} suscriptores vivos en onPeaksReady (lo plausible es ${PEAKS_LISTENERS_PLAUSIBLE}): ` +
        'alguien se suscribe y no llama a la baja que devuelve. Cada uno retiene su closure y lo que capturó.',
    );
  }
  return () => {
    listeners.delete(cb);
    // Se rearma al volver a lo normal, para que el aviso siga sirviendo en la
    // sesión siguiente en vez de gastarse la única vez que saltó.
    if (listeners.size <= PEAKS_LISTENERS_PLAUSIBLE) overflowWarned = false;
  };
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
