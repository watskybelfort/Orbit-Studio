/**
 * Sesión de vista de un plugin: el lado del host de la conversación con el
 * worker que ejecuta su código de dibujo.
 *
 * Aquí viven las tres cosas que hacen que esto sea seguro de verdad y no un
 * canvas con buenas intenciones:
 *
 * 1. **El ping-pong de buffers.** Hay exactamente DOS `Float32Array`: el de
 *    entrada (datos del frame) y el de salida (la lista de dibujo). Se
 *    reservan una vez al abrir la vista y viajan por TRANSFERENCIA, ida y
 *    vuelta, para siempre. No se copia el espectro por frame, no se serializa
 *    un array de objetos, no se genera basura para el GC a 30 fps. Como una
 *    transferencia DESACOPLA el `ArrayBuffer` del lado que lo manda, mientras
 *    el frame está en vuelo este lado no tiene buffers — y eso es justo lo que
 *    impide mandar un segundo frame antes de que vuelva el primero.
 *
 * 2. **El watchdog.** Cada frame se manda con la hora, y en cada vuelta del
 *    `requestAnimationFrame` se comprueba si el que está en vuelo lleva
 *    demasiado sin volver. Si se pasa, se le mata el worker y la vista se
 *    apaga con su motivo. Esto funciona porque el hilo del renderer está
 *    LIBRE: el plugin se cuelga en su worker, no aquí, así que el rAF sigue
 *    corriendo y el watchdog llega a ejecutarse. Ese es el motivo entero de
 *    que el dibujo no corra en el hilo de la UI: en el hilo de la UI un
 *    `while(true)` no lo caza ningún presupuesto, porque el código que lo
 *    cazaría nunca llega a correr.
 *
 * 3. **El presupuesto.** El que no se cuelga pero cuesta 40 ms por frame se
 *    frena y, si insiste, se apaga (`view-budget.ts`).
 *
 * Módulo puro a propósito: habla con un `ViewPort` (post + terminate), no con
 * un `Worker`. Así la prueba de "un plugin que se cuelga no se lleva la UI por
 * delante" se puede escribir bajo Node con un puerto que simplemente no
 * contesta nunca — que es exactamente lo que hace un worker colgado.
 */

import { ViewBudget, type BudgetLimits } from './view-budget';
import {
  IN_DT,
  IN_LEN,
  IN_NPARAMS,
  IN_SAMPLE_RATE,
  IN_T,
  VIEW_LIST_CAP,
} from './view-protocol';

/** Lo que la sesión necesita de un worker. Un `Worker` real lo cumple. */
export interface ViewPort {
  post(message: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
}

/**
 * Tope de espera de un frame antes de dar el worker por colgado.
 *
 * Generoso a propósito: a 30 fps un frame sano vuelve en menos de 5 ms, pero
 * arrancar el worker, compilar el plugin y que el sistema esté ocupado (otra
 * ventana exportando, un GC gordo) puede estirar el primero. Medio segundo es
 * inconfundible: nada que tarde eso está dibujando.
 */
export const VIEW_DEADLINE_MS = 500;

/** Excepciones seguidas del `draw` del plugin antes de apagar la vista. */
export const MAX_DRAW_ERRORS = 3;

export type DeathReason = 'timeout' | 'budget' | 'error' | 'worker' | 'disposed';

export interface ViewSessionOpts {
  port: ViewPort;
  /** Código fuente del plugin (se compila DENTRO del worker, nunca aquí). */
  source: string;
  /** Claves de las perillas, en el orden en que viajan sus valores. */
  paramKeys: readonly string[];
  /** Cuántas etiquetas declaró el plugin (tope del índice de LABEL). */
  labelCount: number;
  sampleRate: number;
  fps: number;
  /** Se llama con la lista de dibujo lista para repintar. */
  onDraw?: (list: Float32Array, len: number) => void;
  /** Se llama una vez cuando la vista se apaga, con el motivo y el detalle. */
  onDeath?: (reason: DeathReason, detail: string) => void;
  deadlineMs?: number;
  budget?: Partial<BudgetLimits>;
}

/** Respuesta del worker con la lista de dibujo (y los buffers de vuelta). */
interface DrawMessage {
  type: 'draw';
  in: Float32Array;
  out: Float32Array;
  len: number;
  cost: number;
  error?: string;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

type WorkerMessage = DrawMessage | ErrorMessage;

function isDrawMessage(m: unknown): m is DrawMessage {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    o['type'] === 'draw' &&
    o['in'] instanceof Float32Array &&
    o['out'] instanceof Float32Array &&
    typeof o['len'] === 'number'
  );
}

function isErrorMessage(m: unknown): m is ErrorMessage {
  return typeof m === 'object' && m !== null && (m as Record<string, unknown>)['type'] === 'error';
}

export class PluginViewSession {
  private readonly port: ViewPort;
  private readonly deadlineMs: number;
  private readonly budget: ViewBudget;
  private readonly opts: ViewSessionOpts;

  /** Buffers propios. `null` mientras están en vuelo (transferidos). */
  private inBuf: Float32Array | null;
  private outBuf: Float32Array | null;

  private sentAt = 0;
  private lastSent = -Infinity;
  private startedAt = 0;
  private lastFrameAt = 0;
  private pending = false;
  private dead: DeathReason | null = null;
  private deathDetail = '';
  private drawErrors = 0;
  private framesDrawn = 0;

  constructor(opts: ViewSessionOpts) {
    this.opts = opts;
    this.port = opts.port;
    this.deadlineMs = opts.deadlineMs ?? VIEW_DEADLINE_MS;
    this.budget = new ViewBudget(opts.fps, opts.budget);
    this.inBuf = new Float32Array(IN_LEN);
    this.outBuf = new Float32Array(VIEW_LIST_CAP);
    this.inBuf[IN_SAMPLE_RATE] = opts.sampleRate;
    this.inBuf[IN_NPARAMS] = opts.paramKeys.length;

    // El código del plugin cruza UNA vez, como texto, y se compila al otro
    // lado. Aquí nunca se hace `new Function` con él.
    this.port.post({
      type: 'init',
      source: opts.source,
      paramKeys: [...opts.paramKeys],
      labelCount: opts.labelCount,
      sampleRate: opts.sampleRate,
    });
  }

  /** Motivo por el que la vista está apagada, o null si sigue viva. */
  get deathReason(): DeathReason | null {
    return this.dead;
  }

  get deathMessage(): string {
    return this.deathDetail;
  }

  get alive(): boolean {
    return this.dead === null;
  }

  /** Frames que el plugin llegó a dibujar (para tests y diagnóstico). */
  get frames(): number {
    return this.framesDrawn;
  }

  /** Media móvil del coste de dibujo del plugin, en ms. */
  get costMs(): number {
    return this.budget.averageMs;
  }

  /** Ritmo efectivo actual (baja solo si el plugin se pasa de presupuesto). */
  get fps(): number {
    return this.budget.fps;
  }

  /**
   * Una vuelta del bucle de dibujo. Se llama desde `requestAnimationFrame`
   * SIEMPRE, aunque no toque mandar frame: es lo que le da al watchdog la
   * oportunidad de cazar a un worker que ya no contesta.
   *
   * `fill` recibe el buffer de entrada para escribir aspecto, flags, params,
   * nivel y espectro. Solo se llama si de verdad se va a mandar un frame.
   */
  tick(now: number, fill: (input: Float32Array) => void): void {
    if (this.dead) return;

    // ── Watchdog ──
    if (this.pending) {
      if (now - this.sentAt > this.deadlineMs) {
        this.kill('timeout', `La vista no respondió en ${Math.round(this.deadlineMs)} ms`);
      }
      return;
    }

    if (this.startedAt === 0) {
      this.startedAt = now;
      this.lastFrameAt = now;
    }
    if (now - this.lastSent < this.budget.minIntervalMs) return;

    const input = this.inBuf;
    const out = this.outBuf;
    if (!input || !out) return; // no debería pasar: los buffers vuelven juntos

    input[IN_T] = (now - this.startedAt) / 1000;
    input[IN_DT] = Math.max(0, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    fill(input);

    this.inBuf = null;
    this.outBuf = null;
    this.pending = true;
    this.sentAt = now;
    this.lastSent = now;
    this.port.post({ type: 'frame', in: input, out }, [
      input.buffer as ArrayBuffer,
      out.buffer as ArrayBuffer,
    ]);
  }

  /**
   * Mensaje del worker.
   *
   * `now` es la hora del HOST, y entra en la firma a propósito aunque hoy solo
   * sirva para dejarlo dicho: el reloj de la sesión no puede salir nunca de un
   * número que mande el worker. Un plugin que reportara `cost: 0` y `now` del
   * futuro se saltaría a la vez el presupuesto y el watchdog.
   */
  handleMessage(data: unknown, now: number): void {
    if (this.dead) return;

    if (isErrorMessage(data)) {
      // Solo lo manda un fallo de arranque (compilar el plugin, o que
      // `createView` reviente): ahí no hay buffers en vuelo que recuperar.
      this.kill('error', String((data as ErrorMessage).message || 'Fallo de la vista'));
      return;
    }
    if (!isDrawMessage(data)) return;

    // Los buffers vuelven SIEMPRE, incluso si el plugin lanzó: si no, la
    // siguiente vuelta no tendría con qué mandar el frame y la vista se
    // quedaría muda sin que nadie supiera por qué.
    this.inBuf = data.in;
    this.outBuf = data.out;
    this.pending = false;

    if (typeof data.error === 'string' && data.error !== '') {
      this.drawErrors++;
      if (this.drawErrors >= MAX_DRAW_ERRORS) {
        this.kill('error', data.error);
      }
      return;
    }
    this.drawErrors = 0;

    const verdict = this.budget.record(typeof data.cost === 'number' ? data.cost : 0);
    if (verdict === 'kill') {
      this.kill(
        'budget',
        `La vista gastaba ${Math.round(this.budget.averageMs)} ms por frame`,
      );
      return;
    }

    this.framesDrawn++;
    const len = Number.isFinite(data.len) ? Math.max(0, Math.min(data.len | 0, data.out.length)) : 0;
    if (len > 0) this.opts.onDraw?.(data.out, len);
  }

  /** El worker murió por su cuenta (error de carga, `messageerror`, etc). */
  handleWorkerError(message: string): void {
    if (this.dead) return;
    this.kill('worker', message || 'El worker de la vista falló');
  }

  /** Cierre normal (se plegó el efecto, se cambió de pista). */
  dispose(): void {
    if (this.dead) return;
    this.dead = 'disposed';
    this.deathDetail = '';
    this.pending = false;
    this.safeTerminate();
  }

  private kill(reason: DeathReason, detail: string): void {
    this.dead = reason;
    this.deathDetail = detail;
    this.pending = false;
    this.safeTerminate();
    this.opts.onDeath?.(reason, detail);
  }

  /**
   * `terminate()` es lo único que de verdad para a un plugin colgado: no hay
   * forma de interrumpir un `while(true)` desde fuera del hilo que lo corre.
   * Se envuelve porque un worker ya muerto puede lanzar al terminarlo, y este
   * camino se recorre justo cuando algo ya ha ido mal.
   */
  private safeTerminate(): void {
    try {
      this.port.terminate();
    } catch {
      // ya estaba muerto: nada que terminar
    }
  }
}
