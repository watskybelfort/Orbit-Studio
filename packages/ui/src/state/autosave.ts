/**
 * Autosave del proyecto: cada minuto, si hubo cambios desde el último punto
 * limpio, serializa y lo manda al main (pending.orbit + anillo de 5 backups).
 * El guardado manual marca el punto limpio y borra el pendiente; si al abrir
 * la app existe un pendiente, es que la sesión anterior murió (o se cerró) con
 * cambios sin guardar y se ofrece recuperarlo.
 */

import { parseProject, serializeProject, type Project } from '@orbit/core';
import { create } from 'zustand';
import { rehydrateSamples } from '../browser/sound-actions';
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

/**
 * Restaura el pendiente en el store (queda como proyecto sin guardar).
 *
 * Devuelve `false` si el autosave no se puede leer. El escenario para el que
 * existe el autosave es justo que la sesión anterior muriera A MITAD de
 * escribirlo, así que un archivo a medias es lo esperable, no lo raro: sin
 * este try/catch la excepción escapaba del onClick, el cartel se quedaba ahí y
 * el botón "Recuperar" no hacía absolutamente nada, sin decir por qué.
 */
export function applyRecovery(offer: RecoveryOffer): boolean {
  let project: Project;
  try {
    project = parseProject(offer.json);
  } catch (err) {
    useAutosave.setState({
      error:
        err instanceof Error
          ? `El autosave no se pudo recuperar: ${err.message}`
          : 'El autosave está corrupto y no se pudo recuperar.',
    });
    return false;
  }
  store.replaceProject(project);
  // Los samples referenciados se resuben al kernel (arranca vacío).
  void rehydrateSamples();
  // NO se limpia el pendiente: hasta que el usuario guarde, sigue siendo la red.
  return true;
}

/** Lo último que falló al recuperar (para enseñarlo en el cartel). */
export const useAutosave = create<{ error: string | null }>(() => ({ error: null }));

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
