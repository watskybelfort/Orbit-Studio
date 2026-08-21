/**
 * Quién manda cuando se pide "copiar", "pegar" o "seleccionar todo".
 *
 * El Piano Roll y la Playlist tienen selección propia y los dos suelen estar
 * abiertos: sin un árbitro, un Ctrl+V pegaría en los dos a la vez y el menú
 * Editar no sabría de qué está hablando. Cada editor REGISTRA sus acciones al
 * montarse y RECLAMA el turno al primer pointerdown dentro de él, que es como
 * uno entiende "el editor en el que estoy".
 *
 * Si aún no ha reclamado nadie (recién arrancada la app), se cae al que esté
 * más arriba en el apilado de ventanas: la que se ve, que es la que el usuario
 * daría por activa.
 */

import { useUiStore, type WindowId } from './ui';

export type EditTarget = 'pianoRoll' | 'playlist';

const WINDOW_OF: Record<EditTarget, WindowId> = {
  pianoRoll: 'pianoRoll',
  playlist: 'playlist',
};

/** Lo que un editor sabe hacer cuando le toca el turno. */
export interface EditActions {
  /** Cuántos elementos hay seleccionados ahora mismo (0 = no hay qué copiar). */
  selectionCount: number;
  /** Qué tipo de portapapeles sabe pegar este editor. */
  accepts: 'notes' | 'clips';
  /** Nombre de lo que maneja, en plural, para las etiquetas ("notas", "clips"). */
  noun: string;
  copy(): void;
  cut(): void;
  paste(): void;
  duplicate(): void;
  selectAll(): void;
  remove(): void;
}

/**
 * Proveedor y no el objeto: las acciones son closures de React que cambian en
 * cada render. Registrar el objeto obligaría a re-registrar constantemente (y
 * a que el menú leyera una versión vieja de la selección).
 */
type Provider = () => EditActions;

const providers = new Map<EditTarget, Provider>();
let claimed: EditTarget | null = null;

/** Registra las acciones de un editor; devuelve el unregister. */
export function registerEditActions(target: EditTarget, provider: Provider): () => void {
  providers.set(target, provider);
  return () => {
    if (providers.get(target) === provider) providers.delete(target);
    if (claimed === target) claimed = null;
  };
}

/** El editor pasa a ser el activo (pointerdown dentro de él). */
export function claimEditFocus(target: EditTarget): void {
  claimed = target;
}

/** Solo para los tests: vuelve al estado de recién arrancado. */
export function resetEditFocus(): void {
  claimed = null;
  providers.clear();
}

/** Cuál manda ahora: el que reclamó, o el que esté más arriba y abierto. */
export function activeEditTarget(): EditTarget | null {
  if (claimed !== null && providers.has(claimed)) return claimed;
  const windows = useUiStore.getState().windows;
  let best: EditTarget | null = null;
  let bestZ = -Infinity;
  for (const target of providers.keys()) {
    const w = windows[WINDOW_OF[target]];
    if (!w?.open) continue;
    if (w.z > bestZ) {
      bestZ = w.z;
      best = target;
    }
  }
  return best;
}

/** Las acciones del editor activo, o null si no hay ninguno en juego. */
export function activeEditActions(): EditActions | null {
  const target = activeEditTarget();
  if (target === null) return null;
  return providers.get(target)?.() ?? null;
}
