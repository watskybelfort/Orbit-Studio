/**
 * Archivo del proyecto (.orbit): ruta actual, abrir/guardar por IPC y avisos
 * transitorios para la UI (sin alert()). Fuera de Electron los comandos avisan
 * de que requieren la app de escritorio.
 */

import { createEmptyProject, parseProject, serializeProject } from '@orbit/core';
import { create } from 'zustand';
import { rehydrateSamples } from '../browser/sound-actions';
import { store } from './app';
import { markClean } from './autosave';

interface ProjectFileState {
  /** Ruta del .orbit abierto; null = proyecto sin guardar. */
  path: string | null;
  /** Aviso transitorio (guardado, error…); la UI lo muestra y se autolimpia. */
  notice: string | null;
}

export const useProjectFile = create<ProjectFileState>(() => ({
  path: null,
  notice: null,
}));

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function notify(notice: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  useProjectFile.setState({ notice });
  noticeTimer = setTimeout(() => useProjectFile.setState({ notice: null }), 4000);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function newProject(): void {
  store.replaceProject(createEmptyProject());
  useProjectFile.setState({ path: null });
  markClean();
  notify('Proyecto nuevo.');
}

export async function openProject(): Promise<void> {
  const api = window.orbit;
  if (!api) {
    notify('Abrir proyectos requiere la app de escritorio.');
    return;
  }
  try {
    const result = await api.project.open();
    if (!result) return; // cancelado
    const project = parseProject(result.json);
    store.replaceProject(project);
    useProjectFile.setState({ path: result.path });
    markClean();
    // Los samples referenciados se resuben al kernel (arranca vacío).
    void rehydrateSamples();
    notify(`Abierto ${fileName(result.path)}.`);
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo abrir el proyecto.');
  }
}

/** Guarda el proyecto; con saveAs=true fuerza el diálogo aunque haya ruta. */
export async function saveProject(saveAs = false): Promise<void> {
  const api = window.orbit;
  if (!api) {
    notify('Guardar proyectos requiere la app de escritorio.');
    return;
  }
  try {
    const current = useProjectFile.getState().path;
    const title = store.project.meta.title || 'proyecto';
    const path = await api.project.save(
      saveAs ? null : current,
      serializeProject(store.project),
      `${title.replace(/[<>:"/\\|?*]/g, '-')}.orbit`,
    );
    if (!path) return; // cancelado
    useProjectFile.setState({ path });
    markClean();
    notify(`Guardado en ${fileName(path)}.`);
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo guardar el proyecto.');
  }
}
