/**
 * ProjectStore: el proyecto vivo + bus de comandos + undo/redo.
 *
 * - `dispatch` es la ÚNICA puerta de mutación (UI, collab, Claude).
 * - `version` incrementa en cada cambio → la UI re-renderiza con
 *   useSyncExternalStore y componentes memoizados.
 * - `mergeKey` fusiona ráfagas (arrastre de una perilla) en un solo undo.
 * - `subscribeCommands` alimenta colaboración y el feed de actividad.
 */

import { applyCommand, type Command } from './commands';
import { createEmptyProject } from './model/defaults';
import type { Project } from './model/types';

export interface DispatchOptions {
  /** Etiqueta legible para el historial ("Mover 3 notas"). */
  label?: string;
  /** Quién origina el cambio: 'local' | 'remote:<user>' | 'claude'. */
  origin?: string;
  /** Fusiona con el último entry si comparte mergeKey (perillas). */
  mergeKey?: string;
}

export interface HistoryEntry {
  label: string;
  command: Command;
  inverse: Command;
  origin: string;
  mergeKey?: string;
  at: number;
}

export type StoreListener = () => void;
export type CommandListener = (cmd: Command, origin: string, label: string) => void;

const MAX_HISTORY = 500;
const MERGE_WINDOW_MS = 800;

export class ProjectStore {
  project: Project;
  version = 0;

  private listeners = new Set<StoreListener>();
  private commandListeners = new Set<CommandListener>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(project?: Project) {
    this.project = project ?? createEmptyProject();
  }

  // ── Suscripción (React: useSyncExternalStore) ─────────────────────────────

  subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Escucha cada comando aplicado (collab, feed de Claude, autosave...). */
  subscribeCommands(listener: CommandListener): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  private emit(cmd: Command, origin: string, label: string) {
    this.version++;
    for (const l of this.listeners) l();
    for (const l of this.commandListeners) l(cmd, origin, label);
  }

  // ── Dispatch / undo / redo ────────────────────────────────────────────────

  dispatch(cmd: Command, opts: DispatchOptions = {}): void {
    const origin = opts.origin ?? 'local';
    const label = opts.label ?? describeCommand(cmd);
    const inverse = applyCommand(this.project, cmd);
    const now = Date.now();

    const top = this.undoStack[this.undoStack.length - 1];
    if (
      opts.mergeKey &&
      top &&
      top.mergeKey === opts.mergeKey &&
      top.origin === origin &&
      now - top.at < MERGE_WINDOW_MS
    ) {
      // Ráfaga: conserva el inverso original, sustituye el comando final.
      top.command = cmd;
      top.at = now;
    } else {
      this.undoStack.push({
        label,
        command: cmd,
        inverse,
        origin,
        mergeKey: opts.mergeKey,
        at: now,
      });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    this.redoStack = [];
    this.emit(cmd, origin, label);
  }

  /** Deshace el último cambio de `origin` (undo por usuario). */
  undo(origin = 'local'): boolean {
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      if (this.undoStack[i]!.origin !== origin) continue;
      const [entry] = this.undoStack.splice(i, 1);
      const redoInverse = applyCommand(this.project, entry!.inverse);
      this.redoStack.push({ ...entry!, command: entry!.inverse, inverse: redoInverse });
      this.emit(entry!.inverse, origin, `Deshacer: ${entry!.label}`);
      return true;
    }
    return false;
  }

  redo(origin = 'local'): boolean {
    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      if (this.redoStack[i]!.origin !== origin) continue;
      const [entry] = this.redoStack.splice(i, 1);
      const undoInverse = applyCommand(this.project, entry!.inverse);
      this.undoStack.push({ ...entry!, command: entry!.inverse, inverse: undoInverse });
      this.emit(entry!.inverse, origin, `Rehacer: ${entry!.label}`);
      return true;
    }
    return false;
  }

  get history(): readonly HistoryEntry[] {
    return this.undoStack;
  }

  /** Sustituye el proyecto entero (cargar archivo). Limpia el historial. */
  replaceProject(project: Project): void {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.version++;
    for (const l of this.listeners) l();
  }
}

/** Etiqueta humana por defecto para el historial. */
export function describeCommand(cmd: Command): string {
  switch (cmd.type) {
    case 'setTempo': return `Tempo → ${cmd.tempo} BPM`;
    case 'setSwing': return 'Swing';
    case 'setTimeSig': return 'Compás';
    case 'setMeta': return 'Info del proyecto';
    case 'addChannel': return `Añadir canal "${cmd.channel.name}"`;
    case 'removeChannel': return 'Borrar canal';
    case 'restoreChannel': return `Restaurar canal "${cmd.channel.name}"`;
    case 'patchChannel': return 'Ajustar canal';
    case 'setChannelParam': return `Parámetro ${cmd.key}`;
    case 'moveChannel': return 'Reordenar canales';
    case 'addPattern': return `Añadir "${cmd.pattern.name}"`;
    case 'removePattern': return 'Borrar patrón';
    case 'restorePattern': return `Restaurar "${cmd.pattern.name}"`;
    case 'patchPattern': return 'Ajustar patrón';
    case 'addNotes': return `${cmd.notes.length} nota(s)`;
    case 'removeNotes': return `Borrar ${cmd.noteIds.length} nota(s)`;
    case 'patchNotes': return `Editar ${cmd.patches.length} nota(s)`;
    case 'addPlaylistTrack': return 'Añadir pista';
    case 'removePlaylistTrack': return 'Borrar pista';
    case 'restorePlaylistTrack': return 'Restaurar pista';
    case 'patchPlaylistTrack': return 'Ajustar pista';
    case 'addClips': return `${cmd.clips.length} clip(s)`;
    case 'removeClips': return `Borrar ${cmd.clipIds.length} clip(s)`;
    case 'restoreClips': return 'Restaurar clips';
    case 'patchClips': return `Editar ${cmd.patches.length} clip(s)`;
    case 'addArrangement': return `Arrangement "${cmd.arrangement.name}"`;
    case 'removeArrangement': return 'Borrar arrangement';
    case 'restoreArrangement': return 'Restaurar arrangement';
    case 'patchArrangement': return 'Renombrar arrangement';
    case 'setActiveArrangement': return 'Cambiar arrangement';
    case 'addLfos': return `${cmd.lfos.length} LFO(s)`;
    case 'removeLfos': return `Quitar ${cmd.lfoIds.length} LFO(s)`;
    case 'restoreLfos': return 'Restaurar LFO(s)';
    case 'patchLfo': return 'Ajustar LFO';
    case 'addMarker': return `Marcador "${cmd.marker.name}"`;
    case 'removeMarker': return 'Borrar marcador';
    case 'patchMarker': return 'Editar marcador';
    case 'patchMixerTrack': return 'Mixer';
    case 'setEffect': return cmd.slot ? 'Insertar efecto' : 'Quitar efecto';
    case 'patchEffect': return 'Efecto';
    case 'setEffectParam': return `Efecto: ${cmd.key}`;
    case 'setSend': return 'Send';
    case 'setRoute': return 'Routing';
    case 'registerSample': return `Sample "${cmd.sample.name}"`;
    case 'unregisterSample': return 'Quitar sample';
    case 'batch': return cmd.label ?? `${cmd.commands.length} cambios`;
  }
}
