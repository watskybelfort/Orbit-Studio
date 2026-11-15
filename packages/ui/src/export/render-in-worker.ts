/**
 * Cliente del worker de render (render-worker.ts): mismas firmas que
 * `renderProject`/`renderStems` del engine, pero el cómputo (y la ejecución de
 * los plugins JS) ocurre en un worker aislado, no en el hilo de la UI.
 *
 * **Un worker POR DUEÑO, no uno solo.** La cancelación real de un render es
 * tirar el worker entero (`cancelActiveRenderWorker`): el bucle de render es
 * síncrono y no atiende mensajes a mitad, así que no hay forma de pedirle a un
 * worker compartido "corta ESTA petición y sigue con la otra". Con un worker
 * único, cancelar el export mataba también el Consolidar o el Congelar que
 * estuviera corriendo en paralelo — su promesa se rechazaba con "Export
 * cancelado por el usuario" y su WAV nunca se escribía. Ahora cada dueño
 * (`export`, `bounce`, y `default` para cualquier otro) tiene su carril: sus
 * peticiones y su worker, y cancelar uno no toca el otro.
 *
 * Dentro de un carril el worker se reutiliza y las peticiones se casan por id.
 * Si el worker no está disponible (test/Node), el llamante debe caer al render
 * directo.
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

/**
 * Dueño de un worker. `export` y `bounce` son los dos que pueden correr a la
 * vez en la app; `default` queda para llamadas nuevas que no elijan carril
 * (no pierden el comportamiento de siempre y no comparten el de nadie).
 */
export type RenderLane = 'export' | 'bounce' | 'default';

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

interface Lane {
  worker: Worker | null;
  seq: number;
  pending: Map<number, PendingRequest>;
}

const lanes = new Map<RenderLane, Lane>();

function laneOf(key: RenderLane): Lane {
  let lane = lanes.get(key);
  if (!lane) {
    lane = { worker: null, seq: 0, pending: new Map() };
    lanes.set(key, lane);
  }
  return lane;
}

/** ¿Se puede usar el worker aquí? (No en Node/tests). */
export function canUseRenderWorker(): boolean {
  return typeof Worker !== 'undefined';
}

/**
 * Rechaza lo pendiente DEL CARRIL y tira su worker.
 *
 * Lo importante es dejar `worker = null`: rechazar y quedarse con el cadáver
 * dejaba a `getWorker()` devolviéndolo para siempre, y `postMessage` a un
 * worker muerto no hace nada ni falla — la siguiente petición se quedaba
 * colgada sin resolver NUNCA. Y con ella, el `running` del export y el `busy`
 * del bounce, que solo se bajan en su `finally`: a partir de ahí cualquier
 * export decía "ya hay uno en marcha" y Consolidar y Congelar dejaban de
 * funcionar sin decir nada.
 */
function killLane(reason: string, key: RenderLane): void {
  const lane = lanes.get(key);
  if (!lane) return;
  for (const [, p] of lane.pending) p.reject(new Error(reason));
  lane.pending.clear();
  try {
    lane.worker?.terminate();
  } catch {
    // ya estaba muerto: nada que terminar
  }
  // El carril entero se va: la próxima petición crea worker y contador nuevos.
  lanes.delete(key);
}

/**
 * Corta YA lo que ese carril esté haciendo, sea lo que sea. Es la única forma
 * real de cancelar un render A MITAD de camino cuando corre en el worker: el
 * bucle de `renderProject` (packages/engine/src/render/offline.ts) es
 * síncrono y no cede el hilo, así que un `postMessage` de cancelación se
 * quedaría en la cola de eventos del worker sin procesarse hasta que ese
 * bucle termine solo — exactamente el problema que se quiere resolver.
 *
 * Tirar el worker SÍ interrumpe de inmediato, y a coste CERO en el bucle
 * caliente: no hay nada que comprobar ahí dentro para este camino (a
 * diferencia de `RenderOptions.isCancelled`, que es el mecanismo equivalente
 * para cuando no hay worker — Node/tests, o quien llame a `renderProject`
 * directo).
 */
export function cancelActiveRenderWorker(key: RenderLane = 'default'): void {
  const lane = lanes.get(key);
  if (!lane || lane.pending.size === 0) return; // nada corriendo: nada que cortar
  killLane('Render cancelado por el usuario.', key);
}

/**
 * Solo para tests: tira TODOS los carriles aunque estén ociosos. Sin esto, el
 * worker cacheado de un test anterior reaparece en el siguiente (que ya reseteó
 * su lista de instancias) y no se crea ninguno nuevo.
 */
export function resetRenderWorkerLanes(): void {
  for (const key of [...lanes.keys()]) killLane('reset de tests', key);
}

function getWorker(key: RenderLane): Worker {
  const lane = laneOf(key);
  if (!lane.worker) {
    const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });
    lane.worker = worker;
    worker.addEventListener('message', (e: MessageEvent<Resp | ProgressMsg>) => {
      // El carril pudo morir entre el envío y la respuesta: el mensaje tardío
      // no puede resucitar una petición ni tocar el worker nuevo.
      const current = lanes.get(key);
      if (current !== lane) return;
      const p = lane.pending.get(e.data.id);
      if (!p) return;
      if (isProgressMsg(e.data)) {
        // No resuelve nada: solo avisa y rearma el watchdog de la petición.
        p.touch();
        p.onProgress?.(e.data.progress.index, e.data.progress.total);
        return;
      }
      lane.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error ?? 'Fallo en el worker de render'));
    });
    worker.addEventListener('error', (e) => {
      killLane(e.message || 'Error del worker de render', key);
    });
    worker.addEventListener('messageerror', () => {
      killLane('El worker de render mandó un mensaje ilegible', key);
    });
  }
  return lane.worker;
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
  key: RenderLane,
  onProgress?: (index: number, total: number) => void,
): Promise<Resp> {
  const lane = laneOf(key);
  const id = ++lane.seq;
  const w = getWorker(key);
  return new Promise<Resp>((resolve, reject) => {
    // El timer se REARMA en cada progreso intermedio (`touch`, más abajo): el
    // tope es para un worker que se calla del todo, no para el total de una
    // petición con muchas pistas — antes cada stem tenía sus 15 min propios
    // en una petición separada; agrupar todos en una sola no debe recortar
    // ese presupuesto a una sola pista.
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      timer = setTimeout(() => {
        if (!lane.pending.has(id)) return;
        killLane('El worker de render no respondió', key);
      }, REQUEST_TIMEOUT_MS);
    };
    const done = <T>(fn: (value: T) => void) => (value: T) => {
      clearTimeout(timer);
      fn(value);
    };
    lane.pending.set(id, {
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
  lane: RenderLane = 'default',
): Promise<RenderResult> {
  const resp = await request({ kind: 'project', compiled, opts }, lane);
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
  lane: RenderLane = 'default',
): Promise<StemBatchResult> {
  const resp = await request({ kind: 'stems', compiled, trackIndices, opts }, lane, onProgress);
  const results = new Map<number, RenderResult>();
  for (const s of resp.stems ?? []) results.set(s.idx, s.result);
  const errors = new Map<number, string>();
  for (const f of resp.failed ?? []) errors.set(f.idx, f.error);
  return { results, errors };
}
