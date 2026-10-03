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
// A nivel de FUNCIÓN (en `applyRecovery`), no de módulo: `project-file` importa
// este archivo y un uso de módulo aquí reventaría el ciclo.
import { useProjectFile } from './project-file';

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

/** Guardar manualmente invalida respuestas anteriores incluso en la misma
 * sesión. historyEpoch cubre además nuevo/abrir/restaurar/recuperar/sala. */
let autosaveGeneration = 0;

/** El archivo pending es único. No puede haber un write antiguo terminando
 * después de clear, ni un clear terminando encima del autosave siguiente. */
let pendingIo: Promise<void> | null = null;

function queueAutosaveIo(run: () => Promise<void>): void {
  const operation = pendingIo ? pendingIo.then(run, run) : run();
  pendingIo = operation;
  const release = () => {
    if (pendingIo === operation) pendingIo = null;
  };
  void operation.then(release, release);
}

function clearPending(): void {
  const api = window.orbit?.autosave;
  if (!api) return;
  const epoch = store.historyEpoch;
  const generation = autosaveGeneration;
  const isCurrent = () => epoch === store.historyEpoch && generation === autosaveGeneration;
  queueAutosaveIo(async () => {
    if (!isCurrent()) return;
    try {
      await api.clear();
    } catch {
      if (isCurrent()) useAutosave.setState({ error: 'No se pudo limpiar la recuperación automática guardada.' });
    }
  });
}

/**
 * Hay una recuperación OFRECIDA y todavía sin resolver (el usuario no ha
 * pulsado Recuperar ni Descartar). Mientras lo esté, el bucle del autosave no
 * escribe: `pending.orbit` es la red que el usuario tiene delante, y pisarla
 * con lo que se edita a continuación convertiría la oferta en otra cosa — al
 * pulsar Recuperar ya no volvería la sesión anterior, sino lo de hace un
 * minuto. Se limpia cuando el cartel se resuelve (o cuando un guardado
 * explícito descarta el pendiente).
 */
let recoveryPending = false;

export interface RecoveryOffer {
  json: string;
  mtimeMs: number;
}

/** Pendiente de la sesión anterior, o null. Llamar ANTES de initAutosave. */
export async function checkRecovery(): Promise<RecoveryOffer | null> {
  const api = window.orbit;
  if (!api?.autosave) return null;
  try {
    const offer = await api.autosave.check();
    // Con oferta, el bucle del autosave queda bloqueado hasta que se resuelva.
    recoveryPending = offer !== null;
    return offer;
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
  // Recuperar reemplaza el proyecto ENTERO (historial incluido), como abrir un
  // `.orbit` o cargar una plantilla, así que pasa por la misma guardia que
  // esos caminos. Si el usuario cancela, no se toca nada y el cartel se queda
  // — con su pendiente — para que pueda decidir después.
  if (!confirmDiscard('Recuperar el trabajo de la sesión anterior')) return false;
  recoveryPending = false;
  store.replaceProject(project);
  useAutosave.setState({ error: null });
  // El proyecto recuperado NO es el archivo que estaba abierto: es trabajo SIN
  // guardar, y el propio autosave es su única red hasta que el usuario guarde
  // (por eso no se limpia el pendiente). Conservar la ruta anterior —lo que
  // hacía esto hasta ahora— deja un `Ctrl+S` que escribe POR ENCIMA de la otra
  // canción: pérdida de proyecto confirmada (BUG 019). Con `path: null`,
  // Guardar pide destino y el archivo de antes queda intacto.
  useProjectFile.setState({ path: null });
  // Los samples referenciados se resuben al kernel (arranca vacío).
  void rehydrateSamples();
  // NO se limpia el pendiente: hasta que el usuario guarde, sigue siendo la red.
  return true;
}

/**
 * Lo último que falló al recuperar o escribir el autosave y si hay cambios sin
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
  recoveryPending = false;
  autosaveGeneration++;
  useAutosave.setState({ error: null });
  clearPending();
}

/** El estado actual pasa a ser el punto limpio (tras guardar o abrir). */
export function markClean(): void {
  markCleanAt(store.version);
}

/**
 * Marca como guardada una VERSIÓN concreta del store, no la de ahora. Lo usa
 * saveProject: el JSON se serializa ANTES del diálogo de guardado, así que si el
 * proyecto cambia mientras el diálogo está abierto (sala, Claude, el usuario),
 * marcar limpio el estado de DESPUÉS enterraría esos cambios sin que el guardián
 * de "sin guardar" avise. Marcando la versión serializada, isDirty vuelve a ser
 * true si el proyecto avanzó.
 */
export function markCleanAt(version: number): void {
  autosaveGeneration++;
  savedVersion = version;
  autosavedVersion = version;
  refreshDirty();
  // La recuperación pendiente solo se descarta si lo guardado ES el estado
  // actual; si el proyecto avanzó durante el diálogo, esos cambios aún no están
  // en disco y su pending debe seguir vivo.
  if (store.version === version) {
    recoveryPending = false;
    useAutosave.setState({ error: null });
    clearPending();
  }
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
  store.subscribeBeforeReplace(() => {
    autosaveGeneration++;
    useAutosave.setState({ error: null });
  });
  timer = setInterval(() => {
    // Con un cartel de recuperación sin resolver, `pending.orbit` no se toca:
    // es la oferta que el usuario todavía puede aceptar (ver `recoveryPending`).
    if (recoveryPending || pendingIo) return;
    if (store.version === autosavedVersion) return;
    const version = store.version;
    const epoch = store.historyEpoch;
    const generation = autosaveGeneration;
    const isCurrent = () => epoch === store.historyEpoch && generation === autosaveGeneration;
    queueAutosaveIo(async () => {
      try {
        // La foto y su versión se toman juntas, antes de cruzar el IPC.
        const json = serializeProject(store.project);
        await api.autosave.write(json);
        if (!isCurrent()) return;
        autosavedVersion = version;
        useAutosave.setState({ error: null });
      } catch (err) {
        if (!isCurrent()) return;
        const detail = err instanceof Error ? `: ${err.message}` : '';
        useAutosave.setState({
          error: `No se pudo guardar la recuperación automática${detail}. Se reintentará en un minuto; puedes guardar el proyecto con Ctrl+S.`,
        });
        // No se adelanta el checkpoint ni se reintenta en caliente: el próximo
        // tick vuelve a escribir aunque nadie haya editado nada más.
      }
    });
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
