/** Hooks React sobre el ProjectStore (fuera de React: usa `store` directo). */

import { useSyncExternalStore } from 'react';
import type { Project } from '@orbit/core';
import { store } from './app';

/** Re-renderiza en cada cambio del proyecto (componentes memoizados aguas abajo). */
export function useProjectVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

// El store muta el proyecto EN SITIO y solo bumpa la versión; si useProject
// devolviera store.project tal cual, `[project]` como dep de useMemo/useEffect
// nunca invalidaría nada. Por eso aquí se entrega un clon superficial NUEVO por
// versión (cacheado: misma referencia mientras no haya comandos).
// Contrato: usa `[project]` como dep — NUNCA subobjetos (`project.clips` sigue
// siendo la misma referencia mutada entre versiones).
let cachedVersion = -1;
let cachedSnapshot: Project | null = null;

export function useProject(): Project {
  const version = useProjectVersion();
  if (version !== cachedVersion || cachedSnapshot === null) {
    cachedVersion = version;
    cachedSnapshot = { ...store.project };
  }
  return cachedSnapshot;
}
