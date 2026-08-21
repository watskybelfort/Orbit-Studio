/** Atajos globales de teclado (catálogo en docs/FEATURES.md §15). */

import { useEffect } from 'react';
import { repeatLastExport } from '../export';
import { usePaletteStore } from '../palette';
import { removeActivePattern } from '../palette/default-commands';
import { setPlayMode, store, togglePlay } from '../state/app';
import { activeEditActions } from '../state/edit-focus';
import { newProject, openProject, saveProject } from '../state/project-file';
import { useUiStore } from '../state/ui';

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // SELECT también cuenta: con un desplegable enfocado (el sidechain del
      // compresor, el formato del export…), el espacio lo abre y las letras
      // saltan a una opción. Sin esta guarda, el espacio arrancaba la
      // reproducción y la lista no llegaba a abrirse nunca.
      const tag = target.tagName;
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;

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
      // Ctrl+Shift+Supr: borra el patrón activo (con sus notas y sus clips).
      // Lleva los dos modificadores a propósito: Supr a secas ya borra la
      // selección de notas en el Piano Roll y no se le pisa. Aquí arriba ya
      // hemos salido si se estaba escribiendo en un campo de texto.
      if (e.ctrlKey && e.shiftKey && e.code === 'Delete') {
        e.preventDefault();
        removeActivePattern();
        return;
      }
      /*
       * Portapapeles: van AQUÍ y no en cada editor a propósito.
       *
       * El Piano Roll y la Playlist están abiertos a la vez casi siempre; con
       * un listener por editor, un Ctrl+V pegaba en los dos. El árbitro de
       * `edit-focus` decide de quién es el turno (el último que se tocó) y
       * aquí solo se le pide la acción. Si no hay ninguno en juego, la tecla
       * se deja pasar: puede ser el copiar del navegador.
       */
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        const edit = e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV'
          ? activeEditActions()
          : null;
        if (edit !== null) {
          if (e.code === 'KeyC') {
            e.preventDefault();
            edit.copy();
            return;
          }
          if (e.code === 'KeyX') {
            e.preventDefault();
            edit.cut();
            return;
          }
          if (e.code === 'KeyV') {
            e.preventDefault();
            edit.paste();
            return;
          }
        }
      }
      // Ctrl+E: repite el último export sin diálogo (sufijo incremental).
      if (e.ctrlKey && e.code === 'KeyE') {
        e.preventDefault();
        void repeatLastExport();
        return;
      }
      // Ctrl+N: proyecto nuevo. Pregunta antes si hay cambios sin guardar.
      if (e.ctrlKey && !e.shiftKey && e.code === 'KeyN') {
        e.preventDefault();
        newProject();
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
