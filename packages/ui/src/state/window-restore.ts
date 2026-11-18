/**
 * Caja a la que vuelve una ventana al restaurarse (tras maximizar o acoplar).
 *
 * Vive fuera de `useUiStore` a propósito: no es estado del proyecto ni una
 * preferencia que haya que guardar en settings, es lo que dura un gesto de
 * escritorio. Meterlo en el store sería un campo nuevo que hay que serializar,
 * comparar y explicar; aquí es un `Map` de módulo y se acabó.
 *
 * **Sin imports de la app** (los dos de abajo son `import type`: se borran al
 * compilar) para que `layouts.ts` pueda limpiar la restauración al aplicar un
 * layout sin importar `window-actions.ts`. Si no, quedaría un ciclo
 * layouts → window-actions → layouts que ESM toleraría por evaluarse dentro de
 * una función, y que no queremos tener que recordar cada vez que alguien abra
 * uno de los dos archivos.
 */

import type { WindowBox } from '../shell/window-bounds';
import type { WindowId } from './ui';

const boxes = new Map<WindowId, WindowBox>();

/**
 * Ventanas que el usuario maximizó, aparte de su geometría.
 *
 * La caja sola no alcanza: en cuanto el escritorio cambia 2 px (abrir la
 * Biblioteca, arrastrar el asa de un panel) compararla con el área nueva daría
 * «no maximizada» y la ventana se encogería sola a mitad del gesto. La marca
 * dice la INTENCIÓN del usuario; la geometría se refresca después.
 */
const maximized = new Set<WindowId>();

/** Apunta la caja actual antes de que maximizar/acoplar la pise. */
export function rememberWindowBox(id: WindowId, box: WindowBox): void {
  // Copia: la caja viene del store y una mutación accidental del llamante no
  // puede cambiar el sitio al que se vuelve.
  boxes.set(id, { x: box.x, y: box.y, w: box.w, h: box.h });
}

/** La caja recordada y la olvida: restaurar consume una sola vez. */
export function takeWindowBox(id: WindowId): WindowBox | undefined {
  const box = boxes.get(id);
  if (!box) return undefined;
  boxes.delete(id);
  return { ...box };
}

/** Mira sin consumir. La usa `tileWindow` para no pisar la caja previa. */
export function peekWindowBox(id: WindowId): WindowBox | undefined {
  const box = boxes.get(id);
  return box ? { ...box } : undefined;
}

/** Olvida una ventana (la suya ya no sirve). */
export function forgetWindowBox(id: WindowId): void {
  boxes.delete(id);
  // Sin caja a la que volver, seguir «maximizada» solo dejaría un botón de
  // restaurar que no hace nada.
  maximized.delete(id);
}

/** Marca que la ventana está maximizada por decisión del usuario. */
export function markMaximized(id: WindowId): void {
  maximized.add(id);
}

/** La marca de maximizado, estable aunque el escritorio cambie de tamaño. */
export function isMarkedMaximized(id: WindowId): boolean {
  return maximized.has(id);
}

/** Deja de estar maximizada (restaurada o acoplada a una mitad). */
export function unmarkMaximized(id: WindowId): void {
  maximized.delete(id);
}

/**
 * Tira todas las cajas y las marcas. La llama `applyLayoutWindows`: un layout
 * describe el escritorio ENTERO, así que restaurar una ventana maximizada con
 * la geometría de un layout anterior la devolvería a un sitio que ya no es el
 * de nadie.
 */
export function clearWindowRestore(): void {
  boxes.clear();
  maximized.clear();
}
