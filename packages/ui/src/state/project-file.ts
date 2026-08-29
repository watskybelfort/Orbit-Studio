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
import { saveVersion } from './versions';
import { create } from 'zustand';
import { rehydrateSamples } from '../browser/sound-actions';
import { engine, setActivePattern, store } from './app';
import { collectWorkletSamples } from './sample-gc';
import { confirmDiscard, markClean, markCleanAt } from './autosave';
import {
  describeTemplateLoad,
  describeTemplateSave,
  externalSamples,
  findStoredTemplate,
  instantiateTemplate,
  saveCurrentProjectAsTemplate,
} from './project-templates';

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
  if (!confirmDiscard('Empezar un proyecto nuevo')) return;
  store.replaceProject(createEmptyProject());
  useProjectFile.setState({ path: null });
  markClean();
  // El proyecto anterior se fue entero y con él su historial, así que ningún
  // undo puede reclamar ya sus samples: es el momento en que de verdad sobran
  // en el worklet. Los otros caminos de reemplazo total (abrir un .orbit,
  // plantilla, autosave, restaurar versión) ya recolectan al rehidratar; este
  // no rehidrata nada —arranca vacío— y se quedaba sin soltar nada.
  collectWorkletSamples(engine, store.project);
  notify('Proyecto nuevo.');
}

/**
 * Proyecto nuevo desde una plantilla GUARDADA (de fábrica o del usuario, ver
 * `state/project-templates.ts`): un `.orbit` con nombre, no un generador de
 * código. `instantiateTemplate` le da id propio para que su historial de
 * versiones no se mezcle con el de otra canción nacida de la misma plantilla.
 *
 * Si trae samples que no son del pack de fábrica se intentan cargar igual, y
 * si alguno no aparece en este equipo se avisa CON NOMBRES — abrir un
 * proyecto con canales mudos y sin decir por qué es peor que no abrirlo.
 */
export async function newProjectFromStoredTemplate(id: string): Promise<void> {
  const template = findStoredTemplate(id);
  if (!template) {
    notify('Esa plantilla ya no está.');
    return;
  }
  if (!confirmDiscard(`Cargar la plantilla "${template.name}"`)) return;
  let project;
  try {
    project = instantiateTemplate(template);
  } catch (err) {
    notify(err instanceof Error ? err.message : 'Esa plantilla no se pudo leer.');
    return;
  }
  store.replaceProject(project);
  useProjectFile.setState({ path: null });
  markClean();
  const first = store.project.patternOrder[0];
  if (first) setActivePattern(first);
  const missing = await rehydrateSamples();
  notify(describeTemplateLoad(template.name, missing));
}

/**
 * Guarda el proyecto actual como plantilla con nombre (rama "Plantillas" del
 * Browser). Si usa samples que no son del pack de fábrica, lo dice ya en el
 * guardado: mejor saber ahí que esa plantilla no viaja sola que descubrirlo
 * mudo al abrirla en otro equipo.
 */
export function saveProjectAsTemplate(name: string, description = ''): void {
  const clean = name.trim();
  if (clean === '') {
    notify('La plantilla necesita un nombre.');
    return;
  }
  const template = saveCurrentProjectAsTemplate(store.project, clean, description);
  notify(describeTemplateSave(template.name, externalSamples(store.project)));
}

/** Lo que hay que hacer con un .orbit ya leído, venga del diálogo o de los recientes. */
function applyOpened(result: { path: string; json: string }): void {
  const project = parseProject(result.json);
  store.replaceProject(project);
  useProjectFile.setState({ path: result.path });
  markClean();
  // Los samples referenciados se resuben al kernel (arranca vacío).
  void rehydrateSamples();
  void refreshRecents();
  notify(`Abierto ${fileName(result.path)}.`);
}

export async function openProject(): Promise<void> {
  const api = window.orbit;
  if (!api) {
    notify('Abrir proyectos requiere la app de escritorio.');
    return;
  }
  if (!confirmDiscard('Abrir otro proyecto')) return;
  try {
    const result = await api.project.open();
    if (!result) return; // cancelado
    applyOpened(result);
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo abrir el proyecto.');
  }
}

// ── Proyectos recientes ──────────────────────────────────────────────────────

export interface RecentProject {
  path: string;
  name: string;
  /** false = la ruta ya no existe (disco desconectado, archivo movido). */
  exists: boolean;
}

/**
 * La lista la sirve el main, que es su dueño: vive en settings.json por un canal
 * propio y `settings:set` no la puede escribir. Aquí solo se cachea para poder
 * pintarla sin esperar al IPC cada vez que se abre el menú.
 */
export const useRecentProjects = create<{ list: RecentProject[] }>(() => ({ list: [] }));

export async function refreshRecents(): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  try {
    useRecentProjects.setState({ list: await api.project.recent() });
  } catch {
    useRecentProjects.setState({ list: [] });
  }
}

/** Abre un reciente sin diálogo. Si ya no está, el main lo olvida y se avisa. */
export async function openRecentProject(path: string): Promise<void> {
  const api = window.orbit;
  if (!api) {
    notify('Abrir proyectos requiere la app de escritorio.');
    return;
  }
  if (!confirmDiscard('Abrir ese proyecto')) return;
  try {
    const result = await api.project.openRecent(path);
    if (!result) return;
    applyOpened(result);
  } catch (err) {
    void refreshRecents();
    notify(err instanceof Error ? err.message : 'No se pudo abrir ese reciente.');
  }
}

/** Vacía la lista de recientes (sin tocar los archivos). */
export async function clearRecents(): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  try {
    await api.project.forgetRecent();
  } finally {
    void refreshRecents();
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
    // Se captura la versión JUNTO al JSON, antes del diálogo: lo que se marca
    // limpio es esta foto, no el estado de después (que un peer/Claude pudo
    // mover mientras el diálogo estaba abierto).
    const savedVersion = store.version;
    const json = serializeProject(store.project);
    const path = await api.project.save(
      saveAs ? null : current,
      json,
      `${title.replace(/[<>:"/\\|?*]/g, '-')}.orbit`,
    );
    if (!path) return; // cancelado
    useProjectFile.setState({ path });
    markCleanAt(savedVersion);
    void refreshRecents();
    // Cada guardado deja también una VERSIÓN: es el punto que uno considera
    // digno de guardar, así que es exactamente el punto al que querrá volver.
    void saveVersion('guardado');
    notify(`Guardado en ${fileName(path)}.`);
  } catch (err) {
    notify(err instanceof Error ? err.message : 'No se pudo guardar el proyecto.');
  }
}
