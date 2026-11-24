/**
 * Caché y ejecución del análisis de tempo/tonalidad de los audios del
 * proyecto.
 *
 * El DSP no vive aquí: vive en `@orbit/engine` y es puro. Este módulo resuelve
 * lo que lo rodea en el renderer:
 *
 * - **qué se analiza**: el sample que acaba de entrar a la playlist o el que se
 *   abre en el editor, una vez por contenido (`hash`), nunca dos veces;
 * - **dónde se analiza**: en un worker, porque unos segundos de FFT en el hilo
 *   de UI se notan justo cuando el usuario acaba de soltar el archivo (y el
 *   motor de audio tiene su propio hilo, así que no se toca);
 * - **qué se recuerda**: solo el resumen (`audio-analysis-summary`), en
 *   `settings.json` bajo `audioAnalysis`, para que reabrir un proyecto no
 *   vuelva a medir lo mismo.
 *
 * Los trabajos van de uno en uno a propósito: soltar una carpeta de loops no
 * puede decodificar veinte archivos a la vez y quedarse sin memoria. Entre uno
 * y otro se cede el hilo.
 */

import type { SampleRef } from '@orbit/core';
import { analyzeAudio, type AudioAnalysis } from '@orbit/engine';
import { create } from 'zustand';
import { readSampleBytes } from '../browser/sample-io';
import type { AnalysisWorkerRequest, AnalysisWorkerResponse } from './analysis-worker-protocol';
import {
  analysisKeyOf,
  parseStoredAnalysis,
  summarizeAnalysis,
  summaryForSample,
  type AnalysisSummary,
} from './audio-analysis-summary';

export type { AnalysisSummary } from './audio-analysis-summary';
export {
  analysisBadge,
  analysisKeyOf,
  confidenceLabel,
  describeAnalysis,
  formatBpm,
  retimedLengthBeats,
  shouldAutoApplyTempo,
  summaryForSample,
  tempoToApply,
} from './audio-analysis-summary';

/** Clave del caché en settings.json. */
const SETTINGS_KEY = 'audioAnalysis';
/** Espejo cuando no hay puente de Electron (vite web, tests). */
const LS_KEY = 'orbit.audio.analysis';
/** Tope de entradas persistidas; las más viejas se caen primero. */
const MAX_ENTRIES = 400;

interface AudioAnalysisState {
  /** Resumen por hash de contenido. */
  entries: Readonly<Record<string, AnalysisSummary>>;
  /** Claves en cola o analizándose ahora mismo. */
  pending: Readonly<Record<string, true>>;
  /** Último error por clave; no se persiste (un archivo puede volver). */
  errors: Readonly<Record<string, string>>;
  /** Ya se intentó leer el caché de settings. */
  loaded: boolean;
}

export const useAudioAnalysis = create<AudioAnalysisState>(() => ({
  entries: {},
  pending: {},
  errors: {},
  loaded: false,
}));

// ── Persistencia ─────────────────────────────────────────────────────────────

function readLocal(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeLocal(entries: Record<string, AnalysisSummary>): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(entries));
  } catch {
    // cuota llena o storage bloqueado: el caché vive solo en memoria
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistPending: Record<string, AnalysisSummary> | null = null;

function persistSoon(entries: Record<string, AnalysisSummary>): void {
  persistPending = entries;
  if (persistTimer !== null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload = persistPending;
    persistPending = null;
    if (!payload) return;
    const api = globalThis.window?.orbit;
    if (api) void api.settings.set({ [SETTINGS_KEY]: payload }).catch(() => writeLocal(payload));
    else writeLocal(payload);
  }, 250);
}

/** Recorta por antigüedad sin tocar las entradas recién puestas. */
function capped(entries: Record<string, AnalysisSummary>): Record<string, AnalysisSummary> {
  const list = Object.entries(entries);
  if (list.length <= MAX_ENTRIES) return entries;
  list.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(list.slice(0, MAX_ENTRIES));
}

let loadPromise: Promise<void> | null = null;

/** Lee una vez el caché persistido (settings.json o localStorage). */
export function loadAudioAnalysis(): Promise<void> {
  if (useAudioAnalysis.getState().loaded) return Promise.resolve();
  loadPromise ??= (async () => {
    let raw: unknown = null;
    try {
      const settings = await globalThis.window?.orbit?.settings.get();
      raw = settings?.[SETTINGS_KEY] ?? readLocal();
    } catch {
      raw = readLocal();
    }
    const parsed = parseStoredAnalysis(raw);
    // Lo que ya se analizó en ESTA sesión mientras se leía el disco no se pisa.
    useAudioAnalysis.setState((s) => ({
      entries: { ...parsed, ...s.entries },
      loaded: true,
    }));
  })().catch(() => {
    // Un settings.json ilegible no puede dejar el análisis bloqueado para
    // siempre: se arranca con el caché vacío y se sigue midiendo.
    useAudioAnalysis.setState({ loaded: true });
  });
  return loadPromise;
}

// ── Decodificación ───────────────────────────────────────────────────────────

let decodeContext: OfflineAudioContext | null = null;

/** Contexto de un frame: solo decodifica, no renderiza ni toca el motor. */
function decoder(): OfflineAudioContext | null {
  if (decodeContext) return decodeContext;
  const Ctor = globalThis.OfflineAudioContext;
  if (typeof Ctor !== 'function') return null;
  try {
    decodeContext = new Ctor(1, 1, 48000);
    return decodeContext;
  } catch {
    return null;
  }
}

function downmix(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (left[i]! + right[i]!) * 0.5;
  return mono;
}

async function runAnalysis(mono: Float32Array, sampleRate: number): Promise<AudioAnalysis> {
  if (typeof Worker !== 'function') return analyzeAudio(mono, sampleRate);
  let worker: Worker;
  try {
    worker = new Worker(new URL('./analysis-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    // Sin worker se pierde la respuesta, no el resultado: el DSP es el mismo.
    return analyzeAudio(mono, sampleRate);
  }
  return new Promise<AudioAnalysis>((resolve, reject) => {
    const finish = (done: () => void) => {
      worker.terminate();
      done();
    };
    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const data = event.data;
      if (data.ok) finish(() => resolve(data.analysis));
      else finish(() => reject(new Error(data.error)));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || 'El analizador se detuvo.')));
    };
    try {
      worker.postMessage(
        { mono, sampleRate } satisfies AnalysisWorkerRequest,
        [mono.buffer],
      );
    } catch (error) {
      worker.terminate();
      reject(error instanceof Error ? error : new Error('No se pudo enviar el audio al analizador.'));
    }
  });
}

/**
 * Decodifica bytes de audio (wav/mp3/ogg/flac) a MONO. Lo usan este
 * analizador y el compositor (perfiles de estilo): un solo sitio decide cómo
 * se baja a mono, para que los dos midan la misma señal.
 *
 * Para un archivo mono no se copia nada: se devuelve el canal tal cual (el
 * AudioBuffer no se vuelve a usar, así que se puede transferir a un worker).
 */
export async function decodeToMono(bytes: ArrayBuffer): Promise<{ mono: Float32Array; sampleRate: number }> {
  const ctx = decoder();
  if (!ctx) throw new Error('Este entorno no puede decodificar audio.');
  const decoded = await ctx.decodeAudioData(bytes);
  if (decoded.length === 0) throw new Error('El audio está vacío.');
  const left = decoded.getChannelData(0);
  const right = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : undefined;
  return { mono: right ? downmix(left, right) : left, sampleRate: decoded.sampleRate };
}

/** Decodifica el archivo y mide tempo/tonalidad; no consulta ni guarda caché. */
async function analyzeNow(sample: SampleRef): Promise<AnalysisSummary> {
  const bytes = await readSampleBytes(sample.path);
  if (!bytes) throw new Error('No se pudo leer el audio del sample.');
  // El worker recibe MONO ya mezclado.
  const { mono, sampleRate } = await decodeToMono(bytes);
  const result = await runAnalysis(mono, sampleRate);
  return summarizeAnalysis(result);
}

// ── Cola ─────────────────────────────────────────────────────────────────────

interface Job {
  sample: SampleRef;
  key: string;
  resolve: (summary: AnalysisSummary | null) => void;
}

const queue: Job[] = [];
const inFlight = new Map<string, Promise<AnalysisSummary | null>>();
let pumping = false;

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve());
    else setTimeout(resolve, 16);
  });
}

function commit(key: string, summary: AnalysisSummary): void {
  const entries = capped({ ...useAudioAnalysis.getState().entries, [key]: summary });
  useAudioAnalysis.setState({ entries });
  persistSoon(entries);
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      let summary: AnalysisSummary | null = null;
      try {
        summary = await analyzeNow(job.sample);
        commit(job.key, summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No se pudo analizar el audio.';
        useAudioAnalysis.setState((s) => ({ errors: { ...s.errors, [job.key]: message } }));
      } finally {
        inFlight.delete(job.key);
        useAudioAnalysis.setState((s) => {
          const pending = { ...s.pending };
          delete pending[job.key];
          return { pending };
        });
        job.resolve(summary);
      }
      await idle();
    }
  } finally {
    pumping = false;
  }
}

/**
 * Analiza un sample (o devuelve lo ya medido). Nunca rechaza: el fallo se
 * guarda en `errors` y se resuelve `null`, porque quien coloca un clip no
 * puede quedarse esperando a que falle algo que es opcional.
 */
export async function analyzeSampleRef(sample: SampleRef): Promise<AnalysisSummary | null> {
  await loadAudioAnalysis();
  const key = analysisKeyOf(sample);
  const cached = useAudioAnalysis.getState().entries[key];
  if (cached) return cached;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const promise = new Promise<AnalysisSummary | null>((resolve) => {
    queue.push({ sample, key, resolve });
  });
  inFlight.set(key, promise);
  useAudioAnalysis.setState((s) => {
    const errors = { ...s.errors };
    delete errors[key];
    return { pending: { ...s.pending, [key]: true }, errors };
  });
  void pump();
  return promise;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/** Resumen de un sample, o undefined si aún no hay análisis. */
export function useAudioAnalysisFor(sample: SampleRef | undefined): AnalysisSummary | undefined {
  return useAudioAnalysis((s) => summaryForSample(sample, s.entries));
}

export function useAudioAnalysisPending(sample: SampleRef | undefined): boolean {
  return useAudioAnalysis((s) => (sample ? s.pending[analysisKeyOf(sample)] === true : false));
}

export function useAudioAnalysisError(sample: SampleRef | undefined): string | undefined {
  return useAudioAnalysis((s) => (sample ? s.errors[analysisKeyOf(sample)] : undefined));
}
