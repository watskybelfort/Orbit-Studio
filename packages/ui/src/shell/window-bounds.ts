export interface WorkspaceSize { w: number; h: number }
export interface WindowBox extends WorkspaceSize { x: number; y: number }

/** Punto del puntero, en px de layout (los mismos del rect del escritorio). */
export interface WorkspacePoint { x: number; y: number }

/** Zonas de acople: media pantalla a un lado o maximizar (franja superior). */
export type SnapZone = 'left' | 'right' | 'top';

/**
 * Franja de acople, en px. 14 es el orden de magnitud que usan las ventanas
 * nativas de Windows y se siente «pegajoso» sin robar clics: el asa de
 * redimensión de estas ventanas mide justo 14, así que el gesto se reconoce
 * con la misma tolerancia con la que se agarra.
 */
export const SNAP_EDGE = 14;

/** Mínimos compartidos por el render de Workspace y sus presets. */
export const PRESET_EDITOR_MINIMUMS = {
  channelRack: { w: 320, h: 200 },
  pianoRoll: { w: 560, h: 200 },
  playlist: { w: 480, h: 200 },
  mixer: { w: 560, h: 200 },
} as const;

/**
 * Geometría visible, no persistida. Al recuperar espacio vuelve el tamaño que
 * el usuario guardó; arrastrar parte de esta caja para que no haya saltos.
 * En pantallas menores que el mínimo prima poder llegar a los controles.
 */
export function fitWindowToWorkspace(
  box: WindowBox,
  area: WorkspaceSize | null,
  minimum: WorkspaceSize,
): WindowBox {
  if (!area || area.w <= 0 || area.h <= 0) return box;
  const w = Math.min(area.w, Math.max(minimum.w, box.w));
  const h = Math.min(area.h, Math.max(minimum.h, box.h));
  return {
    w,
    h,
    x: Math.max(0, Math.min(box.x, area.w - w)),
    y: Math.max(0, Math.min(box.y, area.h - h)),
  };
}

/**
 * Tamaño de una ventana mientras se redimensiona, sin pasarse del borde del
 * escritorio.
 *
 * El render ya recorta (`fitWindowToWorkspace`), y por eso el gesto se sentía
 * roto: al arrastrar el asa hacia la derecha la ventana dejaba de crecer en
 * pantalla mientras el store seguía creciendo; al volver hacia la izquierda no
 * pasaba nada visible durante cientos de píxeles. Acotar aquí hace que el
 * store y lo que se ve cuenten la misma historia desde el primer píxel.
 *
 * `area` nula (ventana desacoplada: su tamaño lo manda el sistema) no acota,
 * solo respeta los mínimos.
 */
export function clampResize(
  box: WindowBox,
  area: WorkspaceSize | null,
  minimum: WorkspaceSize,
): WorkspaceSize {
  if (!area || area.w <= 0 || area.h <= 0) {
    return { w: Math.max(minimum.w, box.w), h: Math.max(minimum.h, box.h) };
  }
  const maxW = Math.max(Math.min(minimum.w, area.w), area.w - Math.max(0, box.x));
  const maxH = Math.max(Math.min(minimum.h, area.h), area.h - Math.max(0, box.y));
  return {
    w: Math.min(Math.max(minimum.w, box.w), maxW),
    h: Math.min(Math.max(minimum.h, box.h), maxH),
  };
}

// ── Maximizar y acoplar ──────────────────────────────────────────────────────

/**
 * Caja maximizada: ocupa el escritorio desde la esquina.
 *
 * El mínimo NO puede empujar la caja fuera del área: en una pantalla más chica
 * que él manda la pantalla, la misma política que `fitWindowToWorkspace` y
 * `clampResize` (si no, «maximizar» en un portátil al 150 % escondería el asa
 * de cierre justo cuando el usuario pide ver todo).
 */
export function maximizeBox(area: WorkspaceSize, minimum: WorkspaceSize): WindowBox {
  const w = Math.max(0, Math.min(Math.max(minimum.w, area.w), area.w));
  const h = Math.max(0, Math.min(Math.max(minimum.h, area.h), area.h));
  return { x: 0, y: 0, w, h };
}

/**
 * Caja acoplada a una mitad (`left`/`right`) o maximizada (`top`: la franja
 * superior del escritorio es la zona de maximizar).
 *
 * Si el escritorio no da para dos mínimos, no hay reparto posible y se devuelve
 * el área completa; una mitad de 120 px para un mínimo de 320 solo escondería
 * controles y encima mentiría sobre dónde va la ventana. Nunca devuelve
 * negativos, ni siquiera con un área a cero.
 */
export function tileBox(
  area: WorkspaceSize,
  side: SnapZone,
  minimum: WorkspaceSize = { w: 0, h: 0 },
): WindowBox {
  if (side === 'top') return maximizeBox(area, minimum);
  const full = maximizeBox(area, minimum);
  const half = Math.floor(Math.max(0, area.w) / 2);
  if (half < Math.max(0, minimum.w)) return full;
  return {
    x: side === 'left' ? 0 : Math.max(0, area.w - half),
    y: 0,
    // El alto sale de `full` para respetar la regla del mínimo contra el área.
    w: half,
    h: full.h,
  };
}

/**
 * Zona de acople bajo el puntero, o `null` si está lejos de un borde.
 *
 * `area` es el rectángulo de `.workspace` **en px de layout** —los de
 * `getBoundingClientRect()`, que ya vienen con la escala de UI aplicada por el
 * shim; no hay que dividir por el zoom—. `point` va en esa misma unidad
 * (`clientX/clientY`).
 *
 * Las franjas laterales ganan en las esquinas: el gesto frecuente es media
 * pantalla y la franja superior sigue disponible en todo el ancho salvo esos
 * pocos píxeles. Fuera del escritorio (ratón sobre el navegador o el panel de
 * Claude, que son hermanos del workspace) no hay acople: esas zonas no son
 * parte del escritorio interno.
 */
export function snapZoneAt(
  point: WorkspacePoint,
  area: WindowBox,
  edge: number = SNAP_EDGE,
): SnapZone | null {
  if (area.w <= 0 || area.h <= 0 || edge <= 0) return null;
  const dx = point.x - area.x;
  const dy = point.y - area.y;
  if (dx < 0 || dy < 0 || dx > area.w || dy > area.h) return null;
  // Sin dos franjas laterales no hay mitad que ofrecer; la superior sigue.
  if (area.w > edge * 2) {
    if (dx <= edge) return 'left';
    if (area.w - dx <= edge) return 'right';
  }
  if (dy <= edge) return 'top';
  return null;
}

/**
 * ¿La caja ocupa el escritorio? Tolerancia de 1 px por defecto: el store puede
 * guardar redondeos y una ventana «casi» maximizada tiene que seguir leyéndose
 * como maximizada (si no, el botón diría «maximizar» sobre una ventana que ya
 * lo está y el segundo clic no haría nada visible).
 */
export function isMaximizedBox(
  box: WindowBox,
  area: WorkspaceSize,
  tolerance = 1,
): boolean {
  if (area.w <= 0 || area.h <= 0) return false;
  const t = Math.max(0, tolerance);
  return (
    Math.abs(box.x) <= t
    && Math.abs(box.y) <= t
    && Math.abs(box.w - area.w) <= t
    && Math.abs(box.h - area.h) <= t
  );
}
