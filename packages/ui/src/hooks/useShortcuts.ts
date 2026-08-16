/** Atajos globales de teclado (catálogo en docs/FEATURES.md §15). */

import { useEffect } from 'react';
import { usePaletteStore } from '../palette';
import { setPlayMode, store, togglePlay } from '../state/app';
import { openProject, saveProject } from '../state/project-file';
import { useUiStore } from '../state/ui';

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (e.code === 'Space' && !typing) {
        e.preventDefault();
        void togglePlay();
        return;
      }
      // Ctrl+K abre la paleta incluso escribiendo (es su gracia).
      if (e.ctrlKey && e.code === 'KeyK') {
        e.preventDefault();
        usePaletteStore.getState().togglePalette();
        return;
      }
      if (typing) return;

      const ui = useUiStore.getState();
      if (e.ctrlKey && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault();
        store.undo();
        return;
      }
      if ((e.ctrlKey && e.code === 'KeyY') || (e.ctrlKey && e.shiftKey && e.code === 'KeyZ')) {
        e.preventDefault();
        store.redo();
        return;
      }
      if (e.ctrlKey && e.code === 'KeyO') {
        e.preventDefault();
        void openProject();
        return;
      }
      if (e.ctrlKey && e.code === 'KeyS') {
        e.preventDefault();
        void saveProject(e.shiftKey);
        return;
      }
      switch (e.code) {
        case 'F5':
          e.preventDefault();
          ui.toggleWindow('playlist');
          break;
        case 'F6':
          e.preventDefault();
          ui.toggleWindow('channelRack');
          break;
        case 'F7':
          e.preventDefault();
          ui.toggleWindow('pianoRoll');
          break;
        case 'F8':
          e.preventDefault();
          ui.toggleWindow('liveView');
          break;
        case 'F9':
          e.preventDefault();
          ui.toggleWindow('mixer');
          break;
        case 'F10':
          e.preventDefault();
          ui.toggleWindow('settings');
          break;
        case 'KeyL':
          setPlayMode(ui.playMode === 'song' ? 'pattern' : 'song');
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
