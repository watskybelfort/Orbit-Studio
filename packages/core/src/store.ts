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
 * - `historyTree` + `switchToBranch` son la parte en ÁRBOL: divergir ya no
 *   borra lo deshecho, lo archiva como rama a la que se puede volver
 *   (ver `history-tree.ts` y `docs/HISTORY.md`).
 */

import { applyCommand, type Command } from './commands';
import {
  branchChain,
  buildTreeView,
  isBranchableOrigin,
  type HistoryBranch,
  type HistoryTreeView,
} from './history-tree';
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
/**
 * Tope de ramas archivadas. Alto a propósito: una rama son punteros a
 * comandos que ya existían (no copias del proyecto), y perder una rama es
 * justo el fallo que este historial viene a arreglar.
 */
const MAX_BRANCHES = 200;

export class ProjectStore {
  project: Project;
  version = 0;

  /**
   * Sube cada vez que el historial se tira ENTERO: cargar un archivo, unirse a
   * una sala o re-derivar el proyecto tras un merge cruzado. La UI lo mira para
   * poder decir "el historial se reinició" en vez de enseñar una lista vacía
   * sin explicación — que es lo que pasaba hasta ahora en colaboración.
   */
  historyEpoch = 0;

  private listeners = new Set<StoreListener>();
  private commandListeners = new Set<CommandListener>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  /** Ramas abandonadas, colgadas del punto del tronco donde se bifurcaron. */
  private branches: HistoryBranch[] = [];

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
    // Punto de bifurcación: el presente ANTES de anotar este cambio. Es de ahí
    // de donde colgará la rama que estamos a punto de abandonar.
    const forkAt = top?.id ?? null;

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
      if (this.undoStack.length > MAX_HISTORY) {
        const dropped = this.undoStack.shift();
        if (dropped) this.forgetEntry(dropped.id);
      }
    }
    // Un comando nuevo saca del futuro SOLO lo de su propio origen: el redo de
    // un colaborador (o de Claude) sobrevive a que yo edite, y el mío sobrevive
    // a que edite otro. Vaciarlo entero borraba en silencio el Ctrl+Y del
    // usuario en cuanto llegaba cualquier cambio ajeno.
    //
    // Y lo que sale del futuro ya no se TIRA: se archiva como rama colgada de
    // `forkAt`. Eso es todo el árbol — divergir deja de ser destructivo.
    this.stashRedo(origin, forkAt);
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

  /**
   * De esta lista de ids, ¿cuáles ya NO aparecen en ningún comando del
   * historial —pasado, futuro o archivado en una rama— ni en su inverso?
   *
   * Es la pregunta que hace falta para soltar de verdad un sample huérfano
   * (o cualquier otro id que un comando lleve embebido) sin romper undo: uno
   * que el usuario borró hace un momento sigue vivo en el `inverse` de esa
   * misma entrada (`restoreChannel` guarda el canal entero, `sampleId`
   * incluido), así que sigue siendo recuperable y esto NO lo devuelve. Uno
   * cuya entrada ya cayó del historial (tope de 500, o su rama se podó) deja
   * de aparecer en cualquier lado y esto sí lo devuelve — ahí es cuando
   * "deshacer" ya no puede resucitarlo, así que es seguro dejar de contarlo
   * como registrado.
   *
   * Genérico a propósito: no sabe qué es un "sample" ni ningún otro concepto
   * del modelo, solo busca el texto exacto (entre comillas, para que un id
   * no cuente como encontrado por ser prefijo de otro). Un id que aparece de
   * casualidad en OTRO campo del mismo comando solo alarga su vida — nunca lo
   * pierde antes de tiempo — así que el único error posible cae del lado
   * seguro.
   */
  unreachableIds(ids: Iterable<string>): string[] {
    const candidates = new Set(ids);
    if (candidates.size === 0) return [];
    const strike = (cmd: Command) => {
      if (candidates.size === 0) return;
      const text = JSON.stringify(cmd);
      for (const id of candidates) {
        if (text.includes(JSON.stringify(id))) candidates.delete(id);
      }
    };
    for (const e of this.undoStack) {
      strike(e.command);
      strike(e.inverse);
    }
    for (const e of this.redoStack) {
      strike(e.command);
      strike(e.inverse);
    }
    for (const b of this.branches) {
      for (const e of b.entries) {
        strike(e.command);
        strike(e.inverse);
      }
    }
    return [...candidates];
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

  // ── Historial en árbol (ramas abandonadas) ────────────────────────────────

  /** El tronco de `historyView()` más las ramas guardadas, listo para pintar. */
  historyTree(): HistoryTreeView {
    return buildTreeView(this.historyView(), this.branches);
  }

  /** Cuántas ramas hay archivadas ahora mismo. */
  get branchCount(): number {
    return this.branches.length;
  }

  /**
   * Vuelve a una rama abandonada. Devuelve cuántos cambios se re-aplicaron
   * (0 = no se llegó: la rama no existe o su ancla se perdió).
   *
   * No es "restaurar una copia", es CAMBIAR DE CAMINO: el tramo del tronco que
   * dejas atrás se archiva a su vez como rama, así que la operación es
   * simétrica y no pierde nada — se puede ir y volver todas las veces que haga
   * falta. Si la rama cuelga de una entrada que hoy vive dentro de OTRA rama,
   * se sacan las dos en orden (`branchChain`).
   */
  switchToBranch(branchId: string): number {
    const chain = branchChain(this.branches, branchId, this.inTrunk);
    if (!chain) return 0;
    let steps = 0;
    for (const branch of chain) steps += this.restoreBranch(branch);
    return steps;
  }

  /** Tira una rama a la basura (el usuario ya no la quiere ver). */
  dropBranch(branchId: string): boolean {
    const before = this.branches.length;
    // Se van también las que colgaban de ella: sin su tronco no se alcanzan.
    this.branches = this.branches.filter((b) => b.id !== branchId);
    if (this.branches.length === before) return false;
    this.pruneUnreachableBranches();
    this.version++;
    for (const l of this.listeners) l();
    return true;
  }

  /** ¿Esta entrada sigue en el camino sacado (pasado o futuro)? */
  private inTrunk = (entryId: string): boolean =>
    this.undoStack.some((e) => e.id === entryId) ||
    this.redoStack.some((e) => e.id === entryId);

  /**
   * Saca del futuro todo lo de `origin` y lo archiva como rama colgada de
   * `anchorId`. Devuelve la rama creada, o null si no había nada que guardar.
   *
   * Las de `remote:*` se descartan como siempre: ver `isBranchableOrigin`.
   */
  private stashRedo(origin: string, anchorId: string | null): HistoryBranch | null {
    const kept: HistoryEntry[] = [];
    const taken: HistoryEntry[] = [];
    for (const e of this.redoStack) (e.origin === origin ? taken : kept).push(e);
    if (taken.length === 0) return null;
    this.redoStack = kept;
    if (!isBranchableOrigin(origin)) return null;

    // El redoStack guarda el futuro al revés (el tope es lo siguiente a
    // rehacer): darle la vuelta lo deja en orden de aplicación, que es como se
    // lee una rama.
    taken.reverse();
    const branch: HistoryBranch = {
      id: newId(),
      anchorId,
      origin,
      at: Date.now(),
      entries: taken,
    };
    this.branches.push(branch);
    if (this.branches.length > MAX_BRANCHES) {
      this.branches.shift();
      this.pruneUnreachableBranches();
    }
    return branch;
  }

  /**
   * Saca UNA rama al tronco. El orden importa:
   *
   * 1. Ponerse en el punto de bifurcación (`jumpTo`, que solo mueve lo de este
   *    origen — lo de Claude y lo de la sala se queda donde está).
   * 2. Archivar lo que quede en el futuro de este origen: es el camino que
   *    abandonamos, y si no sale de ahí se mezclaría con el que entra.
   * 3. Meter las entradas de la rama en el futuro y rehacerlas una a una.
   *
   * Los `inverse` de la rama se capturaron con el proyecto en el estado del
   * ancla, así que valen exactamente porque el paso 1 nos devuelve ahí. Es la
   * misma suposición que ya hace el undo por origen; si aun así un comando no
   * aplica, se para donde pueda y se devuelve lo que sí entró.
   */
  private restoreBranch(branch: HistoryBranch): number {
    if (branch.anchorId !== null && !this.inTrunk(branch.anchorId)) return 0;
    const { origin } = branch;

    this.jumpTo(branch.anchorId, origin);
    this.stashRedo(origin, branch.anchorId);
    this.branches = this.branches.filter((b) => b.id !== branch.id);

    for (let i = branch.entries.length - 1; i >= 0; i--) {
      this.redoStack.push(branch.entries[i]!);
    }
    let steps = 0;
    try {
      while (steps < branch.entries.length && this.redo(origin)) steps++;
    } catch (err) {
      console.warn('[historial] la rama no se pudo rehacer entera:', err);
    }
    return steps;
  }

  /** Una entrada se cayó del historial (tope de 500): sus ramas no se recolocan. */
  private forgetEntry(entryId: string): void {
    this.branches = this.branches.filter((b) => b.anchorId !== entryId);
    this.pruneUnreachableBranches();
  }

  /** Quita las ramas cuya cadena de anclas ya no llega al tronco. */
  private pruneUnreachableBranches(): void {
    this.branches = this.branches.filter(
      (b) => branchChain(this.branches, b.id, this.inTrunk) !== null,
    );
  }

  /**
   * Sustituye el proyecto entero (cargar archivo, unirse a una sala, re-derivar
   * tras un merge cruzado). Limpia el historial Y las ramas: sus comandos
   * guardaban inversos calculados contra un proyecto que ya no existe, y
   * re-aplicarlos daría basura. Sube `historyEpoch` para que la UI lo pueda
   * contar en vez de enseñar una lista vacía sin motivo.
   */
  replaceProject(project: Project): void {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.branches = [];
    this.historyEpoch++;
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
    case 'addChannelGroup': return `Carpeta "${cmd.group.name}"`;
    case 'removeChannelGroup': return 'Deshacer carpeta';
    case 'patchChannelGroup': return 'Ajustar carpeta';
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
    case 'addSections': return cmd.sections.length === 1 ? `Sección "${cmd.sections[0]!.name}"` : `${cmd.sections.length} secciones`;
    case 'removeSections': return `Borrar ${cmd.sectionIds.length} sección(es)`;
    case 'restoreSections': return 'Restaurar secciones';
    case 'patchSections': return `Editar ${cmd.patches.length} sección(es)`;
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
    case 'patchSend': return 'Ajustar send';
    case 'setSend': return 'Send';
    case 'setRoute': return 'Routing';
    case 'addInputRoute': return `Entrada "${cmd.route.name}"`;
    case 'removeInputRoute': return 'Quitar entrada';
    case 'patchInputRoute': return 'Ajustar entrada';
    case 'registerSample': return `Sample "${cmd.sample.name}"`;
    case 'unregisterSample': return 'Quitar sample';
    case 'batch': return cmd.label ?? `${cmd.commands.length} cambios`;
  }
}
