/**
 * Aviso de que estás siguiendo a alguien. Se monta como capa propia sobre el
 * body (lo hace initFollow) para que se vea aunque el panel de colaboración
 * esté cerrado: si tu vista salta sola, tienes que saber por qué y poder
 * soltarte de un clic.
 */

import { useCollabStore } from './collab-state';
import { EDITOR_LABELS, unfollow } from './follow';
import './collab.css';

export function FollowBanner() {
  const following = useCollabStore((s) => s.following);
  const peers = useCollabStore((s) => s.peers);
  const denied = useCollabStore((s) => s.denied);

  const peer = following === null ? null : peers.find((p) => p.clientId === following);

  if (!peer && !denied) return null;

  return (
    <div className="collab-overlay">
      {peer && (
        <div className="collab-following">
          <span className="collab-peer-dot" style={{ background: peer.user.color }} />
          <span>
            Siguiendo a <strong>{peer.user.name}</strong>
            {peer.view ? ` en ${EDITOR_LABELS[peer.view.editor] ?? peer.view.editor}` : ''}
          </span>
          <button className="collab-btn small" onClick={unfollow}>
            Dejar de seguir
          </button>
        </div>
      )}
      {denied && <div className="collab-denied">{denied}</div>}
    </div>
  );
}
