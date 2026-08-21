/**
 * Panel de colaboración en tiempo real: crear/unirse a salas, código grande
 * para compartir, rol con el que entras, presencia (quién está, qué edita y
 * botón para seguirle), congelar tu audio mientras el otro trastea, chat de
 * sala con notas ancladas al timeline y salida limpia. La sesión vive en
 * collab-state.ts (singleton); aquí solo se pinta y se disparan
 * createRoom/joinRoom/leaveRoom.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  COLLAB_ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  formatRoomCode,
  type CollabRole,
} from '@orbit/collab';
import { ensureAudioReady, engine, store } from '../state/app';
import {
  listenTo,
  setStreamVolume,
  stopListening,
  toggleBroadcast,
  useMasterStream,
} from './master-stream';
import { useUiStore } from '../state/ui';
import { NetworkSection } from './NetworkSection';
import { InviteBanner } from './InviteBanner';
import { InvitesBlock } from './InvitesBlock';
import { initNetwork } from './network-state';
import {
  DEFAULT_ROOM_CAPACITY,
  DEFAULT_SERVER_URL,
  DEFAULT_USER_NAME,
  MAX_ROOM_CAPACITY,
  MIN_ROOM_CAPACITY,
  SERVER_HOST_ALL,
  SERVER_HOST_LOCAL,
  clampRoomCapacity,
  createRoom,
  joinRoom,
  leaveRoom,
  loadCollabSettings,
  removeChat,
  retryWithPassword,
  saveCollabSettings,
  sendChat,
  requestPeerRole,
  setCollabRole,
  setRoomPassword,
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
  const assignedRole = useCollabStore((s) => s.assignedRole);
  const broadcasting = useMasterStream((s) => s.broadcasting);
  const listeningTo = useMasterStream((s) => s.listeningTo);
  const streamVolume = useMasterStream((s) => s.volume);
  const streamError = useMasterStream((s) => s.error);
  const streamReceived = useMasterStream((s) => s.received);
  const streamDropped = useMasterStream((s) => s.dropped);
  const peerRoles = useCollabStore((s) => s.peerRoles);
  const following = useCollabStore((s) => s.following);
  const audioFrozen = useCollabStore((s) => s.audioFrozen);
  const frozenPending = useCollabStore((s) => s.frozenPending);
  const missingSamples = useCollabStore((s) => s.missingSamples);
  const assetWarning = useCollabStore((s) => s.assetWarning);
  const chat = useCollabStore((s) => s.chat);
  const denied = useCollabStore((s) => s.denied);
  const roomProtected = useCollabStore((s) => s.roomProtected);
  const passwordPrompt = useCollabStore((s) => s.passwordPrompt);
  const passwordNotice = useCollabStore((s) => s.passwordNotice);

  const [userName, setUserName] = useState(DEFAULT_USER_NAME);
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [joinCode, setJoinCode] = useState('');
  /**
   * Contraseña de sala, solo en memoria: no se guarda en settings.json (un
   * archivo de ajustes en claro con la contraseña dentro sería justo lo que
   * esto viene a evitar).
   */
  const [password, setPassword] = useState('');
  /** Lo que se escribe para poner o cambiar la contraseña desde dentro. */
  const [newPassword, setNewPassword] = useState('');
  const [passwordBusy, setPasswordBusy] = useState(false);
  /** Capacidad de sala del servidor propio, tal y como se está escribiendo. */
  const [capacityDraft, setCapacityDraft] = useState(String(DEFAULT_ROOM_CAPACITY));
  const capacity = clampRoomCapacity(Number(capacityDraft));
  /** Dónde escuchará el servidor propio (se aplica al arrancarlo). */
  const [serverHost, setServerHost] = useState(SERVER_HOST_LOCAL);
  /** IPv4 de esta máquina, etiquetadas, para el desplegable. */
  const [interfaces, setInterfaces] = useState<{ address: string; label: string }[]>([]);
  const [shareCopied, setShareCopied] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState(false);
  const [barDraft, setBarDraft] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);

  // Servidor de colaboración arrancable desde aquí (solo app de escritorio).
  const canHostServer = typeof window !== 'undefined' && !!window.orbit?.server;
  const [server, setServer] = useState<{
    running: boolean;
    port?: number;
    host?: string;
    roomCapacity?: number;
    openToNetwork?: boolean;
    shareAddress?: string;
    hostHonored?: boolean;
    error?: string;
  }>({
    running: false,
  });
  const [serverBusy, setServerBusy] = useState(false);

  const beatsPerBar = store.project.timeSig.num;

  // Estado inicial del servidor (por si ya estaba arrancado en esta sesión) y
  // direcciones de la máquina para elegir dónde escuchar.
  useEffect(() => {
    if (!canHostServer) return;
    void window.orbit!.server.status().then(setServer);
    void window.orbit!.server.interfaces().then(setInterfaces);
  }, [canHostServer]);

  const toggleServer = async () => {
    if (!window.orbit?.server) return;
    setServerBusy(true);
    try {
      setServer(server.running ? await window.orbit.server.stop() : await window.orbit.server.start());
    } finally {
      setServerBusy(false);
    }
  };

  // Nombre, URL y rol persistidos en settings.json (window.orbit.settings).
  useEffect(() => {
    void loadCollabSettings().then((s) => {
      setUserName(s.userName);
      setServerUrl(s.serverUrl);
      setCapacityDraft(String(s.roomCapacity));
      setServerHost(s.serverHost);
    });
  }, []);

  // Auto-scroll del chat cuando entra un mensaje nuevo.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const persistFields = () => saveCollabSettings({ userName, serverUrl });

  /**
   * URL de la sala tal y como la ve el resto (y como la tiene que ver ESTA app
   * si el servidor escucha en una IP concreta: atado a una dirección, localhost
   * deja de responder hasta para quien hospeda).
   */
  const shareUrl = `ws://${server.shareAddress ?? ''}:${server.port ?? ''}`;

  /*
   * La URL que se manda en una invitación.
   *
   * Si esta app hospeda el servidor y sabe con qué dirección se le llega desde
   * fuera, esa; si no, la misma con la que estamos conectados nosotros. Mandar
   * `localhost` porque es lo que tenemos en el campo sería invitar a una sala a
   * la que el otro no puede entrar.
   */
  const inviteUrl =
    server.running && server.shareAddress !== undefined ? shareUrl : serverUrl || DEFAULT_SERVER_URL;

  // El descubrimiento vive en el main; aquí solo se engancha (idempotente).
  useEffect(() => {
    initNetwork();
  }, []);

  /** Nombre legible de una dirección para los avisos ("Radmin VPN — 26.x"). */
  const hostLabel = (host: string): string => {
    if (host === SERVER_HOST_LOCAL) return 'solo esta máquina';
    if (host === SERVER_HOST_ALL) return 'todas las redes';
    const found = interfaces.find((net) => net.address === host);
    return found ? `${found.label} (${host})` : host;
  };

  /** Deja el campo en un valor posible y lo guarda (lo aplica el próximo arranque). */
  const commitCapacity = () => {
    const value = clampRoomCapacity(Number(capacityDraft));
    setCapacityDraft(String(value));
    saveCollabSettings({ roomCapacity: value });
  };

  const handleCreate = () => {
    persistFields();
    void createRoom(serverUrl, userName, password);
  };

  const handleJoin = (code: string) => {
    persistFields();
    void joinRoom(code, serverUrl, userName, password);
  };

  /** Reintento desde el aviso de la puerta, con lo que acaban de escribir. */
  const handleRetryWithPassword = () => {
    if (password.trim() === '') return;
    persistFields();
    void retryWithPassword(serverUrl, userName, password);
  };

  /** Pone o quita la contraseña de la sala (solo el productor). */
  const commitRoomPassword = (value: string) => {
    setPasswordBusy(true);
    void setRoomPassword(value)
      .then(() => setNewPassword(''))
      .finally(() => setPasswordBusy(false));
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

  /**
   * Etiqueta de cada conectado. Todo el mundo entra como "Productor" si no se
   * cambia el nombre, así que a partir del segundo repetido se numera: con tres
   * personas en la sala, tres "Productor" a secas no dicen quién es quién.
   */
  const peerLabels = useMemo(() => {
    const count = new Map<string, number>();
    const labels = new Map<number, string>();
    for (const p of peers) {
      const n = (count.get(p.user.name) ?? 0) + 1;
      count.set(p.user.name, n);
      labels.set(p.clientId, n > 1 ? `${p.user.name} ${n}` : p.user.name);
    }
    return labels;
  }, [peers]);

  // ── En sala (o entrando): código, presencia, chat y salida ─────────────────
  if (phase === 'online' || phase === 'connecting') {
    return (
      <div className="collab">
        <InviteBanner userName={userName} />
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
            ? `En línea — ${peers.length} conectado${peers.length === 1 ? '' : 's'}${
                server.running && server.roomCapacity ? ` de ${server.roomCapacity}` : ''
              }`
            : 'Conectando…'}
          <span
            className="collab-role-chip"
            title={
              assignedRole
                ? 'Rol asignado por la sala (el servidor lo reparte y lo hace cumplir)'
                : 'Rol con el que te presentarás al entrar'
            }
          >
            {ROLE_LABELS[role]}
          </span>
        </div>

        {denied && <p className="collab-error">{denied}</p>}

        {phase === 'online' && peers.length > 0 && (
          <ul className="collab-peers">
            {peers.map((p) => (
              <li key={p.clientId}>
                <div className="collab-peer">
                  <span className="collab-peer-dot" style={{ background: p.user.color }} />
                  <span className="collab-peer-name">
                    {peerLabels.get(p.clientId) ?? p.user.name}
                    {p.isSelf ? ' (tú)' : ''}
                  </span>
                  {assignedRole === 'productor' && !p.isSelf ? (
                    <select
                      className="collab-role-select"
                      value={peerRoles[String(p.clientId)] ?? p.role}
                      title="Cambiar su rol en la sala (lo aplica el servidor)"
                      onChange={(e) =>
                        requestPeerRole(p.clientId, e.target.value as CollabRole)
                      }
                    >
                      {COLLAB_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="collab-role-chip">
                      {ROLE_LABELS[peerRoles[String(p.clientId)] ?? p.role]}
                    </span>
                  )}
                  {p.activity && (
                    <span className="collab-peer-activity">
                      · {p.activity.editor}
                      {p.activity.detail ? ` — ${p.activity.detail}` : ''}
                    </span>
                  )}
                  {!p.isSelf && (
                    <button
                      className={`collab-btn small${listeningTo === p.clientId ? ' primary' : ''}`}
                      title="Escuchar SU master (lo que le suena a esa persona, no tu render)"
                      onClick={() => {
                        ensureAudioReady();
                        if (listeningTo === p.clientId) stopListening();
                        else listenTo(p.clientId);
                      }}
                    >
                      {listeningTo === p.clientId ? 'Dejar de oír' : 'Oír'}
                    </button>
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

        {/* ── Streaming del master: oír lo que le suena a otro de verdad ── */}
        <h3 className="collab-heading">Master de la sala</h3>
        <div>
          <button
            className={`collab-btn small${broadcasting ? ' primary' : ''}`}
            title="Emite TU salida final a la sala; los demás pueden oírla con el botón Oír de tu fila"
            onClick={() => {
              ensureAudioReady();
              toggleBroadcast();
            }}
          >
            {broadcasting ? 'Dejando oír mi master' : 'Emitir mi master'}
          </button>
          {listeningTo !== null && (
            <button className="collab-btn small" onClick={() => stopListening()}>
              Dejar de escuchar
            </button>
          )}
        </div>
        {listeningTo !== null && (
          <p className="collab-note" data-qa="stream-status">
            {streamReceived === 0
              ? 'Esperando audio… (esa persona tiene que darle a "Emitir mi master")'
              : `Sonando lo suyo · ${streamReceived} trozos recibidos${
                  streamDropped ? ' · la red viene por delante y se tira alguno' : ''
                }`}
          </p>
        )}
        {listeningTo !== null && (
          <div className="collab-row">
            <span className="collab-label">Volumen de escucha</span>
            <input
              className="collab-input"
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={streamVolume}
              onChange={(e) => setStreamVolume(Number(e.target.value))}
            />
          </div>
        )}
        <p className="collab-note">
          Lo que se emite es la salida final tal y como suena en esa máquina (mono, sin comprimir).
          Es para comparar, no para mezclar: la referencia sigue siendo el render.
        </p>
        {streamError && <p className="collab-error">{streamError}</p>}

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
        <NetworkSection userName={userName} roomCode={roomCode} inviteUrl={inviteUrl} />

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

        <h3 className="collab-heading">Puerta de la sala</h3>
        <p className="collab-note">
          {roomProtected
            ? 'Con contraseña: para entrar hace falta el código Y la contraseña.'
            : 'Sin contraseña: entra quien llegue al servidor y sepa el código.'}
        </p>
        {assignedRole === 'productor' ? (
          <>
            <div className="collab-row">
              <input
                className="collab-input"
                type="password"
                value={newPassword}
                placeholder={roomProtected ? 'Cambiar la contraseña' : 'Poner una contraseña'}
                spellCheck={false}
                autoComplete="new-password"
                onChange={(e) => setNewPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newPassword.trim() !== '') {
                    commitRoomPassword(newPassword);
                  }
                }}
              />
              <button
                className="collab-btn primary"
                disabled={passwordBusy || newPassword.trim() === ''}
                onClick={() => commitRoomPassword(newPassword)}
              >
                {passwordBusy ? '…' : roomProtected ? 'Cambiar' : 'Poner'}
              </button>
              {roomProtected && (
                <button
                  className="collab-btn danger"
                  disabled={passwordBusy}
                  onClick={() => commitRoomPassword('')}
                >
                  Quitar
                </button>
              )}
            </div>
            <p className="collab-note">
              La contraseña no viaja: se queda en tu equipo y solo sale una firma que cambia en
              cada conexión. El servidor guarda un hash con el que tampoco se puede entrar.
            </p>
          </>
        ) : (
          <p className="collab-note">La cerradura la cambia el productor de la sala.</p>
        )}
        {passwordNotice && <p className="collab-warn">{passwordNotice}</p>}

        <InvitesBlock canManage={assignedRole === 'productor'} roomProtected={roomProtected} />

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
      <InviteBanner userName={userName} />
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
          disabled={assignedRole !== null}
          title={
            assignedRole !== null
              ? 'Dentro de una sala el rol lo reparte el servidor'
              : 'Rol con el que te presentas al entrar'
          }
          onChange={(e) => setCollabRole(e.target.value as (typeof COLLAB_ROLES)[number])}
        >
          {COLLAB_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <p className="collab-note">
        {assignedRole !== null
          ? `${ROLE_DESCRIPTIONS[role]} Te lo ha asignado la sala: el primero que entra es el productor y reparte los demás.`
          : ROLE_DESCRIPTIONS[role]}
      </p>

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
      {canHostServer ? (
        <div className="collab-row collab-server-ctl">
          <button
            className={`collab-btn${server.running ? ' danger' : ''}`}
            onClick={() => void toggleServer()}
            disabled={serverBusy}
          >
            {serverBusy
              ? '…'
              : server.running
                ? 'Detener servidor'
                : 'Iniciar servidor'}
          </button>
          <label className="collab-check" title={`Cuánta gente cabe en cada sala (${MIN_ROOM_CAPACITY}–${MAX_ROOM_CAPACITY})`}>
            Caben
            <input
              className="collab-input collab-bar-input"
              value={capacityDraft}
              inputMode="numeric"
              maxLength={2}
              onChange={(e) => setCapacityDraft(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitCapacity}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitCapacity();
              }}
            />
          </label>
          <label
            className="collab-check collab-host-pick"
            title="En qué dirección escucha el servidor. Se aplica al arrancarlo."
          >
            Escucha en
            <select
              className="collab-input"
              value={serverHost}
              onChange={(e) => {
                setServerHost(e.target.value);
                saveCollabSettings({ serverHost: e.target.value });
              }}
            >
              <option value={SERVER_HOST_LOCAL}>Solo esta máquina (localhost)</option>
              {interfaces.map((net) => (
                <option key={net.address} value={net.address}>
                  {net.label} — {net.address}
                </option>
              ))}
              <option value={SERVER_HOST_ALL}>Todas las redes</option>
            </select>
          </label>
          <span className="collab-note">
            {server.running ? (
              <>
                <span className="collab-dot online" /> En marcha en {server.host}:{server.port} —
                caben {server.roomCapacity ?? capacity} por sala
                {server.roomCapacity !== undefined && server.roomCapacity !== capacity
                  ? ` (reinícialo para dejar entrar a ${capacity})`
                  : ''}
                {server.host !== undefined && server.host !== serverHost
                  ? ` · reinícialo para escuchar en ${hostLabel(serverHost)}`
                  : ''}
              </>
            ) : server.error ? (
              `No arrancó: ${server.error}`
            ) : (
              `Arráncalo aquí (o con npm run server) y escucha en ${DEFAULT_SERVER_URL}.`
            )}
          </span>
          {server.running && server.hostHonored === false && (
            <span className="collab-warn">
              La dirección elegida ({hostLabel(serverHost)}) no está disponible ahora mismo — ¿el
              VPN apagado? Se quedó escuchando solo en esta máquina.
            </span>
          )}
          {server.running && server.openToNetwork && (
            <span className="collab-note">
              Que se conecten a{' '}
              <b>{`ws://${server.shareAddress ?? '<tu-ip>'}:${server.port}`}</b>
              {server.shareAddress && (
                <button
                  className="collab-btn small"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(shareUrl)
                      .then(() => {
                        setShareCopied(true);
                        window.setTimeout(() => setShareCopied(false), 1500);
                      })
                      .catch(() => {
                        // Sin portapapeles: la dirección queda a la vista.
                      });
                  }}
                >
                  {shareCopied ? '¡Copiado!' : 'Copiar'}
                </button>
              )}
              . Si la sala no lleva contraseña, entra quien llegue al puerto y sepa el código:
              ponle una al crearla.
              {server.shareAddress !== undefined && serverUrl !== shareUrl && (
                <>
                  {' '}
                  Ojo: escuchando en una dirección concreta, <code>localhost</code> ya no vale ni
                  para ti.{' '}
                  <button
                    className="collab-btn small"
                    onClick={() => {
                      setServerUrl(shareUrl);
                      saveCollabSettings({ serverUrl: shareUrl });
                    }}
                  >
                    Usarla aquí
                  </button>
                </>
              )}
            </span>
          )}
        </div>
      ) : (
        <p className="collab-note">
          El servidor local se arranca con <code>npm run server</code> y escucha en{' '}
          {DEFAULT_SERVER_URL}.
        </p>
      )}

      {passwordPrompt !== null && roomCode ? (
        <div className="collab-error-box">
          <p className="collab-error">
            {passwordPrompt === 'wrong'
              ? `Esa no era la contraseña de ${formatRoomCode(roomCode)}.`
              : `La sala ${formatRoomCode(roomCode)} pide contraseña.`}
          </p>
          <div className="collab-row">
            <input
              className="collab-input"
              type="password"
              value={password}
              placeholder="Contraseña de la sala"
              spellCheck={false}
              autoComplete="current-password"
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRetryWithPassword();
              }}
            />
            <button
              className="collab-btn primary"
              disabled={password.trim() === ''}
              onClick={handleRetryWithPassword}
            >
              Entrar
            </button>
          </div>
        </div>
      ) : (
        phase === 'error' &&
        error && (
          <div className="collab-error-box">
            <p className="collab-error">{error}</p>
            {roomCode && (
              <button className="collab-btn" onClick={() => handleJoin(roomCode)}>
                Reintentar con {formatRoomCode(roomCode)}
              </button>
            )}
          </div>
        )
      )}

      <div className="collab-row">
        <span className="collab-label">Contraseña</span>
        <input
          className="collab-input"
          type="password"
          value={password}
          placeholder="opcional"
          spellCheck={false}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && joinCode.trim() !== '') handleJoin(joinCode);
          }}
        />
      </div>
      <p className="collab-note">
        Al crear, cierra la sala con esa contraseña. Al unirte, es la que pide la sala. No se
        guarda en ningún ajuste: se escribe cada vez.
      </p>

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

      <NetworkSection userName={userName} roomCode={roomCode} inviteUrl={inviteUrl} />
    </div>
  );
}
