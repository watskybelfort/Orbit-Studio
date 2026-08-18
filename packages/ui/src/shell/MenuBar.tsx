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
import { importMidi, newProject, newProjectFromTemplate, openProject, saveProject } from '../state/project-file';
import { LAYOUT_PRESETS, applyPreset, saveLayout } from '../state/layouts';
import { useUiStore } from '../state/ui';
import './shell.css';

interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  action?: () => void;
  separator?: boolean;
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
  // `open`), así que leer `store.project` directo aquí sale siempre fresco: el
  // patrón que se nombra y el disabled del borrado son los de ese instante.
  const pattern = activePattern();
  const canRemove = canRemovePattern();

  const menus: Record<string, MenuItem[]> = {
    Archivo: [
      { label: 'Nuevo proyecto', icon: <IconNew />, action: () => newProject() },
      // Plantillas de género: el rack ya montado en vez de empezar en blanco.
      ...PROJECT_TEMPLATES.map((t) => ({
        label: `Nuevo: ${t.name}`,
        icon: <IconNew />,
        action: () => newProjectFromTemplate(t.id),
      })),
      { label: 'Abrir…', icon: <IconOpen />, shortcut: 'Ctrl+O', action: () => void openProject() },
      { label: 'Guardar', icon: <IconSave />, shortcut: 'Ctrl+S', action: () => void saveProject() },
      { label: 'Guardar como…', shortcut: 'Ctrl+Shift+S', action: () => void saveProject(true) },
      { label: '', separator: true },
      { label: 'Info del proyecto…', action: () => toggleWindow('projectInfo') },
      { label: '', separator: true },
      { label: 'Importar MIDI…', icon: <IconMidi />, action: () => void importMidi() },
      { label: 'Exportar…', icon: <IconExport />, action: () => toggleWindow('export') },
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
      { label: 'Playlist', icon: <IconPlaylist />, shortcut: 'F5', action: () => toggleWindow('playlist') },
      { label: 'Channel Rack', icon: <IconChannelRack />, shortcut: 'F6', action: () => toggleWindow('channelRack') },
      { label: 'Piano Roll', icon: <IconPianoRoll />, shortcut: 'F7', action: () => toggleWindow('pianoRoll') },
      { label: 'Vista Live', icon: <IconLive />, shortcut: 'F8', action: () => toggleWindow('liveView') },
      { label: 'Mixer', icon: <IconMixer />, shortcut: 'F9', action: () => toggleWindow('mixer') },
      { label: 'Automatización', icon: <IconAutomation />, action: () => toggleWindow('automation') },
      { label: 'LFOs', icon: <IconLfo />, action: () => toggleWindow('lfo') },
      { label: 'Orbit Nova', icon: <IconTrack kind="keys" />, action: () => toggleWindow('nova') },
      { label: 'Orbit Prisma', icon: <IconTrack kind="synth" />, action: () => toggleWindow('prisma') },
      { label: 'Editor de sonido', icon: <IconTrack kind="fx" />, action: () => toggleWindow('channelEditor') },
      { label: 'Orbit Scope', icon: <IconWave />, action: () => toggleWindow('scope') },
      { label: 'Enrutado (nodos)', icon: <IconGraph />, action: () => toggleWindow('graph') },
      { label: 'Historial', action: () => toggleWindow('history') },
      { label: '', separator: true },
      // Layouts: los tres predefinidos y los que el usuario guarde en el proyecto.
      ...LAYOUT_PRESETS.map((preset) => ({
        label: `Layout: ${preset.name}`,
        action: () => applyPreset(preset.id),
      })),
      {
        label: 'Guardar layout actual…',
        action: () => {
          const name = window.prompt('Nombre del layout', 'Mi layout');
          if (name) saveLayout(name.trim());
        },
      },
      { label: '', separator: true },
      {
        label: 'Browser',
        icon: <IconBrowser />,
        action: () => useUiStore.setState((s) => ({ browserOpen: !s.browserOpen })),
      },
      {
        label: 'Panel de Claude',
        icon: <IconClaude />,
        action: () => useUiStore.setState((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
      },
      { label: '', separator: true },
      { label: 'Colaboración…', icon: <IconCollab />, action: () => toggleWindow('collab') },
      { label: '', separator: true },
      { label: 'Ajustes', icon: <IconSettings />, shortcut: 'F10', action: () => toggleWindow('settings') },
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
          {open === name && (
            <div className="menu-dropdown popup">
              {items.map((item, i) =>
                item.separator ? (
                  <div key={i} className="menu-sep" />
                ) : (
                  <button
                    key={item.label}
                    className="menu-item"
                    disabled={item.disabled}
                    onClick={() => {
                      setOpen(null);
                      item.action?.();
                    }}
                  >
                    <span className="menu-item-label">
                      <span className="menu-icon">{item.icon}</span>
                      {item.label}
                    </span>
                    {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
