/**
 * `DrawRecorder`: el único objeto del host que toca el código del plugin.
 *
 * Es a propósito lo más aburrido posible. No guarda una referencia a un canvas,
 * ni a un contexto, ni a un nodo, ni al worker: solo a un `Float32Array` que se
 * le da al construirlo. Sus métodos escriben opcodes y números ahí y ya. Si el
 * plugin se pone a hurgar en él (`Object.keys`, prototipos, lo que sea) lo único
 * que encuentra es ese array — que es SUYO, se le regala cada frame y el host
 * lo relee validando todo.
 *
 * Tampoco reserva memoria: el buffer viene de fuera y se rellena hasta el tope.
 * Pasado el tope deja de anotar y marca `overflow`; lo escrito hasta ahí se
 * pinta igual. Así un plugin que dibuje un millón de líneas no consigue que la
 * UI reserve un millón de líneas de memoria — solo que su vista salga cortada.
 *
 * Módulo puro: sin DOM, sin React, sin imports de Vite. Se prueba tal cual bajo
 * Node (`packages/ui/test/plugin-view-list.test.ts`).
 */

import { OP, PALETTE_SLOTS, VIEW_MAX_LABELS } from './view-protocol';

export class DrawRecorder {
  /** Buffer donde se anota. Preasignado por quien construye el recorder. */
  private buf: Float32Array;
  private used = 0;
  /** true si alguna orden no cupo: la vista sale cortada, no rota. */
  private clipped = false;
  /** Cuántas etiquetas declaró el plugin (tope real del índice de LABEL). */
  private readonly labelCount: number;

  constructor(buf: Float32Array, labelCount = 0) {
    this.buf = buf;
    this.labelCount = Math.max(0, Math.min(VIEW_MAX_LABELS, Math.floor(labelCount) || 0));
  }

  /** Cambia el buffer de trabajo (el ping-pong devuelve uno distinto cada frame). */
  reset(buf: Float32Array): void {
    this.buf = buf;
    this.used = 0;
    this.clipped = false;
  }

  /** Floats escritos: es la longitud útil que viaja al host. */
  get length(): number {
    return this.used;
  }

  /** ¿Se quedó algo fuera por llenar el buffer? */
  get overflow(): boolean {
    return this.clipped;
  }

  /** Escribe una orden si cabe entera; si no, marca overflow y no escribe nada. */
  private op(code: number, a = 0, b = 0, c = 0, d = 0, argc = 0): void {
    const need = 1 + argc;
    if (this.used + need > this.buf.length) {
      this.clipped = true;
      return;
    }
    const buf = this.buf;
    let i = this.used;
    buf[i++] = code;
    if (argc > 0) buf[i++] = a;
    if (argc > 1) buf[i++] = b;
    if (argc > 2) buf[i++] = c;
    if (argc > 3) buf[i++] = d;
    this.used = i;
  }

  // ── API que ve el plugin ───────────────────────────────────────────────────
  // Todos los argumentos son números en el cuadrado unidad [0,1] salvo donde se
  // diga. No se valida aquí a conciencia: el saneado de verdad lo hace el host
  // al repintar (`view-replay.ts`), porque el buffer podría llegar corrupto por
  // otros caminos y el host no puede fiarse ni de este recorder.

  /** Limpia el área con el color activo. */
  clear(): this {
    this.op(OP.CLEAR);
    return this;
  }

  /** Color activo por índice de paleta (0..7). No hay colores libres. */
  color(slot: number): this {
    this.op(OP.COLOR, slot, 0, 0, 0, 1);
    return this;
  }

  /** Opacidad 0..1. */
  alpha(a: number): this {
    this.op(OP.ALPHA, a, 0, 0, 0, 1);
    return this;
  }

  /** Grosor de línea en píxeles lógicos (0.5..8). */
  width(px: number): this {
    this.op(OP.WIDTH, px, 0, 0, 0, 1);
    return this;
  }

  begin(): this {
    this.op(OP.BEGIN);
    return this;
  }

  moveTo(x: number, y: number): this {
    this.op(OP.MOVE, x, y, 0, 0, 2);
    return this;
  }

  lineTo(x: number, y: number): this {
    this.op(OP.LINE, x, y, 0, 0, 2);
    return this;
  }

  close(): this {
    this.op(OP.CLOSE);
    return this;
  }

  stroke(): this {
    this.op(OP.STROKE);
    return this;
  }

  fill(): this {
    this.op(OP.FILL);
    return this;
  }

  fillRect(x: number, y: number, w: number, h: number): this {
    this.op(OP.FILL_RECT, x, y, w, h, 4);
    return this;
  }

  strokeRect(x: number, y: number, w: number, h: number): this {
    this.op(OP.STROKE_RECT, x, y, w, h, 4);
    return this;
  }

  /** Círculo añadido al trazo actual; el radio se escala por el lado menor. */
  circle(cx: number, cy: number, r: number): this {
    this.op(OP.CIRCLE, cx, cy, r, 0, 3);
    return this;
  }

  /**
   * Pinta una etiqueta del catálogo estático del plugin (`view.labels`).
   * `align`: 0 izquierda, 1 centro, 2 derecha. Si el índice no existe en el
   * catálogo la orden se descarta aquí mismo — no hay texto libre en la vista.
   */
  label(index: number, x: number, y: number, align = 0): this {
    if (!Number.isFinite(index)) return this;
    const i = Math.floor(index);
    if (i < 0 || i >= this.labelCount) return this;
    this.op(OP.LABEL, i, x, y, align, 4);
    return this;
  }

  // ── Atajos ────────────────────────────────────────────────────────────────
  // Azúcar sobre lo de arriba, no órdenes nuevas: no amplían la frontera.

  /** Línea suelta de (x1,y1) a (x2,y2) con el color y grosor activos. */
  line(x1: number, y1: number, x2: number, y2: number): this {
    return this.begin().moveTo(x1, y1).lineTo(x2, y2).stroke();
  }

  /**
   * Polilínea a partir de una función `y = f(x)` evaluada en `steps` puntos.
   * Es el atajo que hace que "enséñame tu curva" quepa en una línea de plugin.
   */
  curve(f: (x: number) => number, steps = 96): this {
    const n = Math.max(2, Math.min(1024, Math.floor(steps) || 2));
    this.begin();
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      const y = f(x);
      if (i === 0) this.moveTo(x, y);
      else this.lineTo(x, y);
    }
    return this.stroke();
  }
}

/** Número de slots de paleta, reexportado para quien construya una vista. */
export const PALETTE_COUNT = PALETTE_SLOTS;
