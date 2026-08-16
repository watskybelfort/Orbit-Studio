// Colaboración en tiempo real: panel + sesión singleton cableada al store.
export { CollabPanel } from './CollabPanel';
export {
  DEFAULT_SERVER_URL,
  DEFAULT_USER_NAME,
  createRoom,
  getCollabSession,
  joinRoom,
  leaveRoom,
  loadCollabSettings,
  saveCollabSettings,
  useCollabStore,
} from './collab-state';
export type { CollabPhase, CollabSettings, CollabState } from './collab-state';
export type { PeerActivity, PeerInfo } from '@orbit/collab';
