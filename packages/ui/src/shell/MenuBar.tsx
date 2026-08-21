/** Barra de menús minimalista. Los dropdowns usan .popup (regla del acrílico). */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  IconAutomation,
  IconBrowser,
  IconChannelRack,
  IconClaude,
  IconClose,
  IconCollab,
  IconExport,
  IconLfo,
  IconLive,
  IconMidi,
  IconMixer,
  IconNew,
  IconOpen,
  IconPattern,
  IconPianoRoll,
  IconPlaylist,
  IconSave,
  IconSettings,
  IconTrack,
  IconGraph,
  IconWave,
} from '../icons';
import { PROJECT_TEMPLATES } from '@orbit/core';
import { repeatLastExport } from '../export';
import { store } from '../state/app';
import {
  activePattern,
  addPattern,
  canRemovePattern,
  clonePattern,
  patternClipsHint,
  removeActivePattern,
  renamePattern,
} from '../palette/default-commands';
import {
  clearRecents,
  importMidi,
  newProject,
  newProjectFromTemplate,
  openProject,
  openRecentProject,
  saveProject,
  useRecentProjects,
} from '../state/project-file';
import { LAYOUT_PRESETS, applyPreset, saveLayout } from '../state/layouts';
import { usePaletteStore } from '../palette';
import { useUiStore } from '../state/ui';
import './shell.css';

interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  separator?: boolean;
  /**
   * Marca de estado a la izquierda. Los menús que ALTERNAN algo (ventanas,
   * paneles) tienen que decir cómo está eso ahora: sin la marca, "Mixer" no
   * distingue entre abrirlo y cerrarlo hasta que lo pulsas.
   */
  checked?: boolean;
  /** Submenú: sus entradas salen a la derecha en vez de alargar el desplegable. */
  submenu?: MenuItem[];
}

/** Una entrada de submenú abierta se identifica por su índice en la lista. */
function MenuList({ items, onRun }: { items: MenuItem[]; onRun: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);

  return (
    <div className="menu-dropdown popup">
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="menu-sep" />
        ) : (
          <div
            key={item.label}
            className="menu-row"
            // El submenú se pinta DENTRO de la fila: al moverse hacia él, el
            // puntero no sale de la fila y no hay parpadeo al cruzar el hueco.
            onPointerEnter={() => setOpenSub(item.submenu ? i : null)}
          >
            <button
              className={`menu-item${item.checked ? ' checked' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.submenu) {
                  setOpenSub(openSub === i ? null : i);
                  return;
                }
                onRun();
                item.action?.();
              }}
            >
              <span className="menu-item-label">
                <span className="menu-check">{item.checked ? '✓' : ''}</span>
                <span className="menu-icon">{item.icon}</span>
                {item.label}
              </span>
              {item.submenu ? (
                <span className="menu-arrow">›</span>
              ) : (
                item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>
              )}
            </button>
            {item.submenu && openSub === i && (
              <div className="menu-sub">
                <MenuList items={item.submenu} onRun={onRun} />
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const toggleWindow = useUiStore((s) => s.toggleWindow);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Los menús se construyen en el mismo render que los abre (el clic cambia
  // `open`), así que leer los stores con getState() sale siempre fresco y no
  // hace falta suscribirse: suscribirse a `windows` repintaría esta barra a 60
  // fps mientras se arrastra una ventana, solo para poner un ✓.
  const pattern = activePattern();
  const canRemove = canRemovePattern();
  const ui = useUiStore.getState();
  const recents = useRecentProjects.getState().list;

  /** Entrada de "Ver" que abre/cierra una ventana, con su ✓ si está abierta. */
  const windowItem = (
    id: Parameters<typeof toggleWindow>[0],
    label: string,
    icon: ReactNode,
    shortcut?: string,
  ): MenuItem => ({
    label,
    icon,
    ...(shortcut ? { shortcut } : null),
    checked: ui.windows[id].open,
    action: () => toggleWindow(id),
  });

  const menus: Record<string, MenuItem[]> = {
    Archivo: [
      { label: 'Nuevo proyecto', icon: <IconNew />, shortcut: 'Ctrl+N', action: () => newProject() },
      {
        // Las plantillas eran una entrada suelta CADA UNA en el primer nivel:
        // el menú Archivo medía catorce líneas y "Abrir" quedaba enterrado.
        label: 'Nuevo desde plantilla',
        icon: <IconNew />,
        submenu: PROJECT_TEMPLATES.map((t) => ({
          label: t.name,
          action: () => newProjectFromTemplate(t.id),
        })),
      },
      { label: 'Abrir…', icon: <IconOpen />, shortcut: 'Ctrl+O', action: () => void openProject() },
      {
        label: 'Abrir reciente',
        icon: <IconOpen />,
        disabled: recents.length === 0,
        submenu: [
          ...recents.map((r) => ({
            // Un reciente que ya no está sale deshabilitado en vez de
            // desaparecer: enterarse de que el archivo se movió vale más que
            // una lista corta.
            label: r.exists ? r.name : `${r.name} (no está)`,
            disabled: !r.exists,
            action: () => void openRecentProject(r.path),
          })),
          { label: '', separator: true },
          { label: 'Vaciar la lista', action: () => void clearRecents() },
        ],
      },
      { label: '', separator: true },
      { label: 'Guardar', icon: <IconSave />, shortcut: 'Ctrl+S', action: () => void saveProject() },
      { label: 'Guardar como…', shortcut: 'Ctrl+Shift+S', action: () => void saveProject(true) },
      { label: '', separator: true },
      { label: 'Info del proyecto…', action: () => toggleWindow('projectInfo') },
      { label: '', separator: true },
      { label: 'Importar MIDI…', icon: <IconMidi />, action: () => void importMidi() },
      { label: 'Exportar…', icon: <IconExport />, action: () => toggleWindow('export') },
      {
        label: 'Repetir el último export',
        shortcut: 'Ctrl+E',
        action: () => void repeatLastExport(),
      },
      { label: '', separator: true },
      { label: 'Salir', icon: <IconClose />, action: () => void window.orbit?.window.close() },
    ],
    Editar: [
      { label: 'Deshacer', shortcut: 'Ctrl+Z', action: () => store.undo() },
      { label: 'Rehacer', shortcut: 'Ctrl+Y', action: () => store.redo() },
      { label: '', separator: true },
      { label: 'Historial…', action: () => toggleWindow('history') },
    ],
    Patrón: [
      { label: 'Nuevo patrón', icon: <IconPattern />, action: () => addPattern() },
      {
        label: pattern ? `Clonar "${pattern.name}"` : 'Clonar patrón',
        icon: <IconPattern />,
        disabled: !pattern,
        action: () => clonePattern(),
      },
      {
        label: pattern ? `Renombrar "${pattern.name}"…` : 'Renombrar patrón…',
        disabled: !pattern,
        action: () => renamePattern(),
      },
      { label: '', separator: true },
      {
        // Deshabilitado con un solo patrón: core lanza en vez de dejar el
        // proyecto sin ninguno, así que ni se ofrece.
        label: pattern
          ? `Borrar "${pattern.name}"${patternClipsHint(pattern.id)}`
          : 'Borrar el patrón activo',
        icon: <IconClose />,
        shortcut: 'Ctrl+Shift+Supr',
        disabled: !pattern || !canRemove,
        action: () => removeActivePattern(),
      },
    ],
    Ver: [
      windowItem('playlist', 'Playlist', <IconPlaylist />, 'F5'),
      windowItem('channelRack', 'Channel Rack', <IconChannelRack />, 'F6'),
      windowItem('pianoRoll', 'Piano Roll', <IconPianoRoll />, 'F7'),
      windowItem('liveView', 'Vista Live', <IconLive />, 'F8'),
      windowItem('mixer', 'Mixer', <IconMixer />, 'F9'),
      windowItem('automation', 'Automatización', <IconAutomation />),
      windowItem('lfo', 'LFOs', <IconLfo />),
      windowItem('nova', 'Orbit Nova', <IconTrack kind="keys" />),
      windowItem('prisma', 'Orbit Prisma', <IconTrack kind="synth" />),
      windowItem('channelEditor', 'Editor de sonido', <IconTrack kind="fx" />),
      windowItem('scope', 'Orbit Scope', <IconWave />),
      windowItem('graph', 'Enrutado (nodos)', <IconGraph />),
      windowItem('history', 'Historial', undefined),
      { label: '', separator: true },
      {
        label: 'Layouts',
        submenu: [
          ...LAYOUT_PRESETS.map((preset) => ({
            label: preset.name,
            action: () => applyPreset(preset.id),
          })),
          { label: '', separator: true },
          {
            label: 'Guardar el layout actual…',
            action: () => {
              const name = window.prompt('Nombre del layout', 'Mi layout');
              if (name) saveLayout(name.trim());
            },
          },
        ],
      },
      { label: '', separator: true },
      {
        label: 'Browser',
        icon: <IconBrowser />,
        checked: ui.browserOpen,
        action: () => useUiStore.setState((s) => ({ browserOpen: !s.browserOpen })),
      },
      {
        label: 'Panel de Claude',
        icon: <IconClaude />,
        checked: ui.claudePanelOpen,
        action: () => useUiStore.setState((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
      },
      { label: '', separator: true },
      windowItem('collab', 'Colaboración…', <IconCollab />),
      { label: '', separator: true },
      windowItem('settings', 'Ajustes', <IconSettings />, 'F10'),
    ],
    Ayuda: [
      {
        label: 'Acerca de Orbit Studio…',
        action: () => useUiStore.setState({ aboutOpen: true }),
      },
      { label: '', separator: true },
      {
        label: 'Paleta de comandos…',
        shortcut: 'Ctrl+K',
        action: () => usePaletteStore.getState().togglePalette(),
      },
    ],
  };

  return (
    <div className="menubar" ref={ref}>
      {Object.entries(menus).map(([name, items]) => (
        <div key={name} className="menu">
          <button
            className={`menu-btn${open === name ? ' open' : ''}`}
            onClick={() => setOpen(open === name ? null : name)}
            onPointerEnter={() => {
              if (open && open !== name) setOpen(name);
            }}
          >
            {name}
          </button>
          {open === name && <MenuList items={items} onRun={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  );
}
