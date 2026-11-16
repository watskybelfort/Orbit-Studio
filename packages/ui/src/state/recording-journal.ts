/**
 * Cliente del diario de toma: manda a disco el PCM crudo mientras se graba.
 *
 * El canal de audio entrega bloques pequeños (~128 frames). Escribir un IPC por
 * bloque sería absurdo, así que se acumulan y se vuelcan cada ~0,5 s (o cuando
 * el buffer pasa de medio segundo). Lo que se pierde en un crash es, como
 * mucho, ese medio segundo — no la toma entera, que es lo que pasaba antes.
 *
 * **Un fallo del diario no rompe la grabación**: se marca `failed` y se deja de
 * intentar; al terminar, el diario NO se borra (queda como recuperación).
 * Grabaar con el disco lleno no puede tumbar el micro.
 */

import { newId } from '@orbit/core';

interface JournalPending {
  left: Float32Array[];
  right: Float32Array[];
}

interface JournalSession {
  id: string;
  meta: JournalMeta;
  /** Toda escritura va en cadena: dos appends del mismo diario no se pisan. */
  chain: Promise<void>;
  pending: Map<number, JournalPending>;
  frames: number;
  failed: boolean;
}

/** Medio segundo a 48 kHz: el volcado periódico. */
const FLUSH_FRAMES = 24_000;
const FLUSH_MS = 500;

let session: JournalSession | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function journalApi(): OrbitApi['recording']['journal'] | undefined {
  return typeof window === 'undefined' ? undefined : window.orbit?.recording?.journal;
}

function concat(parts: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function bytesOf(samples: Float32Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Abre el diario de una toma. `meta` es lo que hace falta para reconstruir la
 * colocación si la app muere: proyecto, arreglo, tempo, beat, latencia y loop.
 */
export function startRecordingJournal(
  meta: Omit<JournalMeta, 'id' | 'startedAt'>,
): void {
  const api = journalApi();
  if (!api) return;
  // Un diario anterior sin cerrar se deja para recuperación; no se pisa.
  const id = newId();
  const s: JournalSession = {
    id,
    meta: { ...meta, id, startedAt: Date.now() },
    chain: Promise.resolve(),
    pending: new Map(),
    frames: 0,
    failed: false,
  };
  session = s;
  s.chain = api.start(s.meta).catch(() => {
    s.failed = true;
  });
  if (timer !== null) clearInterval(timer);
  timer = setInterval(() => void flushRecordingJournal(), FLUSH_MS);
}

/** Un bloque de una ruta. Se acumula; el volcado lo manda. */
export function journalChunk(routeIndex: number, left: Float32Array, right: Float32Array): void {
  const s = session;
  if (!s || s.failed) return;
  let pending = s.pending.get(routeIndex);
  if (!pending) {
    pending = { left: [], right: [] };
    s.pending.set(routeIndex, pending);
  }
  pending.left.push(left);
  pending.right.push(right);
  s.frames += left.length;
  if (s.frames >= FLUSH_FRAMES) void flushRecordingJournal();
}

/** Vuelca lo acumulado (en cadena con lo que ya estuviera escribiéndose). */
export async function flushRecordingJournal(): Promise<void> {
  const s = session;
  if (!s || s.failed) return;
  const pending = s.pending;
  s.pending = new Map();
  s.frames = 0;
  if (pending.size === 0) return;
  s.chain = s.chain.then(async () => {
    if (s.failed) return;
    const api = journalApi();
    if (!api) return;
    for (const [index, chunks] of pending) {
      if (chunks.left.length === 0) continue;
      await api.append(s.id, index, bytesOf(concat(chunks.left)), bytesOf(concat(chunks.right)));
    }
  }).catch(() => {
    // Disco lleno, permisos, lo que sea: se deja de escribir y se conserva lo
    // que ya haya para la recuperación.
    s.failed = true;
  });
  await s.chain;
}

/**
 * Cierra el diario. Si TODO se escribió, se borra (la copia buena es el WAV).
 * Si algo falló, se deja: al arrancar la UI lo ofrecerá.
 */
export async function finishRecordingJournal(): Promise<void> {
  const s = session;
  if (!s) return;
  await flushRecordingJournal();
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  session = null;
  if (s.failed) return;
  await journalApi()?.finish(s.id).catch(() => undefined);
}

/** Descarta el diario en curso sin esperar a guardar (pruebas, cancelación). */
export function discardRecordingJournal(): void {
  const s = session;
  session = null;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (s) void journalApi()?.discard(s.id).catch(() => undefined);
}
