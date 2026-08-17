/**
 * Panel de colaboración en tiempo real: crear/unirse a salas, código grande
 * para compartir, rol con el que entras, presencia (quién está, qué edita y
 * botón para seguirle), congelar tu audio mientras el otro trastea, chat de
 * sala con notas ancladas al timeline y salida limpia. La sesión vive en
 * collab-state.ts (singleton); aquí solo se pinta y se disparan
 * createRoom/joinRoom/leaveRoom.
 */

import { useEffect, useRef, useState } from 'react';
import { COLLAB_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, formatRoomCode } from '@orbit/collab';
import { engine, store } from '../state/app';
import { useUiStore } from '../state/ui';
import {
  DEFAULT_SERVER_URL,
  DEFAULT_USER_NAME,
  createRoom,
  joinRoom,
  leaveRoom,
  loadCollabSettings,
  removeChat,
  saveCollabSettings,
  sendChat,
  setCollabRole,
  toggleAudioFrozen,
  useCollabStore,
} from './collab-state';
import { EDITOR_LABELS, followPeer, unfollow } from './follow';
import './collab.css';

/** Compás humano (1-based) de un beat absoluto. */
function beatToBar(beat: number, beatsPerBar: number): number {
  return Math.floor(beat / beatsPerBar) + 1;
}

/** Primer beat de un compás humano. */
function barToBeat(bar: number, beatsPerBar: number): number {
  return Math.max(0, (bar - 1) * beatsPerBar);
}

/** Salta el caret a un beat y saca la playlist al frente. */
function goToBeat(beat: number): void {
  engine.seek(beat);
  useUiStore.setState({ positionBeats: beat });
  useUiStore.getState().openWindow('playlist');
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

export function CollabPanel() {
  const phase = useCollabStore((s) => s.phase);
  const roomCode = useCollabStore((s) => s.roomCode);
  const peers = useCollabStore((s) => s.peers);
  const error = useCollabStore((s) => s.error);
  const role = useCollabStore((s) => s.role);
  const following = useCollabStore((s) => s.following);
  const audioFrozen = useCollabStore((s) => s.audioFrozen);
  const frozenPending = useCollabStore((s) => s.frozenPending);
  const missingSamples = useCollabStore((s) => s.missingSamples);
  const assetWarning = useCollabStore((s) => s.assetWarning);
  const chat = useCollabStore((s) => s.chat);
  const denied = useCollabStore((s) => s.denied);

  const [userName, setUserName] = useState(DEFAULT_USER_NAME);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState(false);
  const [barDraft, setBarDraft] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);

  const beatsPerBar = store.project.timeSig.num;

  // Nombre, URL y rol persistidos en settings.json (window.orbit.settings).
  useEffect(() => {
    void loadCollabSettings().then((s) => {
      setUserName(s.userName);
      setServerUrl(s.serverUrl);
    });
  }, []);

  // Auto-scroll del chat cuando entra un mensaje nuevo.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

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

  /** Manda el mensaje del borrador, anclado al compás si toca. */
  const submitChat = () => {
    if (draft.trim() === '') return;
    let beat: number | undefined;
    if (pinned) {
      const bar = Number(barDraft);
      beat = Number.isFinite(bar) && bar > 0
        ? barToBeat(bar, beatsPerBar)
        : useUiStore.getState().positionBeats;
    }
    if (sendChat(draft, beat)) {
      setDraft('');
      setBarDraft('');
    }
  };

  const notes = chat.filter((m) => typeof m.beat === 'number');

  // ── En sala (o entrando): código, presencia, chat y salida ─────────────────
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
          <span className="collab-role-chip">{ROLE_LABELS[role]}</span>
        </div>

        {denied && <p className="collab-error">{denied}</p>}

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
                  <span className="collab-role-chip">{ROLE_LABELS[p.role]}</span>
                  {p.activity && (
                    <span className="collab-peer-activity">
                      · {p.activity.editor}
                      {p.activity.detail ? ` — ${p.activity.detail}` : ''}
                    </span>
                  )}
                  {!p.isSelf && (
                    <button
                      className={`collab-btn small${following === p.clientId ? ' primary' : ''}`}
                      onClick={() =>
                        following === p.clientId ? unfollow() : followPeer(p.clientId)
                      }
                      title={
                        following === p.clientId
                          ? 'Tu vista vuelve a ser tuya'
                          : 'Tu vista pasa a seguir la suya'
                      }
                    >
                      {following === p.clientId ? 'Dejar de seguir' : 'Seguir'}
                    </button>
                  )}
                </div>
                {!p.isSelf && p.view && (
                  <div className="collab-peer collab-peer-view">
                    <span className="collab-peer-activity">
                      ↳ mirando {EDITOR_LABELS[p.view.editor] ?? p.view.editor}
                      {p.view.playhead !== undefined
                        ? ` · compás ${beatToBar(p.view.playhead, beatsPerBar)}`
                        : ''}
                    </span>
                  </div>
                )}
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

        {/* ── Lo que oyes TÚ (el otro no reproduce nada en tu máquina) ── */}
        <h3 className="collab-heading">Lo que oyes tú</h3>

        <div>
          <button
            className={`collab-btn small${audioFrozen ? ' primary' : ''}`}
            onClick={toggleAudioFrozen}
            title={
              audioFrozen
                ? 'Recupera de golpe todo lo que ha cambiado mientras estaba congelado'
                : 'Tu motor deja de recoger cambios: sigues oyendo el proyecto tal y como suena ahora'
            }
          >
            {audioFrozen ? 'Volver a oír los cambios' : 'Silenciar lo que toca el otro'}
          </button>
        </div>
        <p className="collab-note">
          Congela <strong>tu</strong> audio, no el suyo. Nadie reproduce nada en tu máquina: lo
          que oyes es tu propio motor tocando el proyecto compartido. Mientras esté activo sus
          cambios siguen llegando y la pantalla se actualiza igual, pero el sonido se queda como
          está — también el de lo que toques tú. Al desactivarlo se pone al día al instante.
        </p>
        {audioFrozen && (
          <p className="collab-warn">
            Motor congelado: oyes el proyecto tal y como estaba al pulsar el botón.
            {frozenPending ? ' Hay cambios esperando a que lo descongeles.' : ''}
          </p>
        )}

        {missingSamples.length > 0 && (
          <p className="collab-error">
            {missingSamples.length === 1
              ? '1 sonido de la sala todavía no está disponible aquí'
              : `${missingSamples.length} sonidos de la sala todavía no están disponibles aquí`}{' '}
            ({missingSamples.slice(0, 3).join(', ')}
            {missingSamples.length > 3 ? '…' : ''}): esos canales suenan mudos hasta que llegue
            su contenido.
          </p>
        )}
        {assetWarning && <p className="collab-error">{assetWarning}</p>}

        {/* ── Chat de sala ── */}
        <h3 className="collab-heading">Chat de la sesión</h3>

        {notes.length > 0 && (
          <div className="collab-notes">
            <span className="collab-note">Notas ancladas al timeline:</span>
            <ul className="collab-notes-list">
              {[...notes]
                .sort((a, b) => (a.beat ?? 0) - (b.beat ?? 0))
                .map((m) => (
                  <li key={m.id} className="collab-note-item">
                    <button
                      className="collab-chip"
                      onClick={() => goToBeat(m.beat ?? 0)}
                      title="Saltar ahí en la playlist"
                    >
                      compás {beatToBar(m.beat ?? 0, beatsPerBar)}
                    </button>
                    <span className="collab-note-text">{m.text}</span>
                    <button
                      className="collab-note-del"
                      onClick={() => removeChat(m.id)}
                      title="Quitar la nota"
                    >
                      ✕
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        )}

        <div className="collab-chat" ref={feedRef}>
          {chat.length === 0 ? (
            <p className="collab-note">
              Todavía no ha hablado nadie. Ancla un mensaje a un compás para dejar un recado
              justo donde hace falta.
            </p>
          ) : (
            chat.map((m) => (
              <div key={m.id} className="collab-msg">
                <span className="collab-peer-dot" style={{ background: m.color }} />
                <span className="collab-msg-user">{m.user}</span>
                {m.beat !== undefined && (
                  <button className="collab-chip" onClick={() => goToBeat(m.beat ?? 0)}>
                    compás {beatToBar(m.beat, beatsPerBar)}
                  </button>
                )}
                <span className="collab-msg-text">{m.text}</span>
                <span className="collab-msg-time">{formatTime(m.at)}</span>
              </div>
            ))
          )}
        </div>

        <div className="collab-row">
          <input
            className="collab-input"
            placeholder="Escribe a la sala…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitChat();
            }}
          />
          <button className="collab-btn primary" onClick={submitChat} disabled={draft.trim() === ''}>
            Enviar
          </button>
        </div>
        <div className="collab-row">
          <label className="collab-check">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => {
                setPinned(e.target.checked);
                if (e.target.checked && barDraft === '') {
                  setBarDraft(
                    String(beatToBar(useUiStore.getState().positionBeats, beatsPerBar)),
                  );
                }
              }}
            />
            Anclar al compás
          </label>
          <input
            className="collab-input collab-bar-input"
            value={barDraft}
            placeholder="33"
            disabled={!pinned}
            inputMode="numeric"
            onChange={(e) => setBarDraft(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>

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
        <span className="collab-label">Entras como</span>
        <select
          className="collab-input"
          value={role}
          onChange={(e) => setCollabRole(e.target.value as (typeof COLLAB_ROLES)[number])}
        >
          {COLLAB_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <p className="collab-note">{ROLE_DESCRIPTIONS[role]}</p>

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
