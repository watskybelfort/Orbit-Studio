// Colaboración en tiempo real: panel + sesión singleton cableada al store.
export { CollabPanel } from './CollabPanel';
export { FollowBanner } from './FollowBanner';
export {
  DEFAULT_SERVER_URL,
  DEFAULT_USER_NAME,
  createRoom,
  followedPeer,
  getCollabSession,
  joinRoom,
  leaveRoom,
  loadCollabSettings,
  removeChat,
  roleLabel,
  saveCollabSettings,
  sendChat,
  setCollabRole,
  useCollabStore,
} from './collab-state';
export type { CollabPhase, CollabSettings, CollabState } from './collab-state';
export { EDITOR_LABELS, followPeer, initFollow, isFollowing, unfollow } from './follow';
export { initPresence, reportActivity, reportClaudeActive } from './presence';
export type { ChatMessage, CollabRole, PeerActivity, PeerInfo, PeerView } from '@orbit/collab';
