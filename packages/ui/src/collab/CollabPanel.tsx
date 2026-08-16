/**
 * Panel de colaboración en tiempo real: crear/unirse a salas, código grande
 * para compartir, presencia (quién está y qué edita) y salida limpia.
 * La sesión vive en collab-state.ts (singleton); aquí solo se pinta y se
 * disparan createRoom/joinRoom/leaveRoom.
 */

import { useEffect, useState } from 'react';
import { formatRoomCode } from '@orbit/collab';
import {
  DEFAULT_SERVER_URL,
  DEFAULT_USER_NAME,
  createRoom,
  joinRoom,
  leaveRoom,
  loadCollabSettings,
  saveCollabSettings,
  useCollabStore,
} from './collab-state';
import './collab.css';

export function CollabPanel() {
  const phase = useCollabStore((s) => s.phase);
  const roomCode = useCollabStore((s) => s.roomCode);
  const peers = useCollabStore((s) => s.peers);
  const error = useCollabStore((s) => s.error);

  const [userName, setUserName] = useState(DEFAULT_USER_NAME);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);

  // Nombre y URL persistidos en settings.json (window.orbit.settings).
  useEffect(() => {
    void loadCollabSettings().then((s) => {
      setUserName(s.userName);
      setServerUrl(s.serverUrl);
    });
  }, []);

  const persistFields = () => saveCollabSettings({ userName, serverUrl });

  const handleCreate = () => {
    persistFields();
    void createRoom(serverUrl, userName);
  };

  const handleJoin = (code: string) => {
    persistFields();
    void joinRoom(code, serverUrl, userName);
  };

  const copyCode = () => {
    if (!roomCode) return;
    void navigator.clipboard
      .writeText(formatRoomCode(roomCode))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Sin portapapeles: el código grande queda seleccionable a mano.
      });
  };

  // ── En sala (o entrando): código grande, presencia y salida ────────────────
  if (phase === 'online' || phase === 'connecting') {
    return (
      <div className="collab">
        <h3 className="collab-heading">Sala de colaboración</h3>

        <div className="collab-code-wrap">
          <span className="collab-code-big">{roomCode ? formatRoomCode(roomCode) : ''}</span>
          <button className="collab-btn" onClick={copyCode} disabled={!roomCode}>
            {copied ? '¡Copiado!' : 'Copiar'}
          </button>
        </div>
        <p className="collab-note">Comparte este código para que otros se unan a la sala.</p>

        <div className="collab-status">
          <span className={`collab-dot ${phase === 'online' ? 'online' : 'connecting'}`} />
          {phase === 'online'
            ? `En línea — ${peers.length} conectado${peers.length === 1 ? '' : 's'}`
            : 'Conectando…'}
        </div>

        {phase === 'online' && peers.length > 0 && (
          <ul className="collab-peers">
            {peers.map((p) => (
              <li key={p.clientId}>
                <div className="collab-peer">
                  <span className="collab-peer-dot" style={{ background: p.user.color }} />
                  <span className="collab-peer-name">
                    {p.user.name}
                    {p.isSelf ? ' (tú)' : ''}
                  </span>
                  {p.activity && (
                    <span className="collab-peer-activity">
                      · {p.activity.editor}
                      {p.activity.detail ? ` — ${p.activity.detail}` : ''}
                    </span>
                  )}
                </div>
                {p.claudeActive && (
                  <div className="collab-peer collab-claude">
                    <span className="collab-peer-dot claude-dot" />
                    <span className="collab-peer-name">Claude</span>
                    <span className="collab-peer-activity">
                      · trabajando {p.isSelf ? 'contigo' : `con ${p.user.name}`}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="collab-warn">Todos en la sala editan el MISMO proyecto en vivo.</p>

        <div>
          <button className="collab-btn danger" onClick={leaveRoom}>
            {phase === 'connecting' ? 'Cancelar' : 'Salir de la sala'}
          </button>
        </div>
      </div>
    );
  }

  // ── Fuera de sala ('off' | 'error'): formulario para crear o unirse ────────
  return (
    <div className="collab">
      <h3 className="collab-heading">Colaboración en tiempo real</h3>
      <p className="collab-warn">Todos en la sala editan el MISMO proyecto en vivo.</p>

      <div className="collab-row">
        <span className="collab-label">Tu nombre</span>
        <input
          className="collab-input"
          value={userName}
          placeholder={DEFAULT_USER_NAME}
          onChange={(e) => setUserName(e.target.value)}
          onBlur={persistFields}
        />
      </div>

      <div className="collab-row">
        <span className="collab-label">Servidor</span>
        <input
          className="collab-input"
          value={serverUrl}
          placeholder={DEFAULT_SERVER_URL}
          spellCheck={false}
          onChange={(e) => setServerUrl(e.target.value)}
          onBlur={persistFields}
        />
      </div>
      <p className="collab-note">
        El servidor local se arranca con <code>npm run server</code> y escucha en{' '}
        {DEFAULT_SERVER_URL}.
      </p>

      {phase === 'error' && error && (
        <div className="collab-error-box">
          <p className="collab-error">{error}</p>
          {roomCode && (
            <button className="collab-btn" onClick={() => handleJoin(roomCode)}>
              Reintentar con {formatRoomCode(roomCode)}
            </button>
          )}
        </div>
      )}

      <div>
        <button className="collab-btn primary" onClick={handleCreate}>
          Crear sala
        </button>
      </div>

      <div className="collab-divider">o únete a una sala existente</div>

      <div className="collab-row">
        <input
          className="collab-input collab-code-input"
          value={joinCode}
          placeholder="K3P-9QF"
          maxLength={8}
          spellCheck={false}
          onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && joinCode.trim() !== '') handleJoin(joinCode);
          }}
        />
        <button
          className="collab-btn"
          onClick={() => handleJoin(joinCode)}
          disabled={joinCode.trim() === ''}
        >
          Unirse
        </button>
      </div>
      <p className="collab-note">
        Al unirte a una sala ya creada, el proyecto de la sala sustituye al tuyo (se carga su
        snapshot y su historial de cambios). Si la sala está vacía, se publica tu proyecto como
        base.
      </p>
    </div>
  );
}
