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

/**
 * Dos marcas de agua distintas, y se separan a propósito.
 *
 * `savedVersion` es lo último que el USUARIO guardó (o abrió): es lo que decide
 * si hay cambios que se pueden perder. `autosavedVersion` es lo último que el
 * bucle escribió en `pending.orbit`, y sube solo cada minuto. Con una sola
 * variable —como estaba— el primer autosave dejaba el proyecto marcado como sin
 * cambios aunque no se hubiera guardado nada de verdad, y la guardia de salir
 * no habría avisado de nada.
 */
let savedVersion = -1;
let autosavedVersion = -1;

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

/**
 * Lo último que falló al recuperar (para el cartel) y si hay cambios sin
 * guardar (para el punto de la barra de título y la guardia de salir).
 */
export const useAutosave = create<{ error: string | null; dirty: boolean }>(() => ({
  error: null,
  dirty: false,
}));

/** ¿Hay trabajo que se perdería ahora mismo? */
export function isDirty(): boolean {
  return store.version !== savedVersion;
}

/**
 * Recalcula el flag. Se llama en cada cambio del proyecto, así que compara
 * antes de escribir: sin la guarda, un arrastre de perilla dispararía cientos
 * de `setState` idénticos y con ellos el render de media app.
 */
function refreshDirty(): void {
  const dirty = isDirty();
  if (useAutosave.getState().dirty !== dirty) {
    useAutosave.setState({ dirty });
    // El main necesita saberlo para poder parar el cierre de la ventana: el
    // renderer no se entera de un Alt+F4 ni de la X del sistema.
    void window.orbit?.app.setDirty(dirty);
  }
}

/** Descarta el pendiente de la sesión anterior. */
export function discardRecovery(): void {
  void window.orbit?.autosave.clear();
}

/** El estado actual pasa a ser el punto limpio (tras guardar o abrir). */
export function markClean(): void {
  savedVersion = store.version;
  autosavedVersion = store.version;
  refreshDirty();
  void window.orbit?.autosave.clear();
}

export function initAutosave(): void {
  const api = window.orbit;
  if (!api?.autosave || timer) return;
  savedVersion = store.version;
  autosavedVersion = store.version;
  refreshDirty();
  // El flag de "sin guardar" se recalcula en cada cambio del proyecto. El
  // ProjectStore solo emite cuando el proyecto cambia de verdad (dispatch,
  // undo/redo, replaceProject), no con los medidores del kernel.
  store.subscribe(refreshDirty);
  timer = setInterval(() => {
    if (store.version === autosavedVersion) return;
    autosavedVersion = store.version;
    void api.autosave.write(serializeProject(store.project));
  }, INTERVAL_MS);
}

/**
 * Guardia previa a algo que pisa el proyecto (nuevo, abrir, recuperar).
 * Devuelve false si el usuario dice que no. Sin cambios pendientes no pregunta.
 */
export function confirmDiscard(what: string): boolean {
  if (!isDirty()) return true;
  return window.confirm(
    `El proyecto tiene cambios sin guardar.\n\n¿${what} de todas formas? Se perderá lo que no hayas guardado.`,
  );
}
