import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// API del puente main⇄renderer. Si cambias esta forma, actualiza también la
// copia autocontenida de `packages/ui/src/orbit-api.d.ts` (deben ir a la par).

export type OrbitThemeId = 'dark' | 'light' | 'acrylic';

export interface OrbitApi {
  readonly version: string;
  readonly window: {
    minimize(): Promise<void>;
    /** Alterna maximizar/restaurar; devuelve el estado resultante. */
    maximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    /** Suscribe a cambios de maximizado; devuelve la función para desuscribir. */
    onMaximizedChanged(cb: (isMaximized: boolean) => void): () => void;
  };
  readonly theme: {
    /** Conmuta el material de la ventana; informa si el acrílico quedó activo. */
    apply(theme: OrbitThemeId): Promise<{ acrylicAvailable: boolean }>;
  };
  readonly settings: {
    get(): Promise<Record<string, unknown>>;
    /** Merge superficial sobre settings.json; devuelve el resultado. */
    set(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}

const api: OrbitApi = {
  version: '0.1.0',
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChanged: (cb) => {
      const listener = (_event: IpcRendererEvent, isMaximized: boolean) => cb(isMaximized);
      ipcRenderer.on('window:maximized-changed', listener);
      return () => ipcRenderer.removeListener('window:maximized-changed', listener);
    },
  },
  theme: {
    apply: (theme) => ipcRenderer.invoke('theme:apply', theme),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
};

contextBridge.exposeInMainWorld('orbit', api);
