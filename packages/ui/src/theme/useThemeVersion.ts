// Los canvas leen los tokens del tema con getComputedStyle al dibujar, así que
// necesitan redibujarse cuando cambia el tema (data-theme o las perillas del
// customizador, que son variables inline en <html>). Este hook expone un
// contador que se incrementa con cada cambio; basta con meterlo en las deps
// del callback de dibujo.

import { useSyncExternalStore } from 'react';

let version = 0;
let observer: MutationObserver | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(() => {
      version += 1;
      for (const l of listeners) l();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style'],
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemeVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}
