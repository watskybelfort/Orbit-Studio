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
 * proyecto la lleva CommandLogBinding (log de comandos sobre el Y.Doc) y el
 * CONTENIDO de los samples, SampleAssetBinding (mapa de blobs por hash en el
 * mismo doc): sin eso el otro recibe referencias a sonidos que su kernel no
 * tiene y le suenan mudas.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { ProjectStore } from '@orbit/core';
import { CommandLogBinding, type CollabUser, type DeniedInfo } from './command-log';
import { ChatBinding, type ChatMessage } from './chat';
import {
  SampleAssetBinding,
  type AssetRejection,
  type PublishResult,
  type SampleAsset,
} from './assets';
import { DEFAULT_ROLE, isCollabRole, type CollabRole } from './roles';
import { normalizeRoomCode } from './room-code';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 15000;

// Cierres del servidor que significan "no entras": 1008 = código de sala
// inválido, 1013 = sala (o servidor) llena. Reintentar no los arregla.
const CLOSE_POLICY = 1008;
const CLOSE_TRY_LATER = 1013;

/** Qué está haciendo un usuario ("Piano Roll de Orbit Sub"…). */
export interface PeerActivity {
  editor: string;
  detail?: string;
  /** Posición del cursor en beats (para pintarlo en playlist/piano roll). */
  beat?: number;
  /** Altura bajo el cursor en el piano roll (nota MIDI). */
  key?: number;
}

/**
 * Vista LÓGICA de un peer: qué tiene delante y por dónde va. Es lo que copia
 * el modo seguidor (a diferencia de `PeerActivity`, que es el cursor físico).
 */
export interface PeerView {
  /** Editor con el foco: 'playlist' | 'pianoRoll' | 'mixer' | 'channelRack'… */
  editor: string;
  /** Patrón activo. */
  patternId?: string;
  /** Canal cuyo piano roll está abierto. */
  channelId?: string;
  /** Pista de mixer seleccionada (el canal abierto en el mixer). */
  mixerTrack?: number;
  /** Posición en la playlist, en beats. */
  playhead?: number;
}

/** Un conectado al room (según awareness), incluido uno mismo. */
export interface PeerInfo {
  clientId: number;
  user: CollabUser;
  activity?: PeerActivity;
  /** Vista lógica publicada por ese peer (para seguirle). */
  view?: PeerView;
  /** Rol declarado en la sala (productor si no declara nada). */
  role: CollabRole;
  /** Este usuario tiene a Claude conectado trabajando en la sesión. */
  claudeActive?: boolean;
  isSelf: boolean;
}

export interface CollabSessionOptions {
  user: CollabUser;
  /** Umbral de compactación del log (por defecto 2000 entradas). */
  compactThreshold?: number;
  /** Rol con el que entramos a la sala (por defecto productor). */
  role?: CollabRole;
  /**
   * El servidor cierra la puerta y no vale reintentar: sala llena, servidor
   * lleno o código de sala inválido. Llega con el motivo que mande el server.
   */
  onRejected?: (reason: string) => void;
  /** Aviso de comando rechazado por permisos (propio o de un remoto). */
  onDenied?: (info: DeniedInfo) => void;
  /**
   * El proyecto se sustituyó entero (unirse a la sala, o re-derivar tras un
   * merge cruzado). Es el momento de rehidratar los samples: el modelo queda
   * lleno de referencias y el kernel local, vacío.
   */
  onProjectReplaced?: () => void;
  /** Llegó a la sala el contenido de un sample que aún no teníamos. */
  onAsset?: (asset: SampleAsset) => void;
  /** Un sample no cupo en la sala (demasiado grande o sala llena). */
  onAssetRejected?: (info: AssetRejection) => void;
  /** Tope por sample de lo que viaja por la sala (bytes). */
  maxAssetBytes?: number;
  /** Tope acumulado de samples de la sala (bytes). */
  maxRoomAssetBytes?: number;
}

export class CollabSession {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;

  private readonly store: ProjectStore;
  private readonly user: CollabUser;
  private readonly compactThreshold: number | undefined;
  private readonly onDenied: ((info: DeniedInfo) => void) | undefined;
  private readonly onRejected: ((reason: string) => void) | undefined;
  private readonly onProjectReplaced: (() => void) | undefined;
  private currentRole: CollabRole;

  private readonly chatBinding: ChatBinding;
  private readonly assetBinding: SampleAssetBinding;
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
    this.currentRole = opts.role ?? DEFAULT_ROLE;
    this.onDenied = opts.onDenied;
    this.onRejected = opts.onRejected;
    this.onProjectReplaced = opts.onProjectReplaced;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField('user', opts.user);
    this.awareness.setLocalStateField('role', this.currentRole);
    this.awareness.on('update', this.handleAwarenessUpdate);
    this.awareness.on('change', this.handleAwarenessChange);
    this.doc.on('update', this.handleDocUpdate);
    // El chat vive en el doc desde el minuto uno: no necesita esperar al
    // binding del proyecto (y así lo que escribas antes de sincronizar viaja
    // igualmente cuando llegue la sala).
    this.chatBinding = new ChatBinding(this.doc, opts.user, { isHost: () => this.isHost() });
    // Los samples también viven en el doc desde el minuto uno: lo que subas
    // antes de sincronizar viaja igual cuando llegue la sala, y lo que la sala
    // ya tenía se anuncia en cuanto entra por el primer sync.
    this.assetBinding = new SampleAssetBinding(this.doc, {
      ...(opts.maxAssetBytes !== undefined ? { maxAssetBytes: opts.maxAssetBytes } : null),
      ...(opts.maxRoomAssetBytes !== undefined ? { maxRoomBytes: opts.maxRoomAssetBytes } : null),
      ...(opts.onAsset ? { onAsset: opts.onAsset } : null),
      ...(opts.onAssetRejected ? { onRejected: opts.onAssetRejected } : null),
    });
    this.assetBinding.start();
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
      this.awareness.setLocalStateField('role', this.currentRole);
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
      const rawRole = state['role'];
      const info: PeerInfo = {
        clientId,
        user,
        role: isCollabRole(rawRole) ? rawRole : DEFAULT_ROLE,
        isSelf: clientId === this.doc.clientID,
      };
      const activity = state['activity'] as PeerActivity | undefined;
      if (activity) info.activity = activity;
      const view = state['view'] as PeerView | undefined;
      if (view) info.view = view;
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

  /**
   * Publica nuestra vista lógica (editor delante, patrón, canal, playhead)
   * para que quien nos siga pueda replicarla.
   */
  setView(view: PeerView): void {
    this.awareness.setLocalStateField('view', view);
  }

  // ── Rol ────────────────────────────────────────────────────────────────────

  /** Rol propio en la sala. */
  get role(): CollabRole {
    return this.currentRole;
  }

  /** Cambia el rol propio en caliente (se publica y filtra desde ya). */
  setRole(role: CollabRole): void {
    this.currentRole = role;
    this.awareness.setLocalStateField('role', role);
  }

  /**
   * Cambia el color con el que te ven los demás. Muta el MISMO objeto de
   * usuario que comparten el chat y el log de comandos (así un mensaje escrito
   * después sale ya con el color nuevo) y lo republica por awareness con un
   * objeto nuevo, que es lo que compara awareness para ver que algo cambió.
   */
  setUserColor(color: string): void {
    if (this.user.color === color) return;
    this.user.color = color;
    this.awareness.setLocalStateField('user', { ...this.user });
  }

  // ── Chat de sala ───────────────────────────────────────────────────────────

  /** Conversación completa de la sala (vive en el doc Yjs). */
  get chat(): ChatMessage[] {
    return this.chatBinding.messages;
  }

  /** Notas ancladas al timeline, ordenadas por beat. */
  get pinnedNotes(): ChatMessage[] {
    return this.chatBinding.pinned;
  }

  /** Manda un mensaje; con `beat` queda anclado a esa posición del timeline. */
  sendChat(text: string, opts: { beat?: number } = {}): ChatMessage | null {
    return this.chatBinding.send(text, opts);
  }

  /** Borra un mensaje/nota anclada por id. */
  removeChat(id: string): boolean {
    return this.chatBinding.remove(id);
  }

  /** Suscripción al chat. Devuelve el unsubscribe. */
  onChatChanged(cb: (messages: ChatMessage[]) => void): () => void {
    return this.chatBinding.onChanged(cb);
  }

  // ── Samples de la sala ─────────────────────────────────────────────────────

  /** ¿Está el CONTENIDO de este sample publicado en la sala? */
  hasSample(hash: string): boolean {
    return this.assetBinding.has(hash);
  }

  /** Bytes del sample publicado bajo ese hash, o null si la sala no los tiene. */
  getSample(hash: string): Uint8Array | null {
    return this.assetBinding.get(hash);
  }

  /**
   * Sube el contenido de un sample para que suene en las demás máquinas.
   * Idempotente por hash: republicar lo que ya está devuelve 'duplicate' sin
   * mandar un solo byte.
   */
  publishSample(bytes: Uint8Array, meta: { hash: string; name: string }): PublishResult {
    return this.assetBinding.publish(bytes, { ...meta, by: this.user.name });
  }

  /** Hashes con contenido disponible en la sala. */
  get sampleHashes(): string[] {
    return this.assetBinding.hashes;
  }

  /** Bytes que ocupan los samples publicados en la sala. */
  get sampleBytes(): number {
    return this.assetBinding.totalBytes;
  }

  /** Suscripción a "cambió el almacén de samples". Devuelve el unsubscribe. */
  onSamplesChanged(cb: () => void): () => void {
    return this.assetBinding.onChanged(cb);
  }

  /** Teardown completo (para cerrar el proyecto). */
  destroy(): void {
    this.disconnect();
    this.chatBinding.destroy();
    this.assetBinding.destroy();
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

    ws.onclose = (event: CloseEvent) => this.handleClose(ws, event.code, event.reason);
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
        getRole: () => this.currentRole,
        ...(this.onDenied ? { onDenied: this.onDenied } : null),
        ...(this.onProjectReplaced ? { onProjectReplaced: this.onProjectReplaced } : null),
      });
      this.binding.start();
    }
    if (this.firstSync) {
      this.firstSync.resolve();
      this.firstSync = null;
    }
  }

  private handleClose(ws: WebSocket, code = 0, reason = ''): void {
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
    // Cierres que NO se arreglan reintentando: el servidor nos ha dicho que no
    // entramos — código de sala inválido (1008) o sala/servidor llenos (1013).
    // Sin esto se reintentaba contra una puerta cerrada y el panel se quedaba
    // en "Conectando…" hasta el timeout, con un mensaje genérico que no decía
    // lo único que importaba: que la sala está llena.
    if (code === CLOSE_POLICY || code === CLOSE_TRY_LATER) {
      this.shouldReconnect = false;
      const message = reason.trim() !== '' ? reason.trim() : 'El servidor rechazó la conexión';
      if (this.firstSync) {
        this.firstSync.reject(new Error(message));
        this.firstSync = null;
      } else {
        this.onRejected?.(message);
      }
      return;
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
