/**
 * CollabSession: sesión colaborativa de un cliente.
 *
 * Habla el protocolo y-websocket A MANO (y-protocols/sync + awareness sobre
 * el WebSocket nativo del navegador; el paquete y-websocket es cosa de
 * apps/server y no se importa aquí):
 *
 *   mensaje = [messageType: varUint, cuerpo…]
 *   messageType 0 → y-sync (step1 / step2 / update)
 *   messageType 1 → awareness (presencia)
 *
 * Reconexión con backoff simple (1s, 2s, 4s… máx 15s). La réplica del
 * proyecto la lleva CommandLogBinding (log de comandos sobre el Y.Doc).
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { ProjectStore } from '@orbit/core';
import { CommandLogBinding, type CollabUser } from './command-log';
import { normalizeRoomCode } from './room-code';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

/** Qué está haciendo un usuario ("Piano Roll de Orbit Sub"…). */
export interface PeerActivity {
  editor: string;
  detail?: string;
  /** Posición del cursor en beats (para pintarlo en playlist/piano roll). */
  beat?: number;
  /** Altura bajo el cursor en el piano roll (nota MIDI). */
  key?: number;
}

/** Un conectado al room (según awareness), incluido uno mismo. */
export interface PeerInfo {
  clientId: number;
  user: CollabUser;
  activity?: PeerActivity;
  /** Este usuario tiene a Claude conectado trabajando en la sesión. */
  claudeActive?: boolean;
  isSelf: boolean;
}

export interface CollabSessionOptions {
  user: CollabUser;
  /** Umbral de compactación del log (por defecto 2000 entradas). */
  compactThreshold?: number;
}

export class CollabSession {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private readonly store: ProjectStore;
  private readonly user: CollabUser;
  private readonly compactThreshold: number | undefined;

  private binding: CommandLogBinding | null = null;
  private ws: WebSocket | null = null;
  private url = '';
  private room = '';
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BACKOFF_START_MS;
  private wsOpen = false;
  private synced = false;
  private peersCallbacks = new Set<(peers: PeerInfo[]) => void>();
  private firstSync: { resolve: () => void; reject: (err: Error) => void } | null = null;

  constructor(store: ProjectStore, opts: CollabSessionOptions) {
    this.store = store;
    this.user = opts.user;
    this.compactThreshold = opts.compactThreshold;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField('user', opts.user);
    this.awareness.on('update', this.handleAwarenessUpdate);
    this.awareness.on('change', this.handleAwarenessChange);
    this.doc.on('update', this.handleDocUpdate);
  }

  // ── API pública ────────────────────────────────────────────────────────────

  /**
   * Conecta al room y resuelve tras la primera sincronización completa
   * (a partir de ahí el binding replica comandos). Si la conexión se cae,
   * reintenta sola con backoff hasta `disconnect()`.
   */
  connect(url: string, room: string): Promise<void> {
    if (this.ws || this.reconnectTimer) {
      return Promise.reject(
        new Error('Ya hay una conexión activa; llama a disconnect() primero'),
      );
    }
    this.url = url.replace(/\/+$/, '');
    this.room = normalizeRoomCode(room);
    this.shouldReconnect = true;
    this.backoffMs = BACKOFF_START_MS;
    // Si venimos de un disconnect(), recupera la presencia propia.
    if (this.awareness.getLocalState() === null) {
      this.awareness.setLocalStateField('user', this.user);
    }
    return new Promise<void>((resolve, reject) => {
      this.firstSync = { resolve, reject };
      this.openSocket();
    });
  }

  /** Corta la sesión: avisa a los demás, cierra el socket y suelta el binding. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.firstSync) {
      this.firstSync.reject(new Error('Sesión desconectada antes de sincronizar'));
      this.firstSync = null;
    }
    if (this.wsOpen) {
      // Estado null → los demás nos ven salir antes de que cierre el socket.
      awarenessProtocol.removeAwarenessStates(
        this.awareness,
        [this.doc.clientID],
        'disconnect',
      );
    }
    const ws = this.ws;
    this.ws = null;
    this.wsOpen = false;
    this.synced = false;
    ws?.close();
    this.binding?.destroy();
    this.binding = null;
  }

  /** Conectado y sincronizado. */
  get connected(): boolean {
    return this.wsOpen && this.synced;
  }

  /** Conectados al room según awareness (incluye a uno mismo). */
  get peers(): PeerInfo[] {
    const peers: PeerInfo[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const user = state['user'] as CollabUser | undefined;
      if (!user) continue;
      const info: PeerInfo = {
        clientId,
        user,
        isSelf: clientId === this.doc.clientID,
      };
      const activity = state['activity'] as PeerActivity | undefined;
      if (activity) info.activity = activity;
      if (state['claude'] === true) info.claudeActive = true;
      peers.push(info);
    }
    return peers.sort((a, b) => a.clientId - b.clientId);
  }

  /** Suscripción a cambios de presencia. Devuelve el unsubscribe. */
  onPeersChanged(cb: (peers: PeerInfo[]) => void): () => void {
    this.peersCallbacks.add(cb);
    return () => this.peersCallbacks.delete(cb);
  }

  /** Publica en awareness qué estamos editando (Playlist, Piano Roll de X…). */
  setActivity(activity: PeerActivity): void {
    this.awareness.setLocalStateField('activity', activity);
  }

  /** Teardown completo (para cerrar el proyecto). */
  destroy(): void {
    this.disconnect();
    this.awareness.destroy();
    this.doc.destroy();
  }

  // ── Socket + protocolo ─────────────────────────────────────────────────────

  private openSocket(): void {
    if (!this.shouldReconnect) return;
    const ws = new WebSocket(`${this.url}/${this.room}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.wsOpen = true;
      this.backoffMs = BACKOFF_START_MS;
      // El cliente inicia el sync: paso 1.
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.send(encoding.toUint8Array(encoder));
      // Y publica su presencia.
      if (this.awareness.getLocalState() !== null) {
        const aEncoder = encoding.createEncoder();
        encoding.writeVarUint(aEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          aEncoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
        );
        this.send(encoding.toUint8Array(aEncoder));
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handleMessage(new Uint8Array(event.data as ArrayBuffer));
    };

    ws.onclose = () => this.handleClose(ws);
    ws.onerror = () => {
      // El onclose correspondiente programa la reconexión.
    };
  }

  private handleMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const syncType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
        // Si readSyncMessage escribió respuesta (step2 tras un step1), se envía.
        if (encoding.length(encoder) > 1) {
          this.send(encoding.toUint8Array(encoder));
        }
        if (syncType === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true;
          this.onSynced();
        }
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
        break;
      }
      default:
        break; // tipos desconocidos: se ignoran
    }
  }

  /** Primera sincronización de esta conexión. */
  private onSynced(): void {
    if (!this.binding) {
      // Con el doc del room ya en local, el binding decide: doc vacío →
      // publicar nuestro proyecto (crear); doc con snapshot → unirse.
      this.binding = new CommandLogBinding(this.store, this.doc, this.user, {
        compactThreshold: this.compactThreshold,
        isHost: () => this.isHost(),
      });
      this.binding.start();
    }
    if (this.firstSync) {
      this.firstSync.resolve();
      this.firstSync = null;
    }
  }

  private handleClose(ws: WebSocket): void {
    if (this.ws !== ws) return; // socket viejo (ya reemplazado)
    this.ws = null;
    this.wsOpen = false;
    this.synced = false;
    // Los remotos quedan offline hasta re-sincronizar.
    const remoteIds = [...this.awareness.getStates().keys()].filter(
      (id) => id !== this.doc.clientID,
    );
    if (remoteIds.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, remoteIds, this);
    }
    if (!this.shouldReconnect) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private send(message: Uint8Array): void {
    if (this.ws && this.wsOpen && this.ws.readyState === WebSocket.OPEN) {
      // lib0 tipa sus buffers como ArrayBufferLike; aquí siempre son ArrayBuffer.
      this.ws.send(message as Uint8Array<ArrayBuffer>);
    }
  }

  /** Host = clientID más bajo con presencia (compacta el log). */
  private isHost(): boolean {
    let min = this.doc.clientID;
    for (const id of this.awareness.getStates().keys()) {
      if (id < min) min = id;
    }
    return min === this.doc.clientID;
  }

  // ── Handlers Yjs/awareness ─────────────────────────────────────────────────

  /** Update local del doc → a la red (los de la red no se devuelven: eco). */
  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.send(encoding.toUint8Array(encoder));
  };

  /** Cambios de awareness propios → a la red. */
  private handleAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return; // aplicado por nosotros desde la red
    const changed = changes.added.concat(changes.updated, changes.removed);
    if (changed.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    );
    this.send(encoding.toUint8Array(encoder));
  };

  /** Presencia cambió de verdad → notifica a la UI. */
  private handleAwarenessChange = (): void => {
    const peers = this.peers;
    for (const cb of this.peersCallbacks) cb(peers);
  };
}
