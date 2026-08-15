// @orbit/collab — colaboración en tiempo real: log de comandos sobre Yjs,
// sesión WebSocket (protocolo y-websocket a mano) y presencia por awareness.
export const COLLAB_VERSION = '0.1.0';

export { CollabSession } from './session';
export type { CollabSessionOptions, PeerActivity, PeerInfo } from './session';

export { CommandLogBinding, DEFAULT_COMPACT_THRESHOLD } from './command-log';
export type { CollabUser, CommandLogOptions, LogEntry } from './command-log';

export {
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from './room-code';
