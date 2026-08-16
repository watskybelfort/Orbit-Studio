/** Barra de menús minimalista. Los dropdowns usan .popup (regla del acrílico). */

import { useEffect, useRef, useState } from 'react';
import { store } from '../state/app';
import { newProject, openProject, saveProject } from '../state/project-file';
import { useUiStore } from '../state/ui';
import './shell.css';

interface MenuItem {
  label: string;
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

  const menus: Record<string, MenuItem[]> = {
    Archivo: [
      { label: 'Nuevo proyecto', action: () => newProject() },
      { label: 'Abrir…', shortcut: 'Ctrl+O', action: () => void openProject() },
      { label: 'Guardar', shortcut: 'Ctrl+S', action: () => void saveProject() },
      { label: 'Guardar como…', shortcut: 'Ctrl+Shift+S', action: () => void saveProject(true) },
      { label: '', separator: true },
      { label: 'Exportar…', action: () => toggleWindow('export') },
      { label: '', separator: true },
      { label: 'Salir', action: () => void window.orbit?.window.close() },
    ],
    Editar: [
      { label: 'Deshacer', shortcut: 'Ctrl+Z', action: () => store.undo() },
      { label: 'Rehacer', shortcut: 'Ctrl+Y', action: () => store.redo() },
    ],
    Ver: [
      { label: 'Playlist', shortcut: 'F5', action: () => toggleWindow('playlist') },
      { label: 'Channel Rack', shortcut: 'F6', action: () => toggleWindow('channelRack') },
      { label: 'Piano Roll', shortcut: 'F7', action: () => toggleWindow('pianoRoll') },
      { label: 'Mixer', shortcut: 'F9', action: () => toggleWindow('mixer') },
      { label: '', separator: true },
      {
        label: 'Browser',
        action: () => useUiStore.setState((s) => ({ browserOpen: !s.browserOpen })),
      },
      {
        label: 'Panel de Claude',
        action: () => useUiStore.setState((s) => ({ claudePanelOpen: !s.claudePanelOpen })),
      },
      { label: '', separator: true },
      { label: 'Ajustes', shortcut: 'F10', action: () => toggleWindow('settings') },
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
                    <span>{item.label}</span>
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
