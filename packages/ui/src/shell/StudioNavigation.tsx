/** Navegación estable por el flujo de producción; el transporte queda aparte. */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconBrowser, IconChannelRack, IconClaude, IconExport, IconHelp, IconMixer, IconPianoRoll, IconPlaylist, IconSearch, IconSettings } from '../icons';
import { usePaletteStore } from '../palette';
import { isWindowId, useUiStore } from '../state/ui';
import { useProject } from '../state/useProject';
import { applyLayout, applyPreset, LAYOUT_PRESETS, listLayouts, saveLayout, useLayoutNotice } from '../state/layouts';
import { StudioGuide } from './StudioGuide';
import { askName } from './name-dialog';
import './studio-navigation.css';

const EDITORS = [
  { id: 'channelRack', label: 'Ritmos', detail: 'Channel Rack · programa tus pasos y elige sonidos', key: 'F6', Icon: IconChannelRack },
  { id: 'pianoRoll', label: 'Notas', detail: 'Piano Roll · dibuja melodías, acordes y slides de 808', key: 'F7', Icon: IconPianoRoll },
  { id: 'playlist', label: 'Arreglo', detail: 'Playlist · ordena patrones y audio en la canción', key: 'F5', Icon: IconPlaylist },
  { id: 'mixer', label: 'Mezcla', detail: 'Mixer · ajusta niveles, efectos y envíos', key: 'F9', Icon: IconMixer },
  { id: 'export', label: 'Exportar', detail: 'Prepara el audio y MIDI para compartir o seguir en FL', key: '', Icon: IconExport },
] as const;

export function StudioNavigation() {
  const [guideOpen, setGuideOpen] = useState(false);
  const guideTrigger = useRef<HTMLButtonElement>(null);
  const project = useProject();
  const layoutNotice = useLayoutNotice((s) => s.message);
  const dismissLayoutNotice = useLayoutNotice((s) => s.dismiss);
  const windows = useUiStore((s) => s.windows);
  const openWindow = useUiStore((s) => s.openWindow);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const claudePanelOpen = useUiStore((s) => s.claudePanelOpen);
  const compact = useUiStore((s) => s.compact);
  // «Al frente» se decide solo entre editores: si la ventana de arriba es
  // Ajustes o el Historial, la barra no debe quedarse sin ninguna pestaña
  // marcada — el editor que sigue abierto detrás es el contexto real.
  const front = EDITORS.map(({ id }) => id)
    .filter((id) => windows[id]?.open)
    .sort((a, b) => windows[b]!.z - windows[a]!.z)[0];

  // El aviso de «espacio reducido» explica una decisión, no bloquea nada: a los
  // 8 s se va solo. Antes se quedaba fijo en la esquina tapando los controles
  // inferiores de la ventana que cayera ahí hasta que alguien pulsara la ×.
  useEffect(() => {
    if (layoutNotice === null) return;
    const timer = window.setTimeout(dismissLayoutNotice, 8000);
    return () => window.clearTimeout(timer);
  }, [layoutNotice, dismissLayoutNotice]);

  return (
    <div className="studio-nav-container">
    <nav className="studio-nav" aria-label="Herramientas del estudio">
      <div className="studio-nav__editors">
        <div className="studio-nav__tabs" role="group" aria-label="Editores">
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
        </div>
        <select
          className="studio-nav__tools"
          aria-label="Abrir otra herramienta"
          value=""
          onChange={(event) => {
            if (isWindowId(event.target.value)) openWindow(event.target.value);
            else if (event.target.value === 'assistant') useUiStore.setState((s) => ({ claudePanelOpen: !s.claudePanelOpen || s.compact, compact: false }));
          }}
        >
          <option value="" disabled>Más herramientas…</option>
          <optgroup label="Crear y editar">
            <option value="automation">Automatización · dibujar cambios</option>
            <option value="lfo">LFO · modular parámetros</option>
            <option value="audioEditor">Editor de audio · recortar y afinar</option>
            <option value="liveView">Vista Live · lanzar escenas (F8)</option>
            <option value="composer">Compositor · un beat entero por partes</option>
          </optgroup>
          <optgroup label="Analizar y colaborar">
            <option value="scope">Scope · ver la señal</option>
            <option value="graph">Enrutado · conectar pistas</option>
            <option value="history">Historial · revisar cambios</option>
            <option value="collab">Colaboración · abrir una sesión</option>
            <option value="projectInfo">Información del proyecto</option>
            <option value="assistant">Asistente Claude · mostrar u ocultar</option>
          </optgroup>
        </select>
      </div>
      <div className="studio-nav__utilities">
        <select
          className="studio-nav__tools studio-nav__layout"
          aria-label="Organizar el escritorio"
          title="Distribuir ventanas para componer, arreglar o mezclar"
          value=""
          onChange={(event) => {
            const value = event.target.value;
            // Guardar no cambia el escritorio antes de fotografiarlo: por eso
            // esta rama va ANTES del `compact: false` que usan los presets.
            if (value === 'save-desktop') {
              void askName({
                title: 'Guardar el escritorio actual',
                label: 'Nombre del layout',
                initial: 'Mi escritorio',
                confirmLabel: 'Guardar layout',
              }).then((name) => {
                if (name === null) return;
                if (saveLayout(name)) {
                  useLayoutNotice.setState({ message: `Escritorio «${name}» guardado en el proyecto.` });
                }
              });
              return;
            }
            useUiStore.setState({ compact: false });
            if (value.startsWith('preset:')) applyPreset(value.slice(7));
            else if (value.startsWith('saved:')) applyLayout(value.slice(6));
          }}
        >
          <option value="" disabled>Organizar…</option>
          <optgroup label="Según tu tarea">{LAYOUT_PRESETS.map((preset) => <option key={preset.id} value={`preset:${preset.id}`}>{preset.name}</option>)}</optgroup>
          {listLayouts(project).length > 0 && <optgroup label="Guardados en el proyecto">{listLayouts(project).map((name) => <option key={name} value={`saved:${name}`}>{name}</option>)}</optgroup>}
          {/* Siempre la última y siempre presente, aunque no haya layouts
              guardados: es la forma de crear el primero. */}
          <option value="save-desktop">Guardar el escritorio actual…</option>
        </select>
        <button
          className="studio-nav__utility"
          aria-pressed={browserOpen && !compact}
          title="Mostrar u ocultar la biblioteca de sonidos"
          onClick={() => useUiStore.setState({ browserOpen: !browserOpen || compact, compact: false })}
        ><IconBrowser size={15} /><span>Sonidos</span></button>
        <button
          className="studio-nav__utility"
          aria-pressed={claudePanelOpen && !compact}
          title="Mostrar u ocultar el panel de Claude (a la derecha)"
          onClick={() => useUiStore.setState({ claudePanelOpen: !claudePanelOpen || compact, compact: false })}
        ><IconClaude size={15} /><span>Claude</span></button>
        <button className="studio-nav__utility" title="Personalizar el estudio y configurar dispositivos" onClick={() => openWindow('settings')}>
          <IconSettings size={15} /><span>Ajustes</span>
        </button>
        <button ref={guideTrigger} className="studio-nav__utility studio-nav__guide" onClick={() => setGuideOpen(true)} aria-haspopup="dialog"><IconHelp size={15} /><span>Guía</span></button>
        <button className="studio-nav__search" title="Buscar comandos, editores y acciones (Ctrl+K)" onClick={() => usePaletteStore.getState().openPalette()}>
          <IconSearch size={14} />
          <span className="studio-nav__search-label">Buscar acciones</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>
      {guideOpen && <StudioGuide onClose={() => setGuideOpen(false)} returnFocusTo={guideTrigger.current} />}
      {layoutNotice && createPortal(
        <div className="studio-layout-notice popup">
          {/* La región viva envuelve solo el texto: un botón dentro de un
              `role=status` se anuncia como parte del aviso y se lee raro. */}
          <p role="status">{layoutNotice}</p>
          <button onClick={dismissLayoutNotice} aria-label="Cerrar aviso de distribución">×</button>
        </div>,
        document.body,
      )}
    </nav>
    </div>
  );
}
