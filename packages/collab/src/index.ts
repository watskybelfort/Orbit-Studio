// @orbit/collab — colaboración en tiempo real: log de comandos sobre Yjs,
// sesión WebSocket (protocolo y-websocket a mano), presencia por awareness,
// permisos por rol, chat de sala con notas ancladas al timeline y los BYTES de
// los samples viajando por la sala (indexados por hash).
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

export {
  MESSAGE_CONTROL,
  encodeControl,
  parseControl,
  readControlBody,
  type ControlMessage,
} from './control';

export { adpcmBytes, decodeAdpcm, encodeAdpcm } from './adpcm';

export {
  AUDIO_MAX_SAMPLES,
  MESSAGE_AUDIO,
  StreamClock,
  encodeAudioChunk,
  fromInt16,
  readAudioChunkBody,
  toMonoInt16,
  type AudioChunk,
  type AudioCodec,
  type ChunkPlan,
} from './audio-stream';

export { USER_COLORS, colorForName, pickDistinctColor } from './colors';

export { ChatBinding, MAX_CHAT_MESSAGES } from './chat';
export type { ChatMessage, ChatOptions } from './chat';

export { MAX_ASSET_BYTES, MAX_ROOM_ASSET_BYTES, SampleAssetBinding } from './assets';
export type {
  AssetRejection,
  PublishResult,
  RejectReason,
  SampleAsset,
  SampleAssetOptions,
} from './assets';

export {
  formatRoomCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from './room-code';
