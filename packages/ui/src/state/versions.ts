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
  serializeProject,
  summarizeDiff,
  type ProjectDiff,
  type Project,
} from '@orbit/core';
import { create } from 'zustand';
import { store } from './app';
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

/** El nombre que se le puso, sacado del archivo `<ts>-<slug>.orbit`. */
function labelOf(file: string): string {
  const slug = file.slice(14).replace(/\.orbit$/, '');
  if (slug === '') return 'Sin nombre';
  return slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export async function refreshVersions(): Promise<void> {
  const api = window.orbit?.versions;
  if (!api) return;
  try {
    const list = await api.list(store.project.id);
    const entries = list.map((v) => ({ ...v, label: labelOf(v.file) }));
    const state = useVersions.getState();
    // Si un lado del comparador apunta a una versión que ya no está (borrada, o
    // caída por la poda de 40), se vuelve a la pareja por defecto en vez de
    // dejar elegido algo que no existe.
    const stale =
      resolvePick(state.compareFrom, entries) === null ||
      resolvePick(state.compareTo, entries) === null;
    const pair = stale || state.compare === null ? defaultPair(entries) : null;
    useVersions.setState({
      entries,
      ...(pair ? { compareFrom: pair.from, compareTo: pair.to } : null),
      ...(stale ? { compare: null } : null),
    });
  } catch {
    useVersions.setState({ notice: 'No se pudieron leer las versiones' });
  }
}

/** Guarda el proyecto tal y como está ahora. */
export async function saveVersion(label: string): Promise<void> {
  const api = window.orbit?.versions;
  if (!api) return;
  useVersions.setState({ busy: true, notice: null });
  try {
    await api.save(store.project.id, label, serializeProject(store.project));
    await refreshVersions();
    useVersions.setState({ notice: `Versión guardada: ${label || 'sin nombre'}` });
  } catch (err) {
    useVersions.setState({
      notice: err instanceof Error ? err.message : 'No se pudo guardar la versión',
    });
  } finally {
    useVersions.setState({ busy: false });
  }
}

/** Proyecto de una versión, ya parseado. */
async function readVersion(file: string): Promise<Project | null> {
  const api = window.orbit?.versions;
  if (!api) return null;
  try {
    return parseProject(await api.read(store.project.id, file));
  } catch {
    useVersions.setState({ notice: 'Esa versión no se puede leer' });
    return null;
  }
}

/**
 * Despliega una versión: calcula qué cambió DESDE ella hasta el proyecto de
 * ahora. Volver a pulsar la cierra.
 */
export async function openVersionDiff(file: string): Promise<void> {
  if (useVersions.getState().openFile === file) {
    useVersions.setState({ openFile: null, diff: null });
    return;
  }
  useVersions.setState({ busy: true, notice: null });
  const project = await readVersion(file);
  if (!project) {
    useVersions.setState({ busy: false });
    return;
  }
  const diff = diffProjects(project, store.project);
  useVersions.setState({
    openFile: file,
    diff,
    busy: false,
    notice: isEmptyDiff(diff) ? 'Esa versión es igual que el proyecto de ahora' : null,
  });
}

/**
 * Vuelve a esa versión. Antes guarda el estado actual como "antes de
 * restaurar": restaurar no puede ser una puerta de un solo sentido.
 */
export async function restoreVersion(file: string): Promise<void> {
  useVersions.setState({ busy: true, notice: null });
  const project = await readVersion(file);
  if (!project) {
    useVersions.setState({ busy: false });
    return;
  }
  await saveVersion('antes de restaurar');
  store.replaceProject(project);
  // El proyecto nuevo llega lleno de referencias y el kernel, vacío.
  void rehydrateSamples();
  useVersions.setState({
    busy: false,
    openFile: null,
    diff: null,
    notice: `Restaurada: ${labelOf(file)}`,
  });
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
  useVersions.setState(side === 'from' ? { compareFrom: key } : { compareTo: key });
}

/** Da la vuelta a la comparación y la recalcula si ya había uno hecho. */
export function swapCompare(): void {
  const { compareFrom, compareTo, compare } = useVersions.getState();
  useVersions.setState({ compareFrom: compareTo, compareTo: compareFrom });
  if (compare) void runCompare();
}

export function closeCompare(): void {
  useVersions.setState({ compare: null });
}

/**
 * El proyecto de un lado: el de ahora, o el que guarda esa versión.
 *
 * El de ahora se clona por serialización antes de compararlo. `diffProjects`
 * solo lee, pero el proyecto vivo puede cambiar entre los dos `await` de esta
 * función (un comando de la sala, Claude, el propio usuario), y comparar dos
 * fotos tomadas en momentos distintos daría un diff que no corresponde a nada.
 */
async function sideProject(key: string): Promise<Project | null> {
  if (key === CURRENT_KEY) return parseProject(serializeProject(store.project));
  return readVersion(key);
}

/** Compara los dos lados elegidos y deja el resultado en el estado. */
export async function runCompare(): Promise<void> {
  const { compareFrom, compareTo, entries } = useVersions.getState();
  const from = resolvePick(compareFrom, entries);
  const to = resolvePick(compareTo, entries);
  if (!from || !to) {
    useVersions.setState({ notice: 'Una de las dos versiones ya no está', compare: null });
    return;
  }
  useVersions.setState({ busy: true, notice: null });
  try {
    const [before, after] = await Promise.all([
      sideProject(from.key),
      sideProject(to.key),
    ]);
    if (!before || !after) {
      useVersions.setState({ compare: null });
      return;
    }
    const diff = diffProjects(before, after);
    useVersions.setState({
      compare: { from, to, direction: compareDirection(from, to), diff },
      notice: isEmptyDiff(diff) ? 'No hay ni una diferencia entre esas dos' : null,
    });
  } finally {
    useVersions.setState({ busy: false });
  }
}
