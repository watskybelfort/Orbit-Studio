/**
 * Presupuesto de tiempo de la vista de un plugin.
 *
 * Un plugin que se cuelga del todo lo caza el watchdog del `ViewSession` (no
 * contesta y se le mata el worker). Pero hay un caso peor por lo callado que
 * es: el plugin que SÍ contesta, solo que tarda 40 ms por frame. No cuelga
 * nada, no lanza nada, y aun así se come el presupuesto de 60 fps de la
 * ventana, calienta el portátil y —en un portátil con la batería justa— acaba
 * afectando al audio, porque el hilo de audio compite por la misma CPU.
 *
 * Por eso el worker mide lo que tarda el `draw` del plugin y lo reporta, y esto
 * decide qué hacer con ese número:
 *
 * - por encima del presupuesto BLANDO (media móvil), se le baja el ritmo:
 *   sigue viéndose, pero a 12 fps en vez de a 30. Con histéresis, para que no
 *   oscile entre los dos ritmos frame sí frame no.
 * - por encima del presupuesto DURO, se le apunta un aviso; a los N avisos la
 *   vista se apaga. No se apaga al primero a propósito: un pico aislado puede
 *   ser un GC de la propia página o que el usuario acaba de arrastrar la
 *   ventana a otra pantalla.
 *
 * Módulo puro y sin reloj propio (recibe los costes ya medidos): se prueba
 * entero bajo Node.
 */

export interface BudgetLimits {
  /** Media móvil por encima de la cual se baja el ritmo (ms por frame). */
  softMs: number;
  /** Coste de un frame que cuenta como aviso (ms). */
  hardMs: number;
  /** Avisos duros que hacen falta para apagar la vista. */
  strikes: number;
  /** Ritmo al que se cae cuando se pasa del presupuesto blando. */
  slowFps: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  // 4 ms de un frame de 16.6 ms es ya mucho para un adorno; a partir de ahí
  // se dibuja igual, pero más espaciado.
  softMs: 4,
  // 30 ms es más de lo que dura un frame entero: eso ya se nota como tirón.
  hardMs: 30,
  strikes: 12,
  slowFps: 12,
};

export type BudgetVerdict = 'ok' | 'slow' | 'kill';

/** Peso del pasado en la media móvil del coste. */
const EMA_ALPHA = 0.2;
/** Se vuelve al ritmo normal por debajo de este factor del umbral blando. */
const RECOVER_FACTOR = 0.6;

export class ViewBudget {
  private readonly limits: BudgetLimits;
  private readonly normalFps: number;
  private avg = 0;
  private primed = false;
  private strikes = 0;
  private slowed = false;
  private killed = false;

  constructor(normalFps: number, limits: Partial<BudgetLimits> = {}) {
    this.normalFps = normalFps;
    this.limits = { ...DEFAULT_BUDGET, ...limits };
  }

  /** Media móvil del coste por frame (ms). */
  get averageMs(): number {
    return this.avg;
  }

  /** Avisos duros acumulados. */
  get strikeCount(): number {
    return this.strikes;
  }

  /** Ritmo al que se le deben pedir frames ahora mismo. */
  get fps(): number {
    return this.slowed ? Math.min(this.normalFps, this.limits.slowFps) : this.normalFps;
  }

  /** Milisegundos mínimos entre frames, derivados de `fps`. */
  get minIntervalMs(): number {
    return 1000 / Math.max(1, this.fps);
  }

  /**
   * Anota lo que costó un frame y devuelve el veredicto. Una vez que devuelve
   * `kill` lo sigue devolviendo siempre: apagar es definitivo hasta que se
   * vuelva a abrir la vista.
   */
  record(costMs: number): BudgetVerdict {
    if (this.killed) return 'kill';
    const cost = Number.isFinite(costMs) && costMs > 0 ? costMs : 0;

    this.avg = this.primed ? this.avg * (1 - EMA_ALPHA) + cost * EMA_ALPHA : cost;
    this.primed = true;

    if (cost >= this.limits.hardMs) {
      this.strikes++;
      if (this.strikes >= this.limits.strikes) {
        this.killed = true;
        return 'kill';
      }
    }

    if (!this.slowed && this.avg > this.limits.softMs) {
      this.slowed = true;
      return 'slow';
    }
    if (this.slowed && this.avg < this.limits.softMs * RECOVER_FACTOR) {
      this.slowed = false;
    }
    return this.slowed ? 'slow' : 'ok';
  }
}
