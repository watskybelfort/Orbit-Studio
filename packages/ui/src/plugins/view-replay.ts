/**
 * Repintado de la lista de dibujo de un plugin: el lado de ACÁ de la frontera.
 *
 * Esto es lo que convierte los números que mandó el worker en píxeles, y es el
 * sitio donde se desconfía de ellos. Da igual que el `DrawRecorder` ya recorte
 * cosas: ese recorder corre DENTRO del worker, junto al código del plugin, así
 * que el host no puede fiarse de que lo que llega salga de él. Aquí se asume
 * que el buffer es hostil:
 *
 * - la longitud se recorta al tamaño real del buffer,
 * - un opcode desconocido corta el repintado en seco (un flujo corrupto no se
 *   puede resincronizar: seguir leyendo sería interpretar coordenadas como
 *   órdenes),
 * - una orden a medio terminar al final del buffer se descarta,
 * - toda coordenada pasa por `clamp01`, que además convierte NaN en 0 — un solo
 *   NaN dentro de un `lineTo` envenena el trazo entero del canvas y deja de
 *   pintarse todo, no solo ese punto,
 * - el color es un índice a la paleta del host (no una cadena CSS), la
 *   opacidad y el grosor van recortados a rangos visibles, y el texto sale del
 *   catálogo estático del plugin, no del buffer.
 *
 * El objetivo no es que un plugin malo dibuje bonito: es que NO pueda hacer
 * nada más que dibujar, y que si dibuja basura la basura se quede dentro de su
 * rectángulo.
 *
 * Módulo puro: recibe un objeto con la pinta de un contexto 2D, no un canvas,
 * así que se prueba bajo Node con un doble que apunta las llamadas.
 */

import {
  MAX_ALPHA,
  MAX_LINE_WIDTH,
  MIN_ALPHA,
  MIN_LINE_WIDTH,
  OP,
  OP_ARITY,
  clamp01,
  clampIndex,
  clampTo,
} from './view-protocol';

/**
 * Lo mínimo de un contexto 2D que usa el repintado.
 *
 * `fillStyle`/`strokeStyle` van como `unknown` para que un
 * `CanvasRenderingContext2D` real encaje sin castear (el suyo admite gradientes
 * y patrones además de cadenas); aquí solo se les escriben cadenas de la
 * paleta.
 */
export interface Canvas2DLike {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  textAlign: string;
  textBaseline: string;
  font: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  fillText(text: string, x: number, y: number): void;
}

export interface ReplayOpts {
  /** Ancho del área en píxeles lógicos (el dpr ya lo aplica la transformación). */
  width: number;
  height: number;
  /** Colores ya resueltos desde las variables de tema, por índice de paleta. */
  palette: readonly string[];
  /** Catálogo de etiquetas del plugin, ya saneado por el parser. */
  labels: readonly string[];
  /** Fuente para las etiquetas (la de la UI). */
  font: string;
}

export interface ReplayStats {
  /** Órdenes ejecutadas. */
  ops: number;
  /** true si se cortó por un opcode desconocido o una orden incompleta. */
  aborted: boolean;
}

const ALIGNS = ['left', 'center', 'right'] as const;

/**
 * Repinta `buf[0..len)` sobre `ctx`. Devuelve cuántas órdenes se ejecutaron y
 * si hubo que cortar. Nunca lanza: un buffer corrupto se corta, no revienta el
 * bucle de dibujo de la UI.
 */
export function replayDisplayList(
  ctx: Canvas2DLike,
  buf: Float32Array,
  len: number,
  opts: ReplayOpts,
): ReplayStats {
  const W = opts.width;
  const H = opts.height;
  const minSide = Math.min(W, H);
  const palette = opts.palette;
  const labels = opts.labels;

  // Estado de partida conocido: el plugin no hereda lo que dejó el frame
  // anterior ni lo que hubiera dibujado otro.
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = opts.font;
  let color = palette[0] ?? '#000';
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  const end = Math.max(0, Math.min(len | 0, buf.length));
  let i = 0;
  let ops = 0;
  let aborted = false;

  while (i < end) {
    const code = buf[i]!;
    // Opcode: entero conocido o se corta. No se intenta resincronizar.
    if (!Number.isInteger(code) || code < 0 || code >= OP_ARITY.length) {
      aborted = true;
      break;
    }
    const arity = OP_ARITY[code]!;
    if (arity < 0) {
      aborted = true;
      break;
    }
    if (i + 1 + arity > end) {
      // Orden cortada por la mitad al final del buffer.
      aborted = true;
      break;
    }
    const a0 = arity > 0 ? buf[i + 1]! : 0;
    const a1 = arity > 1 ? buf[i + 2]! : 0;
    const a2 = arity > 2 ? buf[i + 3]! : 0;
    const a3 = arity > 3 ? buf[i + 4]! : 0;
    i += 1 + arity;
    ops++;

    switch (code) {
      case OP.CLEAR:
        ctx.clearRect(0, 0, W, H);
        ctx.fillRect(0, 0, W, H);
        break;
      case OP.COLOR: {
        color = palette[clampIndex(a0, palette.length)] ?? color;
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        break;
      }
      case OP.ALPHA:
        ctx.globalAlpha = clampTo(a0, MIN_ALPHA, MAX_ALPHA);
        break;
      case OP.WIDTH:
        ctx.lineWidth = clampTo(a0, MIN_LINE_WIDTH, MAX_LINE_WIDTH);
        break;
      case OP.BEGIN:
        ctx.beginPath();
        break;
      case OP.MOVE:
        ctx.moveTo(clamp01(a0) * W, clamp01(a1) * H);
        break;
      case OP.LINE:
        ctx.lineTo(clamp01(a0) * W, clamp01(a1) * H);
        break;
      case OP.CLOSE:
        ctx.closePath();
        break;
      case OP.STROKE:
        ctx.stroke();
        break;
      case OP.FILL:
        ctx.fill();
        break;
      case OP.FILL_RECT:
        ctx.fillRect(clamp01(a0) * W, clamp01(a1) * H, clamp01(a2) * W, clamp01(a3) * H);
        break;
      case OP.STROKE_RECT:
        ctx.strokeRect(clamp01(a0) * W, clamp01(a1) * H, clamp01(a2) * W, clamp01(a3) * H);
        break;
      case OP.CIRCLE:
        ctx.arc(clamp01(a0) * W, clamp01(a1) * H, clamp01(a2) * minSide, 0, Math.PI * 2);
        break;
      case OP.LABEL: {
        if (labels.length === 0) break;
        const text = labels[clampIndex(a0, labels.length)];
        if (text === undefined) break;
        ctx.textAlign = ALIGNS[clampIndex(a3, ALIGNS.length)]!;
        ctx.fillText(text, clamp01(a1) * W, clamp01(a2) * H);
        ctx.textAlign = 'left';
        break;
      }
      default:
        // Inalcanzable: OP_ARITY solo tiene aridad >= 0 en los opcodes de OP.
        aborted = true;
        break;
    }
    if (aborted) break;
  }

  ctx.globalAlpha = 1;
  return { ops, aborted };
}
