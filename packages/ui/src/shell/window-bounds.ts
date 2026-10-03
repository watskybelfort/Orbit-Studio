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
