/**
 * Mínimos reales de cada ventana, alimentados por el propio `InternalWindow`.
 *
 * La tabla vive en `Workspace.tsx` (cada editor pasa su `minW`/`minH`), así que
 * el atajo y el gesto de acople no pueden adivinarla: si `tileWindow` usara un
 * 320×200 genérico, media pantalla en 1160 px serían 580 y Prisma (mínimo 720)
 * se renderizaría a 720, comiéndose la otra mitad. El mínimo se registra al
 * montar y se lee al acoplar, con un fallback igual al default de
 * `InternalWindow` para las ventanas que aún no se dibujaron.
 *
 * Sin imports de la app (los dos de abajo son `import type`, se borran al
 * compilar), como `window-restore.ts`.
 */

import type { WindowId } from './ui';
import type { WorkspaceSize } from '../shell/window-bounds';

/** El default de `InternalWindow` cuando el editor no declara mínimos. */
export const FALLBACK_WINDOW_MINIMUM: WorkspaceSize = { w: 320, h: 200 };

const minimums = new Map<WindowId, WorkspaceSize>();

/**
 * Apunta el mínimo de un editor. No se desregistra a propósito: el mínimo de
 * una ventana es una constante de su componente, y olvidarlo al desmontar
 * abriría una ventana de tiempo (un cierre y un atajo en el mismo tick) en la
 * que el acople volvería a adivinar 320.
 */
export function registerWindowMinimum(id: WindowId, minimum: WorkspaceSize): void {
  if (!(minimum.w > 0) || !(minimum.h > 0)) return;
  minimums.set(id, { w: minimum.w, h: minimum.h });
}

/** Mínimo registrado, o el default de una ventana interna genérica. */
export function windowMinimum(id: WindowId): WorkspaceSize {
  const found = minimums.get(id);
  return found ? { ...found } : { ...FALLBACK_WINDOW_MINIMUM };
}
