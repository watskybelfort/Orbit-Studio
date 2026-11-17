/**
 * El gesto de un conector de pista de la Playlist: clic = su acción de siempre
 * (el LED verde silencia; la etiqueta de destino abre el Mixer), arrastre =
 * sacar un cable y soltarlo sobre un canal del Mixer (ver `state/route-cable.ts`).
 *
 * El umbral de 5 px separa los dos: un clic con el pulso un poco movido sigue
 * siendo un clic, no un cable que no se pidió.
 */
import type { Id } from '@orbit/core';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { notifyBanner } from '../../state/bounce';
import { store } from '../../state/app';
import {
  beginCableDrag,
  cancelCableDrag,
  endCableDrag,
  mixerInsertOf,
  mixerTargetLabel,
  moveCable,
  useRouteCable,
} from '../../state/route-cable';
import { useUiStore } from '../../state/ui';
import { capturePointer } from '../../widgets/pointer';

/** Px de movimiento a partir de los cuales un clic pasa a ser un cable. */
export const CABLE_DRAG_PX = 5;

/** Conecta el audio de la pista `trackId` al canal `index` del Mixer (un undo). */
export function connectTrackToMixer(trackId: Id, index: number): void {
  const project = store.project;
  const track = project.playlistTracks[trackId];
  if (!track || index < 0 || index >= project.mixer.length) return;
  const label = mixerTargetLabel(index, project.mixer[index]?.name);
  if ((track.mixerTrack ?? 0) !== index) {
    store.dispatch(
      { type: 'patchPlaylistTrack', trackId, patch: { mixerTrack: index } },
      { label: `Conectar "${track.name}" a ${label}` },
    );
  }
  notifyBanner(`«${track.name}» suena por ${label}`);
}

const pickAt = (x: number, y: number) => mixerInsertOf(document.elementFromPoint(x, y));

export interface JackTrack {
  id: Id;
  name: string;
  color: string;
}

/**
 * Manejadores de puntero para un conector. `onClick` es la acción sin arrastre.
 * El estado del gesto vive en un ref: la cabecera se vuelve a pintar a mitad
 * del arrastre (abrir el Mixer lo provoca) y unos manejadores nuevos con el
 * estado a cero soltarían el cable.
 */
export function useJack(track: JackTrack, onClick: () => void) {
  const g = useRef<{ start: { x: number; y: number } | null; dragging: boolean }>({ start: null, dragging: false });
  const cancel = () => {
    const dragged = g.current.dragging;
    g.current = { start: null, dragging: false };
    if (dragged) cancelCableDrag();
  };
  return {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      capturePointer(e.currentTarget, e.pointerId);
      g.current = { start: { x: e.clientX, y: e.clientY }, dragging: false };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const { start } = g.current;
      if (!start) return;
      if (!g.current.dragging) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < CABLE_DRAG_PX) return;
        g.current.dragging = true;
        // Abierto Y al frente: abierto detrás de la Playlist, el cable caería
        // sobre la Playlist y no habría canal donde soltarlo (medido en la app).
        useUiStore.getState().openWindow('mixer');
        const r = e.currentTarget.getBoundingClientRect();
        beginCableDrag({
          trackId: track.id,
          trackName: track.name,
          color: track.color,
          x0: r.left + r.width / 2,
          y0: r.top + r.height / 2,
        });
      }
      moveCable(e.clientX, e.clientY, pickAt);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => {
      if (!g.current.start) return;
      const dragged = g.current.dragging;
      g.current = { start: null, dragging: false };
      if (!dragged) {
        onClick();
        return;
      }
      // Lo que haya bajo el cursor al SOLTAR (puede no haber habido un move ahí).
      moveCable(e.clientX, e.clientY, pickAt);
      const target = endCableDrag();
      if (target !== null) connectTrackToMixer(track.id, target);
    },
    onPointerCancel: () => cancel(),
    // Captura perdida sin pointerup (otra ventana se llevó el foco): sin esto
    // el cable quedaría colgando de la pantalla.
    onLostPointerCapture: () => cancel(),
    /** Teclado (Enter/Espacio): `detail === 0`. El ratón ya lo resolvió en pointerup. */
    onClick: (e: { detail: number }) => {
      if (e.detail === 0) onClick();
    },
  };
}

export { useRouteCable };
