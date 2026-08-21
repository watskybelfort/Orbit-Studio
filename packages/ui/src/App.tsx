import { useEffect, useState } from 'react';
import './theme/base.css';
import './theme/tokens.css';
import { TitleBar } from './shell/TitleBar';
import { MenuBar } from './shell/MenuBar';
import { AboutDialog } from './shell/AboutDialog';
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
  useAutosave,
  type RecoveryOffer,
} from './state/autosave';
import { initPresence } from './collab/presence';
import { restoreDetached } from './state/detached';
import { initWorkspaceMemory } from './state/workspace-memory';
import { initClaudeBridge } from './state/claude';
import { initLiveInput } from './state/live-input';
import { initPlugins } from './state/plugins';
import { CommandPalette } from './palette';
import { registerDefaultCommands } from './palette/default-commands';
import { refreshRecents, useProjectFile } from './state/project-file';
import { useBounceStore } from './state/bounce';
import { useUiStore } from './state/ui';

// Shell raíz: tema persistido, barra de título, toolbar (menús + transporte),
// browser lateral, workspace con ventanas internas y panel de Claude.

export function App() {
  const trafficLights = useUiStore((s) => s.trafficLights);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const claudePanelOpen = useUiStore((s) => s.claudePanelOpen);
  const compact = useUiStore((s) => s.compact);
  const aboutOpen = useUiStore((s) => s.aboutOpen);
  const notice = useProjectFile((s) => s.notice);
  const bounceBusy = useBounceStore((s) => s.busy);
  const bounceNotice = useBounceStore((s) => s.notice);
  const [recovery, setRecovery] = useState<RecoveryOffer | null>(null);
  const recoveryError = useAutosave((s) => s.error);

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
    // Los recientes se piden una vez al arrancar; a partir de ahí los refresca
    // cada abrir/guardar (la lista la mantiene el main).
    void refreshRecents();
    // Recuperación: primero mirar si quedó un autosave pendiente, y solo
    // después arrancar el bucle (que no escribe hasta que algo cambie).
    void checkRecovery().then((offer) => {
      if (alive && offer) setRecovery(offer);
      initAutosave();
    });
    loadThemeFromSettings()
      .then(({ overrides }) => {
        if (alive) useUiStore.setState({ trafficLights: overrides.trafficLights ?? false });
      })
      .catch(() => {
        void applyTheme('dark');
      });
    // El AudioContext necesita un gesto: el primer pointerdown lo despierta.
    const wake = () => {
      ensureAudioReady();
      window.removeEventListener('pointerdown', wake);
    };
    window.addEventListener('pointerdown', wake);
    return () => {
      alive = false;
      window.removeEventListener('pointerdown', wake);
    };
  }, []);

  return (
    <div className={`app-shell${compact ? ' compact' : ''}`}>
      <TitleBar trafficLights={trafficLights} />
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
