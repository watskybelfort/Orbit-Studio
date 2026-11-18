/**
 * Acciones de escritorio sobre las ventanas internas: maximizar, acoplar a una
 * mitad y restaurar. Es la lógica que comparten el botón de la cabecera, el
 * doble clic, el gesto de arrastre y los atajos.
 *
 * Dos decisiones que explican la forma del módulo:
 *
 * 1. **Sin campos nuevos en `useUiStore`.** La caja de vuelta es efímera y vive
 *    en `window-restore`; el store sigue siendo la geometría visible y abierta.
 *    Así ningún guardado de settings ni serialización del proyecto se entera de
 *    que existió un «maximizado».
 * 2. **`workspaceArea` se importa de `layouts.ts`, y `layouts.ts` NO importa de
 *    aquí**: al aplicar un layout solo necesita limpiar el `Map`, y lo hace
 *    contra `window-restore`. El grafo queda layouts → window-restore y
 *    window-actions → layouts + window-restore, sin ciclo.
 *
 * Las ventanas desacopladas se ignoran: su tamaño lo manda la ventana nativa
 * del sistema (ver `DetachedWindow`), así que maximizar o acoplar «la interna»
 * cuando no está en el escritorio sería mover una caja que nadie ve.
 */

import { useDetachedStore } from './detached';
import { workspaceArea } from './layouts';
import { useUiStore, type WindowId } from './ui';
import { windowMinimum } from './window-minimums';
import {
  isMarkedMaximized,
  markMaximized,
  peekWindowBox,
  rememberWindowBox,
  takeWindowBox,
  unmarkMaximized,
} from './window-restore';
import {
  fitWindowToWorkspace,
  isMaximizedBox,
  maximizeBox,
  tileBox,
  type SnapZone,
  type WindowBox,
  type WorkspaceSize,
} from '../shell/window-bounds';

export { clearWindowRestore } from './window-restore';

function isDetached(id: WindowId): boolean {
  return useDetachedStore.getState().detached[id] === true;
}

/** Escribe x/y/w/h sin tocar `open` ni `z`, y sin repintar si no cambió nada. */
function setBox(id: WindowId, box: WindowBox): void {
  useUiStore.setState((s) => {
    const win = s.windows[id];
    if (!win) return s;
    if (win.x === box.x && win.y === box.y && win.w === box.w && win.h === box.h) return s;
    return { windows: { ...s.windows, [id]: { ...win, x: box.x, y: box.y, w: box.w, h: box.h } } };
  });
}

/** La ventana abierta con mayor z, saltando las que viven fuera. */
export function activeWindowId(): WindowId | null {
  const ui = useUiStore.getState();
  let active: WindowId | null = null;
  let topZ = -Infinity;
  for (const [key, win] of Object.entries(ui.windows)) {
    const id = key as WindowId;
    if (!win.open || isDetached(id)) continue;
    if (win.z > topZ) {
      topZ = win.z;
      active = id;
    }
  }
  return active;
}

/** ¿Está maximizada AHORA contra el área de ahora? */
export function isWindowMaximized(
  id: WindowId,
  area: WorkspaceSize = workspaceArea(),
): boolean {
  const win = useUiStore.getState().windows[id];
  return Boolean(win?.open) && !isDetached(id) && isMaximizedBox(win, area);
}

/**
 * Maximiza guardando la caja desde la que se vuelve. Devuelve `false` si la
 * ventana no está abierta/en el escritorio o si ya estaba maximizada (evita
 * pisar la caja de vuelta con la maximizada, que dejaría el restaurar sin
 * efecto visible).
 */
export function maximizeWindow(
  id: WindowId,
  area: WorkspaceSize = workspaceArea(),
  minimum: WorkspaceSize = windowMinimum(id),
): boolean {
  const win = useUiStore.getState().windows[id];
  if (!win?.open || isDetached(id)) return false;
  // Ya maximizada por el usuario: no se vuelve a apuntar la caja (sobrescribir
  // con la maximizada dejaría el restaurar sin efecto).
  if (isMarkedMaximized(id) || isMaximizedBox(win, area)) return false;
  rememberWindowBox(id, win);
  markMaximized(id);
  setBox(id, maximizeBox(area, minimum));
  return true;
}

/**
 * Vuelve a la caja recordada, recortada con `fitWindowToWorkspace` por si el
 * escritorio cambió de tamaño mientras la ventana estaba maximizada (o si la
 * caja venía de otro monitor). Sin caja recordada no hay nada que hacer:
 * `false` y la ventana se queda donde está.
 *
 * No exige «estar maximizada» a propósito: acoplar a una mitad también ofrece
 * volver a la caja flotante, igual que Win+Abajo en Windows. El caso de un
 * layout ya lo cubre `clearWindowRestore`.
 */
export function restoreWindow(
  id: WindowId,
  area: WorkspaceSize = workspaceArea(),
  minimum: WorkspaceSize = windowMinimum(id),
): boolean {
  const win = useUiStore.getState().windows[id];
  if (!win?.open || isDetached(id)) return false;
  const previous = takeWindowBox(id);
  unmarkMaximized(id);
  if (!previous) return false;
  setBox(id, fitWindowToWorkspace(previous, area, minimum));
  return true;
}

/**
 * Reafirma la caja maximizada contra el escritorio de AHORA, sin tocar la caja
 * de vuelta. La llama `InternalWindow` cuando cambia el área útil: abrir la
 * Biblioteca o arrastrar el asa de un panel no puede encoger un editor que el
 * usuario maximizó.
 */
export function refreshMaximizedWindow(
  id: WindowId,
  area: WorkspaceSize = workspaceArea(),
  minimum: WorkspaceSize = windowMinimum(id),
): boolean {
  if (!isMarkedMaximized(id)) return false;
  const win = useUiStore.getState().windows[id];
  if (!win?.open || isDetached(id)) return false;
  setBox(id, maximizeBox(area, minimum));
  return true;
}

/** Maximizar ⇄ restaurar, lo que hacen el botón y el doble clic. */
export function toggleMaximizeWindow(
  id: WindowId,
  area: WorkspaceSize = workspaceArea(),
  minimum: WorkspaceSize = windowMinimum(id),
): boolean {
  // Solo la marca decide: una ventana que «casualmente» ocupa el área (layout,
  // memoria de escritorio) no tiene caja de vuelta y no debe ofrecer restaurar.
  if (isMarkedMaximized(id)) return restoreWindow(id, area, minimum);
  return maximizeWindow(id, area, minimum);
}

/**
 * Acopla a una mitad (`left`/`right`) o maximiza (`top`, la franja superior).
 *
 * Si ya estaba maximizada no se pisa la caja de vuelta: venir de «maximizada» a
 * «media pantalla» y restaurar debe devolver la ventana flotante de antes de
 * maximizar, no la caja maximizada que acaba de ocupar el sitio.
 */
export function tileWindow(
  id: WindowId,
  side: SnapZone,
  area: WorkspaceSize = workspaceArea(),
  minimum: WorkspaceSize = windowMinimum(id),
): boolean {
  const win = useUiStore.getState().windows[id];
  if (!win?.open || isDetached(id)) return false;
  // La marca manda: si el área cambió y la caja quedó vieja, comparar solo la
  // geometría guardaría la caja maximizada como «flotante de vuelta».
  const wasMaximized = isMarkedMaximized(id) || isMaximizedBox(win, area);
  if (!wasMaximized && !peekWindowBox(id)) rememberWindowBox(id, win);
  // Media pantalla NO es maximizada; la franja superior sí, y por eso conserva
  // la marca que hace que el botón siga diciendo «restaurar» al cambiar el
  // área. Sin esto, acoplar arriba perdía la robustez de maximizar con botón.
  if (side === 'top') markMaximized(id);
  else unmarkMaximized(id);
  setBox(id, tileBox(area, side, minimum));
  return true;
}

/** Acopla la ventana activa (la de mayor z). Devuelve cuál, o null. */
export function tileActiveWindow(
  side: SnapZone,
  area: WorkspaceSize = workspaceArea(),
  minimum?: WorkspaceSize,
): WindowId | null {
  const id = activeWindowId();
  if (!id) return null;
  return tileWindow(id, side, area, minimum ?? windowMinimum(id)) ? id : null;
}

/** Devuelve la activa a su caja flotante. Devuelve cuál, o null. */
export function restoreActiveWindow(
  area: WorkspaceSize = workspaceArea(),
  minimum?: WorkspaceSize,
): WindowId | null {
  const id = activeWindowId();
  if (!id) return null;
  return restoreWindow(id, area, minimum ?? windowMinimum(id)) ? id : null;
}
