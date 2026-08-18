/**
 * ProjectStore: el proyecto vivo + bus de comandos + undo/redo.
 *
 * - `dispatch` es la ÚNICA puerta de mutación (UI, collab, Claude).
 * - `version` incrementa en cada cambio → la UI re-renderiza con
 *   useSyncExternalStore y componentes memoizados.
 * - `mergeKey` fusiona ráfagas (arrastre de una perilla) en un solo undo.
 * - `subscribeCommands` alimenta colaboración y el feed de actividad.
 * - `historyView` + `jumpTo` dan el historial navegable del panel: la lista
 *   completa (pasado + futuro) y el salto a cualquier punto.
 */

import { applyCommand, type Command } from './commands';
import { newId } from './ids';
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
  /**
   * Identidad estable de la entrada. Sobrevive a undo/redo (la entrada viaja
   * entre stacks conservando su id), así el panel puede pedir "salta AQUÍ" sin
   * depender de índices que se mueven con cada Ctrl+Z.
   */
  id: string;
  label: string;
  command: Command;
  inverse: Command;
  origin: string;
  mergeKey?: string;
  at: number;
}

/** Una entrada tal como la ve el panel de historial (sin comandos crudos). */
export interface HistoryItem {
  id: string;
  label: string;
  /** 'local' | 'remote:<user>' | 'claude'. */
  origin: string;
  at: number;
  /** true = su cambio está aplicado ahora; false = está en el futuro (rehacible). */
  done: boolean;
}

/** El historial completo con el presente marcado. */
export interface HistoryView {
  /**
   * Pasado en orden de aplicación seguido del futuro en el orden en que se
   * rehará. Es el orden de los stacks, no el del reloj: con varios orígenes
   * mezclados el `at` puede ir a saltos, pero así cada fila corresponde 1:1
   * con el punto al que salta.
   */
  entries: HistoryItem[];
  /** Cuántas entradas están aplicadas: el presente va justo antes de `entries[present]`. */
  present: number;
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
        id: newId(),
        label,
        command: cmd,
        inverse,
        origin,
        mergeKey: opts.mergeKey,
        at: now,
      });
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    }
    // Un comando nuevo invalida SOLO el redo de su propio origen: el redo de un
    // colaborador (o de Claude) sobrevive a que yo edite, y el mío sobrevive a
    // que edite otro. Vaciarlo entero borraba en silencio el Ctrl+Y del usuario
    // en cuanto llegaba cualquier cambio ajeno.
    this.redoStack = this.redoStack.filter((e) => e.origin !== origin);
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

  // ── Historial navegable (panel de historial) ──────────────────────────────

  /**
   * El historial entero para pintarlo: lo hecho (undoStack, del más viejo al
   * más nuevo) seguido de lo rehacible (redoStack al revés, que es el orden en
   * que `redo()` lo irá recuperando). `present` marca la frontera.
   */
  historyView(): HistoryView {
    const entries: HistoryItem[] = [];
    for (const e of this.undoStack) entries.push(toItem(e, true));
    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      entries.push(toItem(this.redoStack[i]!, false));
    }
    return { entries, present: this.undoStack.length };
  }

  /**
   * Salta al estado justo DESPUÉS de la entrada `id` (`null` = antes de todo).
   *
   * Semántica por origen, igual que `undo()`: solo mueve las entradas de
   * `origin`; lo de los demás se queda donde está (clicar un cambio remoto
   * lleva TUS cambios hasta ese punto de la lista, sin tocar los suyos).
   *
   * La coherencia sale gratis porque el salto no manipula los stacks a mano:
   * cuenta cuántos pasos de este origen hay entre el presente y el destino y
   * encadena `undo()`/`redo()`, que ya mueven cada entrada de un stack al otro
   * invirtiendo command/inverse. Al terminar, un Ctrl+Z posterior sigue siendo
   * un undo normal desde el punto nuevo.
   *
   * Devuelve cuántos pasos se aplicaron (0 = ya estábamos ahí, o `id` no está).
   */
  jumpTo(id: string | null, origin = 'local'): number {
    const boundary = this.boundaryOf(id);
    if (boundary === null) return 0;
    const present = this.undoStack.length;
    let steps = 0;

    if (boundary < present) {
      // Atrás: deshacer las entradas de este origen que queden por encima del
      // destino. El conteo se hace ANTES porque undo() encoge el stack.
      let pending = 0;
      for (let i = boundary; i < present; i++) {
        if (this.undoStack[i]!.origin === origin) pending++;
      }
      while (pending > 0 && this.undo(origin)) {
        pending--;
        steps++;
      }
    } else if (boundary > present) {
      // Adelante: rehacer hasta el destino. El futuro en orden es el redoStack
      // al revés, así que las `boundary - present` primeras posiciones desde el
      // tope son justo el tramo que hay que recuperar.
      let pending = 0;
      for (let i = 0; i < boundary - present; i++) {
        if (this.redoStack[this.redoStack.length - 1 - i]!.origin === origin) pending++;
      }
      while (pending > 0 && this.redo(origin)) {
        pending--;
        steps++;
      }
    }
    return steps;
  }

  /**
   * Cuántas entradas quedan aplicadas si el presente se pone justo tras `id`
   * (0 para `null` = proyecto virgen). null si ese id ya no existe.
   */
  private boundaryOf(id: string | null): number | null {
    if (id === null) return 0;
    for (let i = 0; i < this.undoStack.length; i++) {
      if (this.undoStack[i]!.id === id) return i + 1;
    }
    for (let i = this.redoStack.length - 1, pos = this.undoStack.length; i >= 0; i--, pos++) {
      if (this.redoStack[i]!.id === id) return pos + 1;
    }
    return null;
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

function toItem(e: HistoryEntry, done: boolean): HistoryItem {
  return { id: e.id, label: e.label, origin: e.origin, at: e.at, done };
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
    case 'setChannelEffect': return cmd.slot ? 'Insertar efecto en el canal' : 'Quitar efecto del canal';
    case 'patchChannelEffect': return 'Efecto del canal';
    case 'setChannelEffectParam': return `Efecto del canal: ${cmd.key}`;
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
    case 'setLayout': return cmd.windows ? `Guardar layout "${cmd.name}"` : `Borrar layout "${cmd.name}"`;
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
