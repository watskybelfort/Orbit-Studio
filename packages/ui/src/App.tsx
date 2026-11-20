import { useEffect, useState } from 'react';
import './theme/base.css';
import './theme/tokens.css';
import { TitleBar } from './shell/TitleBar';
import { MenuBar } from './shell/MenuBar';
import { AboutDialog } from './shell/AboutDialog';
import { NameDialogHost } from './shell/NameDialog';
import { PanelSplitter } from './shell/PanelSplitter';
import { ShortcutsDialog } from './shell/ShortcutsDialog';
import { Transport } from './shell/Transport';
import { Workspace } from './shell/Workspace';
import { StudioNavigation } from './shell/StudioNavigation';
import { RouteCableOverlay } from './shell/RouteCableOverlay';
import { Browser } from './browser';
import { ClaudePanel } from './claude/ClaudePanel';
import { IconClose } from './icons';
import { applyTheme, loadThemeFromSettings } from './theme/theme';
import { useShortcuts } from './hooks/useShortcuts';
import { ensureAudioReady } from './state/app';
import {
  applyRecovery,
  checkRecovery,
  discardRecovery,
  initAutosave,
  isDirty,
  useAutosave,
  type RecoveryOffer,
} from './state/autosave';
import { initPresence } from './collab/presence';
import { restoreDetached } from './state/detached';
import { initWorkspaceMemory } from './state/workspace-memory';
import { loadPanelWidths } from './state/panel-widths';
import { initClaudeBridge } from './state/claude';
import { initLiveInput } from './state/live-input';
import { initPlugins } from './state/plugins';
import { CommandPalette, loadRecentCommands } from './palette';
import { registerDefaultCommands } from './palette/default-commands';
import { refreshRecents, saveProject, useProjectFile } from './state/project-file';
import { createSaveAndCloseRunner } from './state/save-and-close';
import { dismissBounceRecovery, useBounceStore } from './state/bounce';
import { dismissCaptureRecovery, useTrackCapture } from './state/track-capture';
import { dismissRecorderError, dismissRecorderNotice, dismissRecorderRecovery, useRecorderStore } from './state/recorder';
import { checkRecordingRecovery, discardInterruptedTake, recoverInterruptedTake, useTakeRecovery } from './state/recording-recovery';
import { dismissAudioEditRecovery, useAudioEditStore } from './editors/audio/audio-edit-actions';
import { useProject } from './state/useProject';
import { useUiStore } from './state/ui';
import { dismissUpdate, initUpdateCheck, useUpdateCheck } from './state/update-check';
// Capa de diseño nativo: se importa al final para que sus reglas ganen sobre
// los CSS de cada componente (todas viven bajo data-style='soft').
import './theme/native.css';

// Shell raíz: tema persistido, barra de título, toolbar (menús + transporte),
// browser lateral, workspace con ventanas internas y panel de Claude.

export function App() {
  const trafficLights = useUiStore((s) => s.trafficLights);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const claudePanelOpen = useUiStore((s) => s.claudePanelOpen);
  const compact = useUiStore((s) => s.compact);
  const aboutOpen = useUiStore((s) => s.aboutOpen);
  const shortcutsOpen = useUiStore((s) => s.shortcutsOpen);
  const notice = useProjectFile((s) => s.notice);
  const projectPath = useProjectFile((s) => s.path);
  const dirty = useAutosave((s) => s.dirty);
  const project = useProject();
  const bounceBusy = useBounceStore((s) => s.busy);
  const bounceNotice = useBounceStore((s) => s.notice);
  const bounceRecovery = useBounceStore((s) => s.recoveryNotice);
  const [recovery, setRecovery] = useState<RecoveryOffer | null>(null);
  const recoveryError = useAutosave((s) => s.error);
  const autosaveNotice = recovery ? null : recoveryError;
  const captureRecovery = useTrackCapture((s) => s.recoveryNotice);
  const recorderRecovery = useRecorderStore((s) => s.recoveryNotice);
  const recorderNotice = useRecorderStore((s) => s.notice);
  const recorderError = useRecorderStore((s) => s.error);
  const takeOffer = useTakeRecovery((s) => s.offer);
  const takeBusy = useTakeRecovery((s) => s.busy);
  const takeError = useTakeRecovery((s) => s.error);
  const audioEditRecovery = useAudioEditStore((s) => s.recoveryNotice);
  const fileNotice = bounceBusy ?? bounceNotice ?? autosaveNotice ?? notice;
  const updateAvailable = useUpdateCheck((s) => s.available);
  const updateRelease = useUpdateCheck((s) => s.release);

  useShortcuts();

  useEffect(() => {
    let alive = true;
    initClaudeBridge();
    initPresence();
    initLiveInput();
    void initPlugins();
    // El escritorio vuelve a montarse como lo dejaste y, encima, los editores
    // que vivían en su propia ventana salen otra vez fuera (y en el monitor
    // donde estaban: el sitio lo recuerda el main). En ese orden: los
    // desacoplados mandan sobre la disposición interna.
    // Los anchos de los paneles se aplican ANTES de restaurar el escritorio:
    // `workspaceArea()` mide el panel vivo (o cae al token `--sidebar-width` /
    // `--assistant-width`), así que con los valores de fábrica mediría un área
    // que no es la que se va a ver y recortaría las ventanas de más.
    void loadPanelWidths()
      .then(() => initWorkspaceMemory())
      .finally(() => restoreDetached());
    registerDefaultCommands();
    void loadRecentCommands();
    // Los recientes se piden una vez al arrancar; a partir de ahí los refresca
    // cada abrir/guardar (la lista la mantiene el main).
    void refreshRecents();
    // Recuperación: primero mirar si quedó un autosave pendiente, y solo
    // después arrancar el bucle (que no escribe hasta que algo cambie).
    void checkRecovery().then((offer) => {
      if (alive && offer) setRecovery(offer);
      initAutosave();
    });
    // Diario de una toma que la app no cerró: si queda uno, se ofrece.
    void checkRecordingRecovery();
    // Aviso de versión nueva: sin red desde aquí (CSP), la consulta la hace
    // el main y esto solo decide si toca preguntarle y si toca enseñar el
    // cartel. Silencioso si no hay nada nuevo, si está apagado en Ajustes, o
    // si no hay red — no hay nada que reintentar en caliente en este efecto.
    void initUpdateCheck();
    loadThemeFromSettings()
      .then(({ overrides }) => {
        if (alive) useUiStore.setState({ trafficLights: overrides.trafficLights ?? false });
      })
      .catch(() => {
        void applyTheme('dark');
      });
    /*
     * "Guardar y salir" del diálogo de cierre. El main no sabe serializar el
     * proyecto, así que solo pide: aquí se guarda y, si el guardado salió
     * bien (markClean deja el flag a false), se vuelve a cerrar — esta vez sin
     * nada que preguntar. El runner es single-flight: los eventos repetidos
     * del main no encolan otro guardado. Si el usuario cancela el "guardar
     * como", seguimos sucios, se avisa al main y la ventana se queda donde
     * está, que es lo correcto.
     */
    const offSaveAndClose = window.orbit?.app.onSaveAndClose(
      createSaveAndCloseRunner({
        dirty: isDirty,
        save: () => saveProject(),
        flushClean: () => window.orbit?.app.setDirty(false) ?? Promise.resolve(false),
        close: () => window.orbit?.window.close() ?? Promise.resolve(),
        cancel: () => window.orbit?.app.cancelSaveAndClose() ?? Promise.resolve(),
      }),
    );
    // El AudioContext necesita un gesto: el primer pointerdown lo despierta.
    const wake = () => {
      ensureAudioReady();
      window.removeEventListener('pointerdown', wake);
    };
    window.addEventListener('pointerdown', wake);
    return () => {
      alive = false;
      offSaveAndClose?.();
      window.removeEventListener('pointerdown', wake);
    };
  }, []);

  /*
   * Título de la ventana: el nombre del proyecto manda, y el punto delante dice
   * que hay cambios sin guardar. Antes ponía "Orbit Studio" y nada más, así que
   * con dos proyectos abiertos en dos ventanas no se sabía cuál era cuál.
   */
  const projectName = project.meta.title || (projectPath ? projectPath.split(/[/\\]/).pop() : '') || 'Sin título';
  const windowTitle = `${dirty ? '● ' : ''}${projectName} — Orbit Studio`;

  return (
    <div className={`app-shell${compact ? ' compact' : ''}`}>
      <TitleBar trafficLights={trafficLights} title={windowTitle} />
      <div className="toolbar">
        <MenuBar />
        <Transport />
      </div>
      <StudioNavigation />
      <div className="app-columns">
        {/* En modo compacto los paneles no se montan pero conservan su flag:
            al salir del modo vuelven solos tal y como estaban. */}
        {browserOpen && !compact && (
          <aside className="sidebar">
            <div className="sidebar-header">Biblioteca de sonidos</div>
            <Browser />
            <PanelSplitter side="browser" />
          </aside>
        )}
        <Workspace />
        {claudePanelOpen && !compact && (
          <aside className="claude-panel">
            <div className="sidebar-header sidebar-header--with-action">
              <span>Claude</span>
              <button
                className="sidebar-header__close"
                title="Ocultar el panel de Claude (se vuelve a abrir con el botón Claude de la barra)"
                aria-label="Ocultar el panel de Claude"
                onClick={() => useUiStore.setState({ claudePanelOpen: false })}
              >
                <IconClose size={12} />
              </button>
            </div>
            <ClaudePanel />
            <PanelSplitter side="claude" />
          </aside>
        )}
      </div>
      <CommandPalette />
      <RouteCableOverlay />
      {/* Único host de `askName()`: los módulos que no son React piden un
          nombre por promesa y este diálogo lo pinta (top layer del <dialog>). */}
      <NameDialogHost />
      {aboutOpen && <AboutDialog />}
      {shortcutsOpen && <ShortcutsDialog />}
      {/*
        Cartel discreto de versión nueva. Esquina inferior derecha: arriba
        tapaba Ajustes, Guía y Buscar de la barra de navegación (la cuenta de
        antes dejaba fuera la fila del menú). Abajo convive con el
        `app-notice`, que va centrado, y deja libre el asa de redimensionar.
        `.popup` da la superficie/blur del tema; el resto son solo medidas —
        el color sale todo de variables del tema.
      */}
      {updateAvailable && updateRelease && (
        <div
          className="popup"
          style={{
            position: 'fixed',
            bottom: 14,
            right: 14,
            zIndex: 1001,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            fontSize: 12,
            color: 'var(--text)',
          }}
        >
          <span>Hay una versión nueva: v{updateRelease.version}</span>
          <a href={updateRelease.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
            Ver la release
          </a>
          <button
            onClick={dismissUpdate}
            title="Cerrar"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      )}
      {/* Consolidar bloquea el hilo mientras renderiza: el aviso manda. */}
      {(fileNotice ?? captureRecovery ?? recorderError ?? recorderNotice ?? recorderRecovery ?? bounceRecovery ?? audioEditRecovery) && (
        <div className="app-notice popup" role="status" style={{ maxWidth: 'min(680px, calc(100vw / var(--ui-scale, 1) - 32px))', width: 'max-content', overflowWrap: 'anywhere' }}>
          {fileNotice ?? captureRecovery ?? recorderError ?? recorderNotice ?? recorderRecovery ?? bounceRecovery ?? audioEditRecovery}
          {!fileNotice && captureRecovery && (
            <button className="tbtn" style={{ marginLeft: 8, pointerEvents: 'auto' }} onClick={dismissCaptureRecovery} aria-label="Cerrar aviso de captura">
              Entendido
            </button>
          )}
          {!fileNotice && !captureRecovery && recorderError && (
            <button className="tbtn" style={{ marginLeft: 8, pointerEvents: 'auto' }} onClick={dismissRecorderError} aria-label="Cerrar error de grabación">
              Entendido
            </button>
          )}
          {!fileNotice && !captureRecovery && !recorderError && recorderNotice && (
            <button className="tbtn" style={{ marginLeft: 8, pointerEvents: 'auto' }} onClick={dismissRecorderNotice} aria-label="Cerrar aviso de la toma">
              Entendido
            </button>
          )}
          {!fileNotice && !captureRecovery && !recorderError && !recorderNotice && recorderRecovery && (
            <button className="tbtn" style={{ marginLeft: 8, pointerEvents: 'auto' }} onClick={dismissRecorderRecovery} aria-label="Cerrar aviso de grabación">
              Entendido
            </button>
          )}
          {!fileNotice && !captureRecovery && !recorderError && !recorderNotice && !recorderRecovery && bounceRecovery && (
            <button className="tbtn" style={{ marginLeft: 8, pointerEvents: 'auto' }} onClick={dismissBounceRecovery} aria-label="Cerrar aviso de consolidación">
              Entendido
            </button>
          )}
          {!fileNotice && !captureRecovery && !recorderError && !recorderNotice && !recorderRecovery && !bounceRecovery && audioEditRecovery && (
            <button className="tbtn" style={{ marginLeft: 8, pointerEvents: 'auto' }} onClick={dismissAudioEditRecovery} aria-label="Cerrar aviso de edición de audio">
              Entendido
            </button>
          )}
        </div>
      )}
      {recovery && (
        <div className="app-recovery popup">
          <span className="recovery-text">
            {recoveryError ??
              `Hay trabajo sin guardar de la sesión anterior (${new Date(
                recovery.mtimeMs,
              ).toLocaleString()}).`}
          </span>
          <button
            className="recovery-btn primary"
            onClick={() => {
              // Si el autosave está a medias (que es justo el caso para el que
              // existe), el cartel se queda con el motivo en vez de irse sin
              // haber hecho nada.
              if (applyRecovery(recovery)) setRecovery(null);
            }}
          >
            Recuperar
          </button>
          <button
            className="recovery-btn"
            onClick={() => {
              discardRecovery();
              setRecovery(null);
            }}
          >
            Descartar
          </button>
        </div>
      )}
      {takeOffer && (() => {
        const seconds = Math.max(0, takeOffer.frames / Math.max(1, takeOffer.sampleRate));
        const duration = `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
        return (
          <div className="app-recovery popup">
            <span className="recovery-text">
              {takeError ??
                `Se cerró la app durante una toma de «${takeOffer.title}» (${duration}).`}
            </span>
            <button
              className="recovery-btn primary"
              disabled={takeBusy}
              onClick={() => void recoverInterruptedTake()}
            >
              {takeBusy ? 'Recuperando…' : 'Recuperar'}
            </button>
            <button
              className="recovery-btn"
              disabled={takeBusy}
              onClick={() => void discardInterruptedTake()}
            >
              Descartar
            </button>
          </div>
        );
      })()}
    </div>
  );
}
