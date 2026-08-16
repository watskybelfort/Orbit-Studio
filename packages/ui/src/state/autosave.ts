/**
 * Autosave del proyecto: cada minuto, si hubo cambios desde el último punto
 * limpio, serializa y lo manda al main (pending.orbit + anillo de 5 backups).
 * El guardado manual marca el punto limpio y borra el pendiente; si al abrir
 * la app existe un pendiente, es que la sesión anterior murió (o se cerró) con
 * cambios sin guardar y se ofrece recuperarlo.
 */

import { parseProject, serializeProject } from '@orbit/core';
import { store } from './app';

const INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let cleanVersion = -1;

export interface RecoveryOffer {
  json: string;
  mtimeMs: number;
}

/** Pendiente de la sesión anterior, o null. Llamar ANTES de initAutosave. */
export async function checkRecovery(): Promise<RecoveryOffer | null> {
  const api = window.orbit;
  if (!api?.autosave) return null;
  try {
    return await api.autosave.check();
  } catch {
    return null;
  }
}

/** Restaura el pendiente en el store (queda como proyecto sin guardar). */
export function applyRecovery(offer: RecoveryOffer): void {
  store.replaceProject(parseProject(offer.json));
  // NO se limpia el pendiente: hasta que el usuario guarde, sigue siendo la red.
}

/** Descarta el pendiente de la sesión anterior. */
export function discardRecovery(): void {
  void window.orbit?.autosave.clear();
}

/** El estado actual pasa a ser el punto limpio (tras guardar o abrir). */
export function markClean(): void {
  cleanVersion = store.version;
  void window.orbit?.autosave.clear();
}

export function initAutosave(): void {
  const api = window.orbit;
  if (!api?.autosave || timer) return;
  cleanVersion = store.version;
  timer = setInterval(() => {
    if (store.version === cleanVersion) return;
    cleanVersion = store.version;
    void api.autosave.write(serializeProject(store.project));
  }, INTERVAL_MS);
}
