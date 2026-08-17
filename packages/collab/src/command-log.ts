/**
 * Replicación por log de comandos sobre Yjs (docs/COLLAB.md).
 *
 * El doc contiene:
 * - Y.Array 'commands': log append-only de entradas {cmd, origin, user, client, seq}.
 * - Y.Map 'meta': {snapshot: JSON del proyecto base, snapshotSeq: nº de
 *   comandos ya absorbidos por el snapshot}.
 *
 * Cada cliente anexa sus comandos locales (origin 'local' | 'claude') al log
 * dentro de una transacción con origen propio, y aplica los remotos con
 * `store.dispatch(cmd, {origin: 'remote:<user>'})`. La idempotencia la da un
 * guard por (clientID, seq). Como los comandos de core son deterministas y el
 * log Yjs tiene orden total, todos los clientes convergen: si un merge inserta
 * entradas ANTES de algo ya aplicado (edición concurrente), se re-deriva el
 * estado completo desde snapshot + log para respetar ese orden total.
 *
 * Compactación: cuando el log supera el umbral, el host (clientID más bajo
 * presente) escribe snapshot = serializeProject(proyecto), suma las entradas
 * absorbidas a snapshotSeq y recorta el log en la misma transacción.
 */

import * as Y from 'yjs';
import {
  applyCommand,
  parseProject,
  serializeProject,
  type Command,
  type Id,
  type Project,
  type ProjectStore,
} from '@orbit/core';
import {
  checkRole,
  isCollabRole,
  trackDeletionTargets,
  DEFAULT_ROLE,
  type CollabRole,
} from './roles';

/** Identidad visible de un colaborador. */
export interface CollabUser {
  name: string;
  color: string;
}

/** Entrada del log de comandos replicado. */
export interface LogEntry {
  /** Comando serializable de core. */
  cmd: Command;
  /** Origen original en el cliente emisor ('local' | 'claude'). */
  origin: string;
  /** Nombre visible del usuario emisor (para 'remote:<user>' y el historial). */
  user: string;
  /** clientID Yjs del emisor — junto a `seq` identifica la entrada. */
  client: number;
  /** Contador monótono por cliente. */
  seq: number;
  /** Rol del emisor al emitir (lo validan TODOS los clientes por igual). */
  role?: CollabRole;
  /** El emisor borra algo que él mismo creó en esta sesión (ver roles.ts). */
  own?: boolean;
}

/** Aviso de comando rechazado por permisos (para que la UI lo enseñe). */
export interface DeniedInfo {
  cmd: Command;
  role: CollabRole;
  reason: string;
  /** Nombre del emisor: uno mismo si `local`, o el colaborador remoto. */
  user: string;
  /** ¿Lo rechazamos nuestro (true) o veníamos de la red (false)? */
  local: boolean;
}

export interface CommandLogOptions {
  /** Nº de entradas a partir del cual el host compacta (por defecto 2000). */
  compactThreshold?: number;
  /**
   * ¿Es este cliente el host? Solo el host compacta. Con awareness es "el
   * clientID más bajo presente" (lo pasa CollabSession); sin red (un solo
   * cliente o tests) el valor por defecto `true` es el correcto.
   */
  isHost?: () => boolean;
  /**
   * Rol de ESTE cliente en la sala. Es una función para que cambiarlo en
   * caliente (el productor te asciende) no obligue a rehacer el binding.
   */
  getRole?: () => CollabRole;
  /** Se llama cuando un comando se rechaza por permisos (no rompe la sesión). */
  onDenied?: (info: DeniedInfo) => void;
  /**
   * El proyecto se ha SUSTITUIDO entero (unirse a la sala o re-derivar tras un
   * merge cruzado). Quien escucha esto tiene que rehidratar todo lo que no vive
   * en el proyecto serializado — sobre todo los BYTES de los samples: tras un
   * replaceProject el modelo está lleno de referencias y el kernel, vacío.
   */
  onProjectReplaced?: () => void;
}

/** Umbral de compactación por defecto. */
export const DEFAULT_COMPACT_THRESHOLD = 2000;

/** Clave de idempotencia de una entrada. */
function entryKey(client: number, seq: number): string {
  return `${client}:${seq}`;
}

/** Ids de pistas/patrones que borra un comando, entrando también en los lotes. */
function collectTrackDeletions(cmd: Command): Id[] {
  if (cmd.type === 'batch') {
    return cmd.commands.flatMap((sub) => collectTrackDeletions(sub));
  }
  return trackDeletionTargets(cmd);
}

/**
 * Enlaza un ProjectStore con el log de comandos de un Y.Doc. Es la pieza que
 * CollabSession usa por dentro; no sabe nada de WebSockets, así que se puede
 * testear conectando dos Y.Doc a mano.
 */
export class CommandLogBinding {
  private readonly store: ProjectStore;
  private readonly doc: Y.Doc;
  private readonly user: CollabUser;
  private readonly log: Y.Array<LogEntry>;
  private readonly meta: Y.Map<string | number>;
  private readonly compactThreshold: number;
  private readonly isHost: () => boolean;
  private readonly getRole: () => CollabRole;
  private readonly onDenied: ((info: DeniedInfo) => void) | undefined;
  private readonly onProjectReplaced: (() => void) | undefined;

  /** Entradas ya aplicadas a (u originadas por) nuestro store. */
  private applied = new Set<string>();
  /** Ids de pistas/patrones creados por NOSOTROS en esta sesión (ver roles.ts). */
  private ownCreations = new Set<Id>();
  /** Estamos revirtiendo un comando denegado: no re-anexar el inverso. */
  private reverting = false;
  /** Contador propio para numerar entradas. */
  private seq = 0;
  private unsubscribeCommands: (() => void) | null = null;
  private observer:
    | ((event: Y.YArrayEvent<LogEntry>, transaction: Y.Transaction) => void)
    | null = null;
  private started = false;

  constructor(
    store: ProjectStore,
    doc: Y.Doc,
    user: CollabUser,
    opts: CommandLogOptions = {},
  ) {
    this.store = store;
    this.doc = doc;
    this.user = user;
    this.log = doc.getArray<LogEntry>('commands');
    this.meta = doc.getMap<string | number>('meta');
    this.compactThreshold = opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    this.isHost = opts.isHost ?? (() => true);
    this.getRole = opts.getRole ?? (() => DEFAULT_ROLE);
    this.onDenied = opts.onDenied;
    this.onProjectReplaced = opts.onProjectReplaced;
  }

  /**
   * Arranca el binding. Si el doc ya tiene snapshot (room existente), carga
   * snapshot + log en el store (unirse = recibir el proyecto completo); si el
   * doc está vacío, publica el proyecto local como snapshot base (crear room).
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const snapshot = this.meta.get('snapshot');
    if (typeof snapshot === 'string') {
      this.join(snapshot);
    } else {
      this.bootstrap();
    }

    // Entradas remotas nuevas → aplicar (las transacciones propias se saltan).
    this.observer = (_event, transaction) => {
      if (transaction.origin === this) return;
      this.process();
    };
    this.log.observe(this.observer);

    // Comandos locales (o de Claude) → anexar al log. Los que aplicamos
    // nosotros desde el log llegan con origin 'remote:*' y no se re-anexan.
    this.unsubscribeCommands = this.store.subscribeCommands((cmd, origin) => {
      if (origin.startsWith('remote:')) return;
      // El inverso de un comando denegado que estamos revirtiendo: ni al log.
      if (this.reverting) return;
      this.append(cmd, origin);
    });

    // Por si el doc traía entradas pendientes fuera del caso estándar.
    this.process();
  }

  /** Suelta observers y suscripciones. No toca el doc ni el store. */
  destroy(): void {
    this.unsubscribeCommands?.();
    this.unsubscribeCommands = null;
    if (this.observer) {
      this.log.unobserve(this.observer);
      this.observer = null;
    }
    this.started = false;
  }

  // ── Unirse / crear ─────────────────────────────────────────────────────────

  /** Carga snapshot + log en el store (sustituye el proyecto local). */
  private join(snapshotJson: string): void {
    const project = parseProject(snapshotJson);
    for (const entry of this.log.toArray()) {
      // Clonamos: el objeto del log pertenece a Yjs y no debe mutar.
      if (this.entryAllowed(entry)) this.safeApply(project, structuredClone(entry.cmd));
      this.applied.add(entryKey(entry.client, entry.seq));
    }
    this.store.replaceProject(project);
    this.notifyProjectReplaced();
  }

  /** Publica el proyecto local como base del room. */
  private bootstrap(): void {
    this.doc.transact(() => {
      this.meta.set('snapshot', serializeProject(this.store.project));
      this.meta.set('snapshotSeq', 0);
    }, this);
  }

  // ── Local → log ────────────────────────────────────────────────────────────

  private append(cmd: Command, origin: string): void {
    const role = this.getRole();
    const own = this.deletesOnlyOwnTracks(cmd);
    const verdict = checkRole(role, cmd, { ownCreation: own });
    if (!verdict.allowed) {
      this.revertLocal(cmd, origin, role, verdict.reason ?? 'Tu rol no permite este cambio.');
      return;
    }
    this.rememberOwnCreations(cmd);

    const entry: LogEntry = {
      // Clon profundo: congela los valores en el momento del append (los
      // objetos del comando siguen vivos dentro del proyecto y mutarían el
      // contenido almacenado en Yjs).
      cmd: structuredClone(cmd),
      origin,
      user: this.user.name,
      client: this.doc.clientID,
      seq: this.seq++,
      role,
      ...(own ? { own: true } : null),
    };
    // Ya está aplicado localmente (dispatch ocurrió antes de emitir).
    this.applied.add(entryKey(entry.client, entry.seq));
    this.doc.transact(() => {
      this.log.push([entry]);
    }, this);
    this.maybeCompact();
  }

  // ── Permisos ───────────────────────────────────────────────────────────────

  /**
   * Comando local denegado: ya se aplicó al store (dispatch avisa DESPUÉS de
   * mutar), así que lo deshacemos por su propio origen para volver al estado
   * que ve la sala. Nunca llega al log, así que nadie más lo ve. La sesión
   * sigue viva: solo se avisa.
   */
  private revertLocal(cmd: Command, origin: string, role: CollabRole, reason: string): void {
    this.reverting = true;
    let reverted = false;
    try {
      reverted = this.store.undo(origin);
    } finally {
      this.reverting = false;
    }
    if (!reverted) {
      // No debería pasar (dispatch siempre deja su entrada en el historial),
      // pero si pasa conviene verlo: el local quedaría por delante de la sala.
      console.warn('[collab] comando denegado sin poder revertirse en local:', cmd.type);
    }
    this.onDenied?.({ cmd, role, reason, user: this.user.name, local: true });
  }

  /**
   * ¿Permite el rol del EMISOR esta entrada? Se evalúa igual en todos los
   * clientes (rol y `own` viajan sellados en la entrada), así que un comando
   * rechazado se rechaza en todas partes y la convergencia se mantiene.
   */
  private entryAllowed(entry: LogEntry): boolean {
    const role = isCollabRole(entry.role) ? entry.role : DEFAULT_ROLE;
    return checkRole(role, entry.cmd, { ownCreation: entry.own === true }).allowed;
  }

  /** Apunta lo que creamos nosotros (para poder deshacer su creación). */
  private rememberOwnCreations(cmd: Command): void {
    switch (cmd.type) {
      case 'addChannel':
      case 'restoreChannel':
        this.ownCreations.add(cmd.channel.id);
        break;
      case 'addPattern':
      case 'restorePattern':
        // Desde que borrar un patrón cuenta como borrado protegido, sin esto un
        // invitado no podría deshacer ni su propio "patrón nuevo".
        this.ownCreations.add(cmd.pattern.id);
        break;
      case 'addPlaylistTrack':
      case 'restorePlaylistTrack':
        this.ownCreations.add(cmd.track.id);
        break;
      case 'addArrangement':
      case 'restoreArrangement':
        this.ownCreations.add(cmd.arrangement.id);
        break;
      case 'batch':
        for (const sub of cmd.commands) this.rememberOwnCreations(sub);
        break;
      default:
        break;
    }
  }

  /** ¿El comando borra pistas y TODAS son nuestras de esta sesión? */
  private deletesOnlyOwnTracks(cmd: Command): boolean {
    const targets = collectTrackDeletions(cmd);
    if (targets.length === 0) return false;
    return targets.every((id) => this.ownCreations.has(id));
  }

  // ── Log → store ────────────────────────────────────────────────────────────

  /**
   * Aplica en orden las entradas pendientes. Si el merge dejó entradas nuevas
   * ANTES de alguna ya aplicada, el orden local difiere del orden total del
   * log → re-derivar todo el estado (snapshot + log).
   */
  private process(): void {
    const entries = this.log.toArray();
    const pending: LogEntry[] = [];
    let sawPending = false;
    let outOfOrder = false;
    for (const entry of entries) {
      if (this.applied.has(entryKey(entry.client, entry.seq))) {
        if (sawPending) {
          outOfOrder = true;
          break;
        }
      } else {
        sawPending = true;
        pending.push(entry);
      }
    }

    if (outOfOrder) {
      this.replay(entries);
    } else {
      for (const entry of pending) {
        this.applied.add(entryKey(entry.client, entry.seq));
        if (!this.entryAllowed(entry)) {
          // Un cliente con permisos caducados (o manipulado) mandó algo que su
          // rol no permite: se descarta en TODOS los clientes por igual.
          const role = isCollabRole(entry.role) ? entry.role : DEFAULT_ROLE;
          this.onDenied?.({
            cmd: entry.cmd,
            role,
            reason: checkRole(role, entry.cmd, { ownCreation: entry.own === true }).reason ?? '',
            user: entry.user,
            local: false,
          });
          continue;
        }
        try {
          this.store.dispatch(structuredClone(entry.cmd), {
            origin: `remote:${entry.user}`,
          });
        } catch (err) {
          // Determinista: si aquí no aplica, no aplica en ningún cliente.
          console.warn('[collab] comando remoto no aplicable (se ignora):', err);
        }
      }
    }
    this.maybeCompact();
  }

  /**
   * Reconstruye el proyecto desde snapshot + log completo en orden total.
   * Coste: sustituye el proyecto (el historial de undo local se pierde);
   * solo ocurre con ediciones concurrentes que se cruzaron en el merge.
   */
  private replay(entries: LogEntry[]): void {
    const snapshotJson = this.meta.get('snapshot');
    if (typeof snapshotJson !== 'string') {
      // Sin snapshot no hay base para re-derivar: aplica lo pendiente y sigue.
      for (const entry of entries) {
        const key = entryKey(entry.client, entry.seq);
        if (this.applied.has(key)) continue;
        this.applied.add(key);
        if (!this.entryAllowed(entry)) continue;
        try {
          this.store.dispatch(structuredClone(entry.cmd), {
            origin: `remote:${entry.user}`,
          });
        } catch (err) {
          console.warn('[collab] comando remoto no aplicable (se ignora):', err);
        }
      }
      return;
    }
    const project = parseProject(snapshotJson);
    this.applied = new Set();
    for (const entry of entries) {
      if (this.entryAllowed(entry)) this.safeApply(project, structuredClone(entry.cmd));
      this.applied.add(entryKey(entry.client, entry.seq));
    }
    this.store.replaceProject(project);
    this.notifyProjectReplaced();
  }

  private safeApply(project: Project, cmd: Command): void {
    try {
      applyCommand(project, cmd);
    } catch (err) {
      console.warn('[collab] comando del log no aplicable (se ignora):', err);
    }
  }

  /**
   * Avisa de que el proyecto se cambió de golpe. Va aislado en su try porque
   * quien escucha esto toca el motor de audio: que se le atragante un sample no
   * puede tumbar la réplica.
   */
  private notifyProjectReplaced(): void {
    try {
      this.onProjectReplaced?.();
    } catch (err) {
      console.warn('[collab] rehidratación tras replaceProject falló:', err);
    }
  }

  // ── Compactación ───────────────────────────────────────────────────────────

  /**
   * El host recorta el log cuando supera el umbral: escribe el proyecto
   * actual como snapshot, acumula snapshotSeq y borra las entradas absorbidas
   * en la misma transacción. Solo compacta si está al día con TODO el log
   * (si no, el snapshot no representaría esas entradas).
   */
  private maybeCompact(): void {
    if (this.log.length <= this.compactThreshold) return;
    if (!this.isHost()) return;
    const entries = this.log.toArray();
    for (const entry of entries) {
      if (!this.applied.has(entryKey(entry.client, entry.seq))) return;
    }
    const count = entries.length;
    const prev = this.meta.get('snapshotSeq');
    const snapshotSeq = (typeof prev === 'number' ? prev : 0) + count;
    this.doc.transact(() => {
      this.meta.set('snapshot', serializeProject(this.store.project));
      this.meta.set('snapshotSeq', snapshotSeq);
      this.log.delete(0, count);
    }, this);
  }
}
