// @orbit/collab — colaboración en tiempo real: log de comandos sobre Yjs,
// sesión WebSocket (protocolo y-websocket a mano), presencia por awareness,
// permisos por rol y chat de sala con notas ancladas al timeline.
export const COLLAB_VERSION = '0.1.0';

export { CollabSession } from './session';
export type { CollabSessionOptions, PeerActivity, PeerInfo, PeerView } from './session';

export { CommandLogBinding, DEFAULT_COMPACT_THRESHOLD } from './command-log';
export type { CollabUser, CommandLogOptions, DeniedInfo, LogEntry } from './command-log';

export {
  COLLAB_ROLES,
  DEFAULT_ROLE,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  canEdit,
  checkRole,
  isCollabRole,
  touchesMaster,
  trackDeletionTargets,
} from './roles';
export type { CollabRole, RoleContext, RoleVerdict } from './roles';

export { ChatBinding, MAX_CHAT_MESSAGES } from './chat';
export type { ChatMessage, ChatOptions } from './chat';

export {
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from './room-code';
