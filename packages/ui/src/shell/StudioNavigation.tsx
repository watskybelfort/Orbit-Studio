/** Navegación estable por el flujo de producción; el transporte queda aparte. */
import { IconBrowser, IconChannelRack, IconClaude, IconExport, IconMixer, IconPianoRoll, IconPlaylist, IconSettings } from '../icons';
import { usePaletteStore } from '../palette';
import { isWindowId, useUiStore } from '../state/ui';
import './studio-navigation.css';

const EDITORS = [
  { id: 'channelRack', label: 'Ritmos', detail: 'Channel Rack · programa tus pasos y elige sonidos', key: 'F6', Icon: IconChannelRack },
  { id: 'pianoRoll', label: 'Notas', detail: 'Piano Roll · dibuja melodías, acordes y slides de 808', key: 'F7', Icon: IconPianoRoll },
  { id: 'playlist', label: 'Arreglo', detail: 'Playlist · ordena patrones y audio en la canción', key: 'F5', Icon: IconPlaylist },
  { id: 'mixer', label: 'Mezcla', detail: 'Mixer · ajusta niveles, efectos y envíos', key: 'F9', Icon: IconMixer },
  { id: 'export', label: 'Exportar', detail: 'Prepara el audio y MIDI para compartir o seguir en FL', key: '', Icon: IconExport },
] as const;

export function StudioNavigation() {
  const windows = useUiStore((s) => s.windows);
  const openWindow = useUiStore((s) => s.openWindow);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const claudePanelOpen = useUiStore((s) => s.claudePanelOpen);
  const compact = useUiStore((s) => s.compact);
  const front = Object.entries(windows).filter(([, w]) => w.open).sort((a, b) => b[1].z - a[1].z)[0]?.[0];

  return (
    <nav className="studio-nav" aria-label="Herramientas del estudio">
      <div className="studio-nav__editors">
        {EDITORS.map(({ id, label, detail, key, Icon }) => (
          <button
            key={id}
            className={`studio-nav__editor${front === id ? ' is-front' : ''}`}
            aria-current={front === id ? 'true' : undefined}
            title={`${detail}${key ? ` (${key})` : ''}. Abrir o traer al frente.`}
            onClick={() => openWindow(id)}
          >
            <Icon size={16} />
            <span>{label}</span>
            {key && <kbd>{key}</kbd>}
            <span className={`studio-nav__indicator${windows[id].open ? ' is-open' : ''}`} aria-label={windows[id].open ? 'Abierto' : undefined} />
          </button>
        ))}
        <select
          className="studio-nav__tools"
          aria-label="Abrir otra herramienta"
          value=""
          onChange={(event) => {
            if (isWindowId(event.target.value)) openWindow(event.target.value);
          }}
        >
          <option value="" disabled>Más herramientas…</option>
          <optgroup label="Crear y editar">
            <option value="automation">Automatización · dibujar cambios</option>
            <option value="lfo">LFO · modular parámetros</option>
            <option value="audioEditor">Editor de audio · recortar y afinar</option>
            <option value="liveView">Vista Live · lanzar escenas (F8)</option>
          </optgroup>
          <optgroup label="Analizar y colaborar">
            <option value="scope">Scope · ver la señal</option>
            <option value="graph">Enrutado · conectar pistas</option>
            <option value="history">Historial · revisar cambios</option>
            <option value="collab">Colaboración · abrir una sesión</option>
            <option value="projectInfo">Información del proyecto</option>
          </optgroup>
        </select>
      </div>
      <div className="studio-nav__utilities">
        <button
          className="studio-nav__utility"
          aria-pressed={browserOpen && !compact}
          title="Mostrar u ocultar la biblioteca de sonidos"
          onClick={() => useUiStore.setState({ browserOpen: !browserOpen || compact, compact: false })}
        ><IconBrowser size={15} /><span>Sonidos</span></button>
        <button
          className="studio-nav__utility"
          aria-pressed={claudePanelOpen && !compact}
          title="Mostrar u ocultar el asistente Claude"
          onClick={() => useUiStore.setState({ claudePanelOpen: !claudePanelOpen || compact, compact: false })}
        ><IconClaude size={15} /><span>Asistente</span></button>
        <button className="studio-nav__utility" title="Personalizar el estudio y configurar dispositivos" onClick={() => openWindow('settings')}>
          <IconSettings size={15} /><span>Ajustes</span>
        </button>
        <button className="studio-nav__search" title="Buscar comandos, editores y acciones (Ctrl+K)" onClick={() => usePaletteStore.getState().openPalette()}>
          Buscar acciones <kbd>Ctrl K</kbd>
        </button>
      </div>
    </nav>
  );
}
