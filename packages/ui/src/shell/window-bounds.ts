export interface WorkspaceSize { w: number; h: number }
export interface WindowBox extends WorkspaceSize { x: number; y: number }

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
