/**
 * Estado de colaboración de la UI: UNA CollabSession singleton cableada al
 * ProjectStore central (state/app.ts) + un store zustand con lo que el panel
 * necesita pintar (fase, código de sala, conectados, error).
 *
 * Toda la réplica (snapshot + log de comandos, unirse/crear) vive en
 * @orbit/collab; aquí solo se orquesta el ciclo de vida de la sesión.
 */

import { create } from 'zustand';
import {
  CollabSession,
  DEFAULT_ROLE,
  ROLE_LABELS,
  generateRoomCode,
  isCollabRole,
  isValidRoomCode,
  normalizeRoomCode,
  type ChatMessage,
  type CollabRole,
  type PeerInfo,
} from '@orbit/collab';
import { store } from '../state/app';

// ── Constantes ───────────────────────────────────────────────────────────────

/** URL por defecto del servidor de rooms (apps/server, `npm run server`). */
export const DEFAULT_SERVER_URL = 'ws://localhost:7900';

/** Nombre visible por defecto. */
export const DEFAULT_USER_NAME = 'Productor';

/** Claves persistidas en settings.json (window.orbit.settings). */
const SETTINGS_KEY_NAME = 'collabUserName';
const SETTINGS_KEY_URL = 'collabServerUrl';
const SETTINGS_KEY_ROLE = 'collabRole';

/** Cuánto se queda en pantalla el aviso de "tu rol no te deja hacer eso". */
const DENIED_NOTICE_MS = 6000;

/**
 * CollabSession.connect() reintenta solo con backoff y no rechaza si el
 * servidor no está: este timeout convierte ese silencio en un error legible.
 */
const CONNECT_TIMEOUT_MS = 10000;

/** Latido para reflejar caídas/reconexiones del socket en la fase. */
const STATUS_POLL_MS = 1500;

/**
 * Identidad de color del colaborador (viaja por awareness para que los demás
 * te distingan; es dato de red, no un color de la UI — la UI usa tokens).
 */
const USER_COLORS = [
  '#5aa9e6', '#e6675a', '#7ce65a', '#e6c95a',
  '#b45ae6', '#5ae6c9', '#e65aa9', '#e6935a',
];

/** Color estable por nombre (mismo nombre → mismo color en todos lados). */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length]!;
}

// ── Store zustand ────────────────────────────────────────────────────────────

export type CollabPhase = 'off' | 'connecting' | 'online' | 'error';

export interface CollabState {
  phase: CollabPhase;
  /** Código normalizado de la sala actual (o del último intento fallido). */
  roomCode: string | null;
  /** Conectados según awareness (incluye a uno mismo). */
  peers: PeerInfo[];
  /** Mensaje legible cuando phase === 'error'. */
  error: string | null;
  /** Rol con el que entramos a la sala (se publica por awareness). */
  role: CollabRole;
  /** clientId del peer al que estamos siguiendo (modo seguidor), o null. */
  following: number | null;
  /** Chat de la sala (vive en el doc Yjs de la sesión). */
  chat: ChatMessage[];
  /** Último comando rechazado por permisos, para avisar en pantalla. */
  denied: string | null;
}

export const useCollabStore = create<CollabState>(() => ({
  phase: 'off',
  roomCode: null,
  peers: [],
  error: null,
  role: DEFAULT_ROLE,
  following: null,
  chat: [],
  denied: null,
}));

/** El peer al que seguimos ahora mismo, si sigue conectado. */
export function followedPeer(): PeerInfo | null {
  const { following, peers } = useCollabStore.getState();
  if (following === null) return null;
  return peers.find((p) => p.clientId === following) ?? null;
}

// ── Sesión singleton ─────────────────────────────────────────────────────────

let session: CollabSession | null = null;
let unsubscribePeers: (() => void) | null = null;
let unsubscribeChat: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let deniedTimer: ReturnType<typeof setTimeout> | null = null;

/** La sesión activa (para setActivity() desde editores, etc.) o null. */
export function getCollabSession(): CollabSession | null {
  return session;
}

/** Suelta la sesión y sus suscripciones SIN tocar el store de UI. */
function teardownSession(): void {
  const s = session;
  session = null;
  unsubscribePeers?.();
  unsubscribePeers = null;
  unsubscribeChat?.();
  unsubscribeChat = null;
  if (deniedTimer !== null) {
    clearTimeout(deniedTimer);
    deniedTimer = null;
  }
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // destroy() = disconnect (avisa a los demás, cierra socket, suelta el
  // binding del log) + destruye awareness y el Y.Doc. Teardown real.
  s?.destroy();
}

/** Refleja el socket en la fase: caída → 'connecting', resincronizado → 'online'. */
function refreshPhase(s: CollabSession): void {
  if (session !== s) return;
  const { phase } = useCollabStore.getState();
  if (phase !== 'online' && phase !== 'connecting') return;
  const next: CollabPhase = s.connected ? 'online' : 'connecting';
  if (next !== phase) useCollabStore.setState({ phase: next });
}

/** Enseña en pantalla que un cambio se ha rechazado por permisos. */
function showDenied(message: string): void {
  useCollabStore.setState({ denied: message });
  if (deniedTimer !== null) clearTimeout(deniedTimer);
  deniedTimer = setTimeout(() => {
    deniedTimer = null;
    useCollabStore.setState({ denied: null });
  }, DENIED_NOTICE_MS);
}

/** Arranca una sesión nueva contra `code` (cerrando antes la que hubiera). */
async function startSession(code: string, url: string, userName: string): Promise<void> {
  // Solo UNA sesión a la vez.
  if (session) leaveRoom();

  const trimmedUrl = url.trim().replace(/\/+$/, '');
  if (!/^wss?:\/\//i.test(trimmedUrl)) {
    useCollabStore.setState({
      phase: 'error',
      roomCode: code,
      peers: [],
      error: `La URL del servidor debe empezar por ws:// o wss:// (p. ej. ${DEFAULT_SERVER_URL}).`,
    });
    return;
  }

  const name = userName.trim() || DEFAULT_USER_NAME;
  const role = useCollabStore.getState().role;
  const s = new CollabSession(store, {
    user: { name, color: colorFor(name) },
    role,
    // Rechazar no rompe la sesión: solo se avisa (propio o de un remoto).
    onDenied: (info) => {
      if (session !== s) return;
      showDenied(
        info.local ? info.reason : `Cambio de ${info.user} descartado: ${info.reason}`,
      );
    },
  });
  session = s;
  useCollabStore.setState({
    phase: 'connecting',
    roomCode: code,
    peers: [],
    error: null,
    following: null,
    chat: [],
    denied: null,
  });

  unsubscribePeers = s.onPeersChanged((peers) => {
    if (session !== s) return;
    useCollabStore.setState({ peers });
    // Si el peer al que seguíamos se va, se deja de seguir solo.
    const { following } = useCollabStore.getState();
    if (following !== null && !peers.some((p) => p.clientId === following)) {
      useCollabStore.setState({ following: null });
    }
    refreshPhase(s);
  });
  unsubscribeChat = s.onChatChanged((chat) => {
    if (session !== s) return;
    useCollabStore.setState({ chat });
  });
  pollTimer = setInterval(() => refreshPhase(s), STATUS_POLL_MS);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      s.connect(trimmedUrl, code),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          reject(
            new Error(
              `No se pudo conectar a ${trimmedUrl} en ${CONNECT_TIMEOUT_MS / 1000} s. ` +
                'Comprueba que el servidor esté arrancado (npm run server) y que la URL sea correcta.',
            ),
          );
        }, CONNECT_TIMEOUT_MS);
      }),
    ]);
    if (session !== s) return; // leaveRoom() durante la conexión
    useCollabStore.setState({ phase: 'online', peers: s.peers, chat: s.chat, error: null });
  } catch (err) {
    if (session !== s) return; // teardown externo: leaveRoom() ya dejó el estado
    teardownSession();
    // roomCode se conserva para que el reintento manual sea directo.
    useCollabStore.setState({
      phase: 'error',
      peers: [],
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
  }
}

// ── API pública ──────────────────────────────────────────────────────────────

/**
 * Crea una sala nueva: genera el código, conecta y publica el proyecto local
 * como base del room. Devuelve el código generado.
 */
export async function createRoom(url: string, userName: string): Promise<string> {
  const code = generateRoomCode();
  await startSession(code, url, userName);
  return code;
}

/**
 * Se une a una sala por código ("K3P-9QF" o "k3p9qf"). Si la sala ya tiene
 * proyecto, la sesión de collab sustituye el local por snapshot + log.
 */
export async function joinRoom(codeInput: string, url: string, userName: string): Promise<void> {
  const code = normalizeRoomCode(codeInput);
  if (!isValidRoomCode(code)) {
    if (session) return; // no tumbar una sesión viva por un typo
    useCollabStore.setState({
      phase: 'error',
      roomCode: null,
      peers: [],
      error:
        'Código de sala inválido: son 6 caracteres (letras y números, sin O/0 ni I/1), p. ej. K3P-9QF.',
    });
    return;
  }
  await startSession(code, url, userName);
}

/** Sale de la sala: teardown real de la sesión y estado a 'off'. */
export function leaveRoom(): void {
  teardownSession();
  useCollabStore.setState({
    phase: 'off',
    roomCode: null,
    peers: [],
    error: null,
    following: null,
    chat: [],
    denied: null,
  });
}

// ── Rol ──────────────────────────────────────────────────────────────────────

/**
 * Cambia el rol propio (fuera o dentro de la sala) y lo persiste. Dentro de
 * la sala se publica al momento: el log de comandos filtra desde ya.
 */
export function setCollabRole(role: CollabRole): void {
  useCollabStore.setState({ role });
  session?.setRole(role);
  void window.orbit?.settings.set({ [SETTINGS_KEY_ROLE]: role });
}

// ── Chat de sala ─────────────────────────────────────────────────────────────

/**
 * Manda un mensaje a la sala. Con `beat` queda anclado a esa posición del
 * timeline ("aquí falta un break en el compás 33"). Devuelve false si no hay
 * sesión o el texto está vacío.
 */
export function sendChat(text: string, beat?: number): boolean {
  if (!session) return false;
  return session.sendChat(text, beat !== undefined ? { beat } : {}) !== null;
}

/** Borra un mensaje o nota anclada de la sala. */
export function removeChat(id: string): void {
  session?.removeChat(id);
}

// ── Ajustes persistidos (nombre y URL del servidor) ──────────────────────────

export interface CollabSettings {
  userName: string;
  serverUrl: string;
  role: CollabRole;
}

/** Lee nombre/URL/rol de settings.json (con defaults si faltan o fuera de Electron). */
export async function loadCollabSettings(): Promise<CollabSettings> {
  const settings = (await window.orbit?.settings.get()) ?? {};
  const name = settings[SETTINGS_KEY_NAME];
  const url = settings[SETTINGS_KEY_URL];
  const role = settings[SETTINGS_KEY_ROLE];
  const loaded: CollabSettings = {
    userName: typeof name === 'string' && name.trim() !== '' ? name : DEFAULT_USER_NAME,
    serverUrl: typeof url === 'string' && url.trim() !== '' ? url : DEFAULT_SERVER_URL,
    role: isCollabRole(role) ? role : DEFAULT_ROLE,
  };
  // El rol vive en el store (lo lee startSession al crear la sesión).
  useCollabStore.setState({ role: loaded.role });
  return loaded;
}

/** Etiqueta visible de un rol ("Productor"…). */
export function roleLabel(role: CollabRole): string {
  return ROLE_LABELS[role];
}

/** Persiste nombre y/o URL en settings.json (merge superficial). */
export function saveCollabSettings(patch: Partial<CollabSettings>): void {
  const p: Record<string, unknown> = {};
  if (patch.userName !== undefined) p[SETTINGS_KEY_NAME] = patch.userName;
  if (patch.serverUrl !== undefined) p[SETTINGS_KEY_URL] = patch.serverUrl;
  if (Object.keys(p).length > 0) void window.orbit?.settings.set(p);
}
