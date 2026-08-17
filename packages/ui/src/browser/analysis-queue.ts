/**
 * Indexado perezoso de las carpetas del usuario: estima BPM y tonalidad de los
 * archivos que el manifest no trae con esos campos.
 *
 * Reglas de la casa:
 * - **Nunca bloquea la UI**: se procesa de uno en uno, cediendo el hilo entre
 *   archivos (`requestIdleCallback` cuando existe) y en lotes cortos.
 * - **Nunca recalcula**: lo ya analizado vive en el caché persistido de
 *   `library-prefs` (incluidos los archivos que no dieron resultado, marcados
 *   con `done`, para no volver a intentarlo cada arranque).
 * - Solo se encolan archivos visibles en el browser; una carpeta de 5.000
 *   samples no se analiza entera "por si acaso".
 *
 * La decodificación usa un `OfflineAudioContext` propio: `decodeAudioData` no
 * necesita gesto del usuario y así el análisis no toca el AudioContext del
 * motor ni le roba tiempo.
 */

import { analyzeSample, toMono } from '@orbit/sound-library';
import { rememberAnalysis, usePrefs, type AnalysisEntry } from './library-prefs';

/** Máximo de segundos que se decodifican de cada archivo (análisis suficiente). */
const MAX_SECONDS = 30;
/** Techo de archivos encolados por tanda: la vista solo pinta 200. */
const MAX_QUEUE = 200;

const cola: string[] = [];
const encolados = new Set<string>();
let corriendo = false;
let ctx: OfflineAudioContext | null = null;

/** Contexto solo para decodificar (1 frame: no se renderiza nada con él). */
function decodeCtx(): OfflineAudioContext | null {
  if (ctx) return ctx;
  const Ctor = globalThis.OfflineAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    ctx = new Ctor(1, 1, 44100);
    return ctx;
  } catch {
    return null;
  }
}

/** Cede el hilo hasta que el navegador esté ocioso (o al siguiente tick). */
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve());
    else setTimeout(resolve, 16);
  });
}

async function analizar(file: string): Promise<AnalysisEntry> {
  const api = window.orbit;
  const audioCtx = decodeCtx();
  if (!api || !audioCtx) return { done: true };
  const bytes = await api.folder.read(file);
  const buffer = await audioCtx.decodeAudioData(bytes);
  const frames = Math.min(buffer.length, Math.floor(MAX_SECONDS * buffer.sampleRate));
  const left = buffer.getChannelData(0).subarray(0, frames);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).subarray(0, frames) : undefined;
  const mono = toMono(left, right);
  const a = analyzeSample(mono, buffer.sampleRate);
  const entry: AnalysisEntry = { done: true, durationSec: buffer.duration };
  if (a.bpm !== undefined) entry.bpm = a.bpm;
  if (a.keyRoot !== undefined) entry.keyRoot = a.keyRoot;
  if (a.mode !== undefined) entry.mode = a.mode;
  return entry;
}

async function bombear(): Promise<void> {
  if (corriendo) return;
  corriendo = true;
  try {
    while (cola.length > 0) {
      const file = cola.shift()!;
      encolados.delete(file);
      // Pudo analizarse mientras esperaba en la cola.
      if (usePrefs.getState().analysis[file] !== undefined) continue;
      try {
        rememberAnalysis(file, await analizar(file));
      } catch {
        // Archivo ilegible o formato que el decoder no traga: se marca hecho
        // igual, para no reintentarlo en cada arranque.
        rememberAnalysis(file, { done: true });
      }
      await idle();
    }
  } finally {
    corriendo = false;
  }
}

/**
 * Encola los archivos que aún no tienen metadatos. Devuelve cuántos quedaron
 * pendientes (el browser lo usa para el aviso de "analizando…").
 */
export function queueAnalysis(files: readonly string[]): number {
  if (!window.orbit) return 0;
  const { analysis } = usePrefs.getState();
  for (const file of files) {
    if (cola.length >= MAX_QUEUE) break;
    if (analysis[file] !== undefined || encolados.has(file)) continue;
    encolados.add(file);
    cola.push(file);
  }
  if (cola.length > 0) void bombear();
  return cola.length;
}

/** Archivos aún por analizar (para el indicador de la UI). */
export function pendingAnalysis(): number {
  return cola.length;
}
