/**
 * Versiones del proyecto: instantáneas con nombre para poder mirar atrás.
 *
 * No es el autosave —esa es la red contra el crash y se pisa a sí misma— ni el
 * historial de undo, que vive en memoria y se pierde al cerrar. Esto es el
 * proyecto ENTERO guardado aparte, con su hora, y comparable con el de ahora
 * por el diff musical de core: "¿qué cambió en el drop?" respondido con notas,
 * canales y faders, no con bytes.
 *
 * Se guarda una sola en cada `Ctrl+S` (así el historial se llena solo con lo
 * que uno considera un punto de guardado) y las que se pidan a mano.
 */

import {
  diffProjects,
  isEmptyDiff,
  parseProject,
  parseVersionFile,
  serializeProject,
  summarizeDiff,
  type ProjectDiff,
  type Project,
} from '@orbit/core';
import { create } from 'zustand';
import { store } from './app';
import { projectLoadRequests } from './project-load-request';
import { rehydrateSamples } from '../browser/sound-actions';
import {
  CURRENT_KEY,
  compareDirection,
  defaultPair,
  resolvePick,
  type CompareDirection,
  type ComparePick,
} from './version-compare';

export interface VersionEntry {
  /** Nombre de archivo (identidad dentro del proyecto). */
  file: string;
  /** Momento en el que se guardó. */
  at: number;
  bytes: number;
  /** Nombre visible sacado del propio archivo. */
  label: string;
}

interface VersionsState {
  entries: VersionEntry[];
  /** Versión desplegada ahora mismo, con su diff contra el proyecto actual. */
  openFile: string | null;
  diff: ProjectDiff | null;
  busy: boolean;
  notice: string | null;
  /** Lados elegidos en el comparador (CURRENT_KEY = el proyecto de ahora). */
  compareFrom: string;
  compareTo: string;
  /** Resultado de la última comparación pedida, o null si no hay ninguna. */
  compare: {
    from: ComparePick;
    to: ComparePick;
    direction: CompareDirection;
    diff: ProjectDiff;
  } | null;
}

export const useVersions = create<VersionsState>(() => ({
  entries: [],
  openFile: null,
  diff: null,
  busy: false,
  notice: null,
  compareFrom: CURRENT_KEY,
  compareTo: CURRENT_KEY,
  compare: null,
}));

/** Etiqueta de la versión, sin exponer su identificador de escritura. */
function labelOf(file: string): string {
  const slug = parseVersionFile(file)?.slug ?? '';
  if (slug === '') return 'Sin nombre';
  return slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

let refreshRequest = 0;

export async function refreshVersions(canPublish: () => boolean = () => true): Promise<void> {
  const api = window.orbit?.versions;
  if (!api) return;
  const epoch = store.historyEpoch;
  const request = ++refreshRequest;
  const isCurrent = () => epoch === store.historyEpoch && request === refreshRequest && canPublish();
  try {
    const list = await api.list(store.project.id);
    if (!isCurrent()) return;
    const entries = list.map((v) => ({ ...v, label: labelOf(v.file) }));
    const state = useVersions.getState();
    // Si un lado del comparador apunta a una versión que ya no está (borrada, o
    // caída por la poda de 40), se vuelve a la pareja por defecto en vez de
    // dejar elegido algo que no existe.
    const stale =
      resolvePick(state.compareFrom, entries) === null ||
      resolvePick(state.compareTo, entries) === null;
    // Una lectura pendiente también tiene compare=null. Refrescar la lista
    // (p. ej. después de guardar) no debe cambiar una selección válida.
    const initial = state.entries.length === 0 && state.compare === null &&
      state.compareFrom === CURRENT_KEY && state.compareTo === CURRENT_KEY && !pendingCompare?.isCurrent();
    const pair = stale || initial ? defaultPair(entries) : null;
    if (pair && (pair.from !== state.compareFrom || pair.to !== state.compareTo)) cancelCompare();
    useVersions.setState({
      entries,
      ...(pair ? { compareFrom: pair.from, compareTo: pair.to } : null),
      ...(stale ? { compare: null } : null),
    });
  } catch {
    if (isCurrent()) useVersions.setState({ notice: 'No se pudieron leer las versiones' });
  }
}

export interface VersionSnapshot {
  readonly projectId: string;
  readonly json: string;
  readonly epoch: number;
}

/** Guardar, restaurar y leer comparten SOLO la propiedad del aviso/busy. Perderla
 * no cancela una escritura ni una restauración musical todavía vigente. */
let statusRequest = 0;

/** Archiva una foto ya serializada, aunque su proyecto haya dejado de estar
 * abierto. Solo publica estado de UI si esa sesión y ese guardado siguen vivos. */
export async function saveVersionSnapshot(
  label: string,
  snapshot: VersionSnapshot,
  options: { publish?: boolean } = {},
): Promise<boolean> {
  const api = window.orbit?.versions;
  if (!api) return false;
  const { projectId, json, epoch } = snapshot;
  const request = options.publish !== false && epoch === store.historyEpoch ? ++statusRequest : null;
  const isCurrent = () => epoch === store.historyEpoch && request === statusRequest;
  let unsubscribe: () => void = () => undefined;
  if (isCurrent()) {
    useVersions.setState({ busy: true, notice: null });
    // Limpiar ANTES de sustituir A evita heredar su busy en B. Un finally
    // tardío no puede limpiarlo: podría apagar un guardado que ya pertenece a B.
    unsubscribe = store.subscribeBeforeReplace(() => {
      if (isCurrent()) useVersions.setState({ busy: false });
    });
  }
  try {
    await api.save(projectId, label, json);
    if (isCurrent()) {
      await refreshVersions(isCurrent);
      if (isCurrent()) useVersions.setState({ notice: `Versión guardada: ${label || 'sin nombre'}` });
    }
    return true;
  } catch (err) {
    if (isCurrent()) useVersions.setState({
      notice: err instanceof Error ? err.message : 'No se pudo guardar la versión',
    });
    return false;
  } finally {
    unsubscribe();
    if (isCurrent()) useVersions.setState({ busy: false });
  }
}

/** Guarda el proyecto tal y como está ahora. Devuelve si de verdad se guardó. */
export async function saveVersion(label: string): Promise<boolean> {
  let snapshot: VersionSnapshot;
  try {
    snapshot = { projectId: store.project.id, json: serializeProject(store.project), epoch: store.historyEpoch };
  } catch (err) {
    useVersions.setState({ notice: err instanceof Error ? err.message : 'No se pudo guardar la versión' });
    return false;
  }
  return saveVersionSnapshot(label, snapshot);
}

interface VersionReadRequest {
  projectId: string;
  isCurrent: () => boolean;
  canPublish: () => boolean;
}

/** Proyecto de una versión, ya parseado. Tanto el resultado como sus errores
 * pertenecen a la solicitud/sesión que lo pidió. */
async function readVersion(file: string, request: VersionReadRequest): Promise<Project | null> {
  const api = window.orbit?.versions;
  if (!api) return null;
  try {
    const json = await api.read(request.projectId, file);
    if (!request.isCurrent()) return null;
    return parseProject(json);
  } catch {
    if (request.canPublish()) useVersions.setState({ notice: 'Esa versión no se puede leer' });
    return null;
  }
}

interface PanelReadRequest extends VersionReadRequest {
  finish: () => void;
}

/** Cancelar una lectura retira su permiso para publicar, aunque el IPC siga
 * pendiente. Su estado musical es independiente de guardar/restaurar. */
function beginPanelRead(selectionMatches: () => boolean = () => true): PanelReadRequest {
  const epoch = store.historyEpoch;
  const projectId = store.project.id;
  const status = ++statusRequest;
  let finished = false;
  let unsubscribe: () => void = () => undefined;
  const isActive = () => !finished && epoch === store.historyEpoch;
  const isCurrent = () => isActive() && selectionMatches();
  const canPublish = () => isCurrent() && status === statusRequest;
  const finish = () => {
    if (finished) return;
    // Aun si la lista cambió la selección, liberar nuestro busy evita dejar
    // el panel bloqueado. Nunca se libera el de una operación más reciente.
    if (isActive() && status === statusRequest) useVersions.setState({ busy: false });
    finished = true;
    unsubscribe();
  };
  useVersions.setState({ busy: true, notice: null });
  unsubscribe = store.subscribeBeforeReplace(finish);
  return { projectId, isCurrent, canPublish, finish };
}

let pendingCompare: PanelReadRequest | null = null;
let pendingDiff: { file: string; request: PanelReadRequest } | null = null;

function cancelCompare(): void {
  pendingCompare?.finish();
  pendingCompare = null;
}

function cancelDiff(): void {
  pendingDiff?.request.finish();
  pendingDiff = null;
}

/**
 * Despliega una versión: calcula qué cambió DESDE ella hasta el proyecto de
 * ahora. Volver a pulsar la cierra.
 */
export async function openVersionDiff(file: string): Promise<void> {
  if (useVersions.getState().openFile === file ||
      (pendingDiff?.file === file && pendingDiff.request.isCurrent())) {
    cancelDiff();
    useVersions.setState({ openFile: null, diff: null });
    return;
  }
  cancelDiff();
  const request = beginPanelRead();
  pendingDiff = { file, request };
  try {
    const current = parseProject(serializeProject(store.project));
    const project = await readVersion(file, request);
    if (!request.isCurrent() || !project) return;
    const diff = diffProjects(project, current);
    useVersions.setState({
      openFile: file,
      diff,
      ...(request.canPublish() ? { notice: isEmptyDiff(diff) ? 'Esa versión es igual que el proyecto de ahora' : null } : null),
    });
  } catch (err) {
    if (request.canPublish()) useVersions.setState({ notice: err instanceof Error ? err.message : 'No se pudo comparar esa versión' });
  } finally {
    request.finish();
    if (pendingDiff?.request === request) pendingDiff = null;
  }
}

/**
 * Vuelve a esa versión. Antes guarda el estado actual como "antes de
 * restaurar": restaurar no puede ser una puerta de un solo sentido.
 */
export async function restoreVersion(file: string): Promise<void> {
  const epoch = store.historyEpoch;
  const projectId = store.project.id;
  let unsubscribe: () => void = () => undefined;
  let finished = false;
  const request = projectLoadRequests.begin(epoch, finish);
  const isCurrent = () => request.isCurrent(store.historyEpoch);
  const status = ++statusRequest;
  const canPublish = () => isCurrent() && status === statusRequest;
  function finish() {
    if (finished) return;
    finished = true;
    unsubscribe();
    if (canPublish()) useVersions.setState({ busy: false });
    request.finish();
  }
  useVersions.setState({ busy: true, notice: null });
  // El cambio puede venir de nuevo/recuperar/sala, sin pasar por este módulo.
  // Se libera busy ANTES de que ese nuevo proyecto herede el panel.
  unsubscribe = store.subscribeBeforeReplace(finish);
  try {
    const project = await readVersion(file, { projectId, isCurrent, canPublish });
    if (!isCurrent() || !project) return;
    const backedUpVersion = store.version;
    const snapshot = { projectId, epoch, json: serializeProject(store.project) };
    // La restauración es dueña del aviso y busy. Un respaldo suyo que llegue
    // tarde no debe publicar sobre otra restauración que todavía está leyendo.
    const backedUp = await saveVersionSnapshot('antes de restaurar', snapshot, { publish: false });
    if (!isCurrent()) return;
    if (!backedUp) {
      if (canPublish()) useVersions.setState({ notice: 'No se restauró: no se pudo guardar el respaldo del estado actual' });
      return;
    }
    if (store.version !== backedUpVersion) {
      if (canPublish()) {
        useVersions.setState({ notice: 'No se restauró: el proyecto cambió mientras se guardaba el respaldo. Tus cambios se conservan; vuelve a intentarlo.' });
        void refreshVersions(canPublish);
      }
      return;
    }
    const publishResult = canPublish();
    const statusAtCommit = statusRequest;
    store.replaceProject(project);
    void rehydrateSamples();
    useVersions.setState({
      openFile: null,
      diff: null,
      ...(publishResult ? { busy: false, notice: `Restaurada: ${labelOf(file)}` } : null),
    });
    void refreshVersions(() => statusAtCommit === statusRequest);
  } catch (err) {
    if (canPublish()) useVersions.setState({ notice: err instanceof Error ? err.message : 'No se pudo restaurar esa versión' });
  } finally {
    finish();
  }
}

export async function removeVersion(file: string): Promise<void> {
  const api = window.orbit?.versions;
  if (!api) return;
  await api.remove(store.project.id, file).catch(() => undefined);
  if (useVersions.getState().openFile === file) {
    useVersions.setState({ openFile: null, diff: null });
  }
  await refreshVersions();
}

/** Resumen de una línea del cambio de esa versión al proyecto de ahora. */
export function summarize(diff: ProjectDiff): string {
  return summarizeDiff(diff);
}

// ── Comparar dos versiones cualesquiera ──────────────────────────────────────

/** Elige un lado del comparador (sin recalcular: eso lo pide el botón). */
export function setComparePick(side: 'from' | 'to', key: string): void {
  cancelCompare();
  useVersions.setState({ ...(side === 'from' ? { compareFrom: key } : { compareTo: key }), compare: null });
}

/** Da la vuelta a la comparación y la recalcula si ya había uno hecho. */
export function swapCompare(): void {
  const { compareFrom, compareTo, compare } = useVersions.getState();
  cancelCompare();
  useVersions.setState({ compareFrom: compareTo, compareTo: compareFrom, compare: null });
  if (compare) void runCompare();
}

export function closeCompare(): void {
  cancelCompare();
  useVersions.setState({ compare: null });
}

/**
 * El proyecto de un lado: el de ahora, o el que guarda esa versión.
 *
 * El de ahora ya se clonó antes de iniciar cualquiera de los IPC, para que
 * ambos lados representen el mismo instante incluso si el proyecto se edita.
 */
async function sideProject(key: string, request: VersionReadRequest, current: Project | null): Promise<Project | null> {
  if (key === CURRENT_KEY) return current;
  return readVersion(key, request);
}

/** Compara los dos lados elegidos y deja el resultado en el estado. */
export async function runCompare(): Promise<void> {
  cancelCompare();
  const { compareFrom, compareTo, entries } = useVersions.getState();
  const request = beginPanelRead(() => {
    const state = useVersions.getState();
    return state.compareFrom === compareFrom && state.compareTo === compareTo;
  });
  pendingCompare = request;
  try {
    const from = resolvePick(compareFrom, entries);
    const to = resolvePick(compareTo, entries);
    if (!from || !to) {
      useVersions.setState({ notice: 'Una de las dos versiones ya no está', compare: null });
      return;
    }
    const current = from.key === CURRENT_KEY || to.key === CURRENT_KEY
      ? parseProject(serializeProject(store.project)) : null;
    const [before, after] = await Promise.all([
      sideProject(from.key, request, current),
      sideProject(to.key, request, current),
    ]);
    if (!request.isCurrent()) return;
    if (!before || !after) {
      useVersions.setState({ compare: null });
      return;
    }
    const diff = diffProjects(before, after);
    useVersions.setState({
      compare: { from, to, direction: compareDirection(from, to), diff },
      ...(request.canPublish() ? { notice: isEmptyDiff(diff) ? 'No hay ni una diferencia entre esas dos' : null } : null),
    });
  } catch (err) {
    if (request.canPublish()) useVersions.setState({ notice: err instanceof Error ? err.message : 'No se pudieron comparar esas versiones' });
  } finally {
    request.finish();
    if (pendingCompare === request) pendingCompare = null;
  }
}
