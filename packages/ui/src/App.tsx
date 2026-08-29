import { useEffect, useState } from 'react';
import './theme/base.css';
import './theme/tokens.css';
import { TitleBar } from './shell/TitleBar';
import { MenuBar } from './shell/MenuBar';
import { AboutDialog } from './shell/AboutDialog';
import { ShortcutsDialog } from './shell/ShortcutsDialog';
import { Transport } from './shell/Transport';
import { Workspace } from './shell/Workspace';
import { Browser } from './browser';
import { ClaudePanel } from './claude/ClaudePanel';
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
import { initClaudeBridge } from './state/claude';
import { initLiveInput } from './state/live-input';
import { initPlugins } from './state/plugins';
import { CommandPalette, loadRecentCommands } from './palette';
import { registerDefaultCommands } from './palette/default-commands';
import { refreshRecents, saveProject, useProjectFile } from './state/project-file';
import { useBounceStore } from './state/bounce';
import { useProject } from './state/useProject';
import { useUiStore } from './state/ui';
import { dismissUpdate, initUpdateCheck, useUpdateCheck } from './state/update-check';

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
  const [recovery, setRecovery] = useState<RecoveryOffer | null>(null);
  const recoveryError = useAutosave((s) => s.error);
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
    void initWorkspaceMemory().finally(() => restoreDetached());
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
     * nada que preguntar. Si el usuario cancela el "guardar como", seguimos
     * sucios y la ventana se queda donde está, que es lo correcto.
     */
    const offSaveAndClose = window.orbit?.app.onSaveAndClose(() => {
      void saveProject().then(() => {
        if (!isDirty()) void window.orbit?.window.close();
      });
    });
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
      <div className="app-columns">
        {/* En modo compacto los paneles no se montan pero conservan su flag:
            al salir del modo vuelven solos tal y como estaban. */}
        {browserOpen && !compact && (
          <aside className="sidebar">
            <div className="sidebar-header">Browser</div>
            <Browser />
          </aside>
        )}
        <Workspace />
        {claudePanelOpen && !compact && (
          <aside className="claude-panel">
            <div className="sidebar-header">Claude</div>
            <ClaudePanel />
          </aside>
        )}
      </div>
      <CommandPalette />
      {aboutOpen && <AboutDialog />}
      {shortcutsOpen && <ShortcutsDialog />}
      {/*
        Cartel discreto de versión nueva. Esquina superior derecha para no
        pisar el aviso de recuperación (arriba, centrado) ni el `app-notice`
        (abajo, centrado). `.popup` da la superficie/blur del tema; el resto
        son solo medidas — el color sale todo de variables del tema.
      */}
      {updateAvailable && updateRelease && (
        <div
          className="popup"
          style={{
            position: 'fixed',
            top: 'calc(var(--titlebar-h) + 10px)',
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
      {(bounceBusy ?? bounceNotice ?? notice) && (
        <div className="app-notice popup">{bounceBusy ?? bounceNotice ?? notice}</div>
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
    </div>
  );
}
