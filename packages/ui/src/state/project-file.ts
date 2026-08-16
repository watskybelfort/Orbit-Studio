/**
 * Archivo del proyecto (.orbit): ruta actual, abrir/guardar por IPC y avisos
 * transitorios para la UI (sin alert()). Fuera de Electron los comandos avisan
 * de que requieren la app de escritorio.
 */

import {
  createChannel,
  createEmptyProject,
  createPattern,
  decodeMidi,
  parseProject,
  serializeProject,
  type Command,
  type Note,
} from '@orbit/core';
import { create } from 'zustand';
import { rehydrateSamples } from '../browser/sound-actions';
import { setActivePattern, store } from './app';
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

/**
 * Importa un .mid: un canal nuevo por pista (drums si va por el canal GM 9,
 * Orbit Synth si no) y un patrón nuevo con todas las notas; aplica el tempo
 * del archivo. Todo en un solo undo.
 */
export async function importMidi(): Promise<void> {
  const api = window.orbit;
  if (!api) {
    notify('Importar MIDI requiere la app de escritorio.');
    return;
  }
  try {
    const result = await api.midi.open();
    if (!result) return; // cancelado
    const midi = decodeMidi(new Uint8Array(result.data));
    if (midi.tracks.length === 0) {
      notify('Ese MIDI no trae notas.');
      return;
    }

    const project = store.project;
    let maxEnd = 1;
    for (const t of midi.tracks) {
      for (const n of t.notes) maxEnd = Math.max(maxEnd, n.start + n.duration);
    }

    const commands: Command[] = [];
    const notes: Record<string, Note[]> = {};
    midi.tracks.forEach((t, i) => {
      const channel = createChannel(
        t.midiChannel === 9 ? 'drums' : 'synth',
        project.channelOrder.length + i,
        t.name,
      );
      commands.push({ type: 'addChannel', channel });
      notes[channel.id] = t.notes;
    });

    const baseName = result.name.replace(/\.(mid|midi)$/i, '');
    const pattern = createPattern(project.patternOrder.length, `MIDI: ${baseName}`);
    pattern.length = Math.max(4, Math.ceil(maxEnd));
    pattern.notes = notes;
    commands.push({ type: 'addPattern', pattern });
    commands.push({ type: 'setTempo', tempo: midi.tempo });

    const label = `Importar MIDI "${result.name}"`;
    store.dispatch({ type: 'batch', label, commands }, { label });
    setActivePattern(pattern.id);
    notify(
      `Importado ${result.name}: ${midi.tracks.length} pista(s) a ${Math.round(midi.tempo)} BPM.`,
    );
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo importar el MIDI.');
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
