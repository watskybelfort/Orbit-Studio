/**
 * Cliente del worker de render (render-worker.ts): mismas firmas que
 * `renderProject`/`renderStems` del engine, pero el cómputo (y la ejecución de
 * los plugins JS) ocurre en un worker aislado, no en el hilo de la UI.
 *
 * Un solo worker reutilizado; las peticiones se casan por id. Si el worker no
 * está disponible (test/Node), el llamante debe caer al render directo.
 */

import type { CompiledProject, RenderResult, SampleData, StemBatchResult } from '@orbit/engine';

export interface WorkerRenderOpts {
  samples?: Map<string, SampleData>;
  plugins?: Map<string, string>;
  sampleRate?: number;
  tailSeconds?: number;
  startBeat?: number;
  endBeat?: number;
}

interface Resp {
  id: number;
  ok: boolean;
  error?: string;
  result?: RenderResult;
  stems?: { idx: number; result: RenderResult }[];
  /** Pistas del lote que reventaron sin tirar la petición entera. Ver `renderStemsInWorker`. */
  failed?: { idx: number; error: string }[];
}

/**
 * Mensaje intermedio del worker: no resuelve la petición (no lleva `ok`),
 * solo informa que empezó a renderizar la pista `index` de `total`. Casado
 * por el mismo `id` que la petición — ver `request()`.
 */
interface ProgressMsg {
  id: number;
  progress: { index: number; total: number };
}

function isProgressMsg(data: Resp | ProgressMsg): data is ProgressMsg {
  return 'progress' in data;
}

interface PendingRequest {
  resolve: (r: Resp) => void;
  reject: (e: Error) => void;
  onProgress?: (index: number, total: number) => void;
  /** Rearma el watchdog: un progreso intermedio cuenta como "sigue vivo". */
  touch: () => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, PendingRequest>();

/** ¿Se puede usar el worker aquí? (No en Node/tests). */
export function canUseRenderWorker(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Rechaza lo pendiente y TIRA el worker.
 *
 * Lo importante es el `worker = null`: rechazar y quedarse con el cadáver
 * dejaba a `getWorker()` devolviéndolo para siempre, y `postMessage` a un
 * worker muerto no hace nada ni falla — la siguiente petición se quedaba
 * colgada sin resolver NUNCA. Y con ella, el `running` del export y el `busy`
 * del bounce, que solo se bajan en su `finally`: a partir de ahí cualquier
 * export decía "ya hay uno en marcha" y Consolidar y Congelar dejaban de
 * funcionar sin decir nada.
 */
function killWorker(reason: string): void {
  for (const [, p] of pending) p.reject(new Error(reason));
  pending.clear();
  try {
    worker?.terminate();
  } catch {
    // ya estaba muerto: nada que terminar
  }
  worker = null;
}

/**
 * Corta YA lo que el worker esté haciendo, sea lo que sea. Es la única forma
 * real de cancelar un render A MITAD de camino cuando corre en el worker: el
 * bucle de `renderProject` (packages/engine/src/render/offline.ts) es
 * síncrono y no cede el hilo, así que un `postMessage` de cancelación se
 * quedaría en la cola de eventos del worker sin procesarse hasta que ese
 * bucle termine solo — exactamente el problema que se quiere resolver.
 *
 * Tirar el worker entero SÍ interrumpe de inmediato, y a coste CERO en el
 * bucle caliente: no hay nada que comprobar ahí dentro para este camino (a
 * diferencia de `RenderOptions.isCancelled`, que es el mecanismo equivalente
 * para cuando no hay worker — Node/tests, o quien llame a `renderProject`
 * directo). `killWorker` ya reserva lo pendiente y limpia `worker` a null
 * para que la siguiente petición cree uno nuevo: reutilizarlo aquí evita
 * duplicar esa lógica de "no dejar un cadáver colgado".
 */
export function cancelActiveRenderWorker(): void {
  if (pending.size === 0) return; // nada corriendo ahora mismo: no hay nada que cortar
  killWorker('Export cancelado por el usuario.');
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<Resp | ProgressMsg>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (isProgressMsg(e.data)) {
        // No resuelve nada: solo avisa y rearma el watchdog de la petición.
        p.touch();
        p.onProgress?.(e.data.progress.index, e.data.progress.total);
        return;
      }
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error ?? 'Fallo en el worker de render'));
    });
    worker.addEventListener('error', (e) => {
      killWorker(e.message || 'Error del worker de render');
    });
    worker.addEventListener('messageerror', () => {
      killWorker('El worker de render mandó un mensaje ilegible');
    });
  }
  return worker;
}

/**
 * Tope de seguridad por petición. Un render largo puede tardar de verdad (una
 * canción de diez minutos con reverbs no es raro), así que es generoso: está
 * para que un worker que muera en silencio no deje la UI trabada, no para
 * cortar trabajo legítimo.
 */
const REQUEST_TIMEOUT_MS = 15 * 60_000;

function request(
  msg: Record<string, unknown>,
  onProgress?: (index: number, total: number) => void,
): Promise<Resp> {
  const id = ++seq;
  const w = getWorker();
  return new Promise<Resp>((resolve, reject) => {
    // El timer se REARMA en cada progreso intermedio (`touch`, más abajo): el
    // tope es para un worker que se calla del todo, no para el total de una
    // petición con muchas pistas — antes cada stem tenía sus 15 min propios
    // en una petición separada; agrupar todos en una sola no debe recortar
    // ese presupuesto a una sola pista.
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (!pending.has(id)) return;
        killWorker('El worker de render no respondió');
      }, REQUEST_TIMEOUT_MS);
    };
    const done = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    pending.set(id, {
      resolve: done(resolve),
      reject: done(reject),
      onProgress,
      touch: () => {
        clearTimeout(timer);
        arm();
      },
    });
    arm();
    w.postMessage({ ...msg, id });
  });
}

export async function renderProjectInWorker(
  compiled: CompiledProject,
  opts: WorkerRenderOpts,
): Promise<RenderResult> {
  const resp = await request({ kind: 'project', compiled, opts });
  if (!resp.result) throw new Error('El worker no devolvió el render');
  return resp.result;
}

/**
 * Renderiza VARIAS pistas en una sola petición al worker (un único structured
 * clone de `opts.samples`, no uno por pista). `onProgress(index, total)` —si
 * se pasa— se llama una vez al empezar cada pista de `trackIndices`, en su
 * mismo orden, a partir de los mensajes intermedios del worker.
 *
 * La petición resuelve igual —`results` con lo que salió, `errors` con lo que
 * no— tanto si todas las pistas del lote van bien como si alguna revienta: el
 * worker ya aísla ese fallo por pista (ver `renderStems` en el engine), así
 * que esto solo rechaza la promesa cuando falla la petición ENTERA (el propio
 * worker muere, o manda algo ilegible), no cuando una pista del lote fallaba.
 */
export async function renderStemsInWorker(
  compiled: CompiledProject,
  trackIndices: number[],
  opts: WorkerRenderOpts,
  onProgress?: (index: number, total: number) => void,
): Promise<StemBatchResult> {
  const resp = await request({ kind: 'stems', compiled, trackIndices, opts }, onProgress);
  const results = new Map<number, RenderResult>();
  for (const s of resp.stems ?? []) results.set(s.idx, s.result);
  const errors = new Map<number, string>();
  for (const f of resp.failed ?? []) errors.set(f.idx, f.error);
  return { results, errors };
}
