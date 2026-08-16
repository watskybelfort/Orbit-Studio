/**
 * Ventanas desacopladas: qué editores viven fuera de la ventana de Orbit
 * (en una ventana nativa del OS aparte). Vive en su propio store para no
 * mezclarse con el layout interno de ui.ts: al re-acoplar, la ventana
 * interna recupera su posición/tamaño de siempre.
 */

import { create } from 'zustand';
import type { WindowId } from './ui';

interface DetachedState {
  /** true = ese editor está fuera, en una ventana nativa. */
  detached: Partial<Record<WindowId, boolean>>;
  detach: (id: WindowId) => void;
  attach: (id: WindowId) => void;
}

export const useDetachedStore = create<DetachedState>((set) => ({
  detached: {},
  detach: (id) => set((s) => ({ detached: { ...s.detached, [id]: true } })),
  attach: (id) => set((s) => ({ detached: { ...s.detached, [id]: false } })),
}));
