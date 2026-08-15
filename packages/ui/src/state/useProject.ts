/** Hooks React sobre el ProjectStore (fuera de React: usa `store` directo). */

import { useSyncExternalStore } from 'react';
import type { Project } from '@orbit/core';
import { store } from './app';

/** Re-renderiza en cada cambio del proyecto (componentes memoizados aguas abajo). */
export function useProjectVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

export function useProject(): Project {
  useProjectVersion();
  return store.project;
}
