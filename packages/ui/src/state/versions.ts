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
}

export const useVersions = create<VersionsState>(() => ({
  entries: [],
  openFile: null,
  diff: null,
  busy: false,
  notice: null,
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
    useVersions.setState({
      entries: list.map((v) => ({ ...v, label: labelOf(v.file) })),
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
