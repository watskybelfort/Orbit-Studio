import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// API del puente main⇄renderer. Si cambias esta forma, actualiza también la
// copia autocontenida de `packages/ui/src/orbit-api.d.ts` (deben ir a la par).

export type OrbitThemeId = 'dark' | 'light' | 'acrylic';

/** Estado del servidor de colaboración que la app arranca en su propio proceso. */
export interface OrbitServerStatus {
  running: boolean;
  port?: number;
  /** Dirección en la que escucha de verdad (127.0.0.1, 0.0.0.0 o una IP concreta). */
  host?: string;
  roomCapacity?: number;
  openToNetwork?: boolean;
  /** La dirección que hay que darle a los demás. */
  shareAddress?: string;
  /** false si la IP elegida ya no existe y hubo que quedarse en local. */
  hostHonored?: boolean;
}

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
  /** Ventanas desacopladas (un editor fuera, en su ventana nativa). */
  readonly detached: {
    /** Estado guardado de esa ventana (para pintar su barra al abrirla). */
    state(id: string): Promise<{ alwaysOnTop: boolean }>;
    /** Deja (o quita) esa ventana siempre encima; devuelve el estado real. */
    alwaysOnTop(id: string, on: boolean): Promise<boolean>;
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
  readonly claude: {
    /** Tool calls entrantes del puente MCP (main); devuelve desuscripción. */
    onToolCall(cb: (req: { id: string; tool: string; args: unknown }) => void): () => void;
    /** Responde una tool call por id (el main la re-emite al canal por-id). */
    sendToolResult(id: string, result: { text: string } | { error: string }): void;
    /** Conexión del cliente MCP (para el indicador del panel de Claude). */
    onBridgeStatus(cb: (s: { connected: boolean }) => void): () => void;
  };
  readonly file: {
    /** Diálogo de guardado (filtro WAV); null si el usuario cancela. */
    saveDialog(defaultName: string): Promise<string | null>;
    /** Escribe bytes en una ruta permitida (elegida en diálogo o carpeta de usuario). */
    write(path: string, data: Uint8Array): Promise<void>;
  };
  readonly library: {
    /** JSON del manifest del pack de fábrica; null si aún no está generado. */
    manifest(): Promise<string | null>;
    /** Bytes de un archivo del pack (ruta relativa tal como viene en el manifest). */
    read(file: string): Promise<ArrayBuffer>;
  };
  /** Packs generados en la propia app (los que pide Claude). */
  readonly pack: {
    /** Escribe un pack en userData/packs/<slug>/ (WAVs + manifest.json). */
    save(
      slug: string,
      files: { path: string; data: Uint8Array }[],
    ): Promise<{ slug: string; dir: string; files: number }>;
    /** Todos los packs generados, con su manifest en crudo. */
    list(): Promise<{ slug: string; manifest: string }[]>;
    /** Bytes de un archivo, con la ruta `<pack>/<archivo>` del manifest. */
    read(file: string): Promise<ArrayBuffer>;
    /** Borra un pack entero del disco. */
    remove(slug: string): Promise<boolean>;
    /** Abre su carpeta en el explorador. */
    reveal(slug: string): Promise<void>;
  };
  /** Versiones del proyecto (instantáneas con nombre, para mirar atrás). */
  readonly versions: {
    /** Guarda el proyecto serializado como versión; devuelve su archivo. */
    save(projectId: string, label: string, json: string): Promise<string>;
    /** Versiones de ese proyecto, de la más reciente a la más vieja. */
    list(projectId: string): Promise<{ file: string; at: number; bytes: number }[]>;
    read(projectId: string, file: string): Promise<string>;
    remove(projectId: string, file: string): Promise<boolean>;
  };
  readonly project: {
    /** Diálogo de apertura .orbit; null si el usuario cancela. */
    open(): Promise<{ path: string; json: string } | null>;
    /** Guarda el JSON; con path null abre "guardar como". Devuelve la ruta o null. */
    save(path: string | null, json: string, suggestedName?: string): Promise<string | null>;
  };
  readonly midi: {
    /** Diálogo de apertura .mid; null si el usuario cancela. */
    open(): Promise<{ name: string; data: ArrayBuffer } | null>;
  };
  readonly folder: {
    /** Diálogo de carpeta; null si el usuario cancela. */
    pick(): Promise<string | null>;
    /** Archivos de audio de una carpeta registrada (recursivo, con límite). */
    scan(dir: string): Promise<{ file: string; name: string }[]>;
    /** Bytes de un archivo dentro de una carpeta registrada. */
    read(file: string): Promise<ArrayBuffer>;
    /**
     * Mete en la lista blanca una carpeta recién elegida con `pick()`. No va por
     * `settings.set` a propósito: esa lista es la guarda de `scan`/`read`, y no
     * la puede escribir quien tiene que cumplirla. Devuelve la lista resultante.
     */
    register(dir: string): Promise<string[]>;
    /** La saca de la lista blanca. Devuelve la lista resultante. */
    forget(dir: string): Promise<string[]>;
  };
  readonly recording: {
    /** Guarda una toma en userData/recordings; devuelve el nombre de archivo. */
    save(name: string, data: Uint8Array): Promise<string>;
    /** Bytes de una toma guardada (solo dentro de la carpeta de grabaciones). */
    read(file: string): Promise<ArrayBuffer>;
  };
  readonly plugins: {
    /** Lista los .js de userData/plugins (crea la carpeta si no existe). */
    scan(): Promise<{ id: string; name: string; source: string }[]>;
    /** Escribe un plugin en la carpeta de usuario (nombre saneado). */
    write(file: string, source: string): Promise<string>;
    /** Borra un plugin de la carpeta de usuario. */
    remove(file: string): Promise<boolean>;
    /** Abre la carpeta de plugins en el explorador del sistema. */
    openFolder(): Promise<void>;
  };
  /** Galería de plugins: el main baja el texto (el renderer no sale a la red). */
  readonly gallery: {
    fetch(url: string): Promise<string>;
  };
  readonly autosave: {
    /** Guarda el estado como pendiente y rota el anillo de backups. */
    write(json: string): Promise<void>;
    /** Borra el pendiente (tras guardado manual o al descartar la recuperación). */
    clear(): Promise<void>;
    /** Pendiente de una sesión anterior, o null si no hay nada que recuperar. */
    check(): Promise<{ json: string; mtimeMs: number } | null>;
  };
  readonly debug: {
    /** Solo QA: siempre-encima para capturas (el main solo lo atiende con ORBIT_DEBUG_PORT). */
    alwaysOnTop(on: boolean): Promise<void>;
  };
  readonly server: {
    /** Estado del servidor de colaboración arrancado en proceso. */
    status(): Promise<OrbitServerStatus>;
    /** IPv4 de esta máquina, etiquetadas, para elegir dónde escuchar. */
    interfaces(): Promise<{ address: string; label: string }[]>;
    /**
     * Arranca el servidor donde diga `collabServerHost` en settings.json (solo
     * esta máquina si no hay nada elegido); devuelve el estado o un error.
     */
    start(): Promise<OrbitServerStatus & { error?: string }>;
    /** Detiene el servidor y libera el puerto. */
    stop(): Promise<{ running: boolean }>;
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
  detached: {
    state: (id) => ipcRenderer.invoke('detached:state', id),
    alwaysOnTop: (id, on) => ipcRenderer.invoke('detached:always-on-top', id, on),
  },
  theme: {
    apply: (theme) => ipcRenderer.invoke('theme:apply', theme),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  claude: {
    onToolCall: (cb) => {
      const listener = (
        _event: IpcRendererEvent,
        req: { id: string; tool: string; args: unknown },
      ) => cb(req);
      ipcRenderer.on('claude:tool-call', listener);
      return () => ipcRenderer.removeListener('claude:tool-call', listener);
    },
    sendToolResult: (id, result) => ipcRenderer.send('claude:tool-result', id, result),
    onBridgeStatus: (cb) => {
      const listener = (_event: IpcRendererEvent, s: { connected: boolean }) => cb(s);
      ipcRenderer.on('claude:bridge-status', listener);
      return () => ipcRenderer.removeListener('claude:bridge-status', listener);
    },
  },
  file: {
    saveDialog: (defaultName) => ipcRenderer.invoke('file:save-dialog', defaultName),
    write: (path, data) => ipcRenderer.invoke('file:write', path, data),
  },
  library: {
    manifest: () => ipcRenderer.invoke('library:manifest'),
    read: (file) => ipcRenderer.invoke('library:read', file),
  },
  pack: {
    save: (slug, files) => ipcRenderer.invoke('pack:save', slug, files),
    list: () => ipcRenderer.invoke('pack:list'),
    read: (file) => ipcRenderer.invoke('pack:read', file),
    remove: (slug) => ipcRenderer.invoke('pack:remove', slug),
    reveal: (slug) => ipcRenderer.invoke('pack:reveal', slug),
  },
  versions: {
    save: (projectId, label, json) => ipcRenderer.invoke('version:save', projectId, label, json),
    list: (projectId) => ipcRenderer.invoke('version:list', projectId),
    read: (projectId, file) => ipcRenderer.invoke('version:read', projectId, file),
    remove: (projectId, file) => ipcRenderer.invoke('version:remove', projectId, file),
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    save: (path, json, suggestedName) =>
      ipcRenderer.invoke('project:save', path, json, suggestedName),
  },
  midi: {
    open: () => ipcRenderer.invoke('midi:open'),
  },
  folder: {
    pick: () => ipcRenderer.invoke('folder:pick'),
    scan: (dir) => ipcRenderer.invoke('folder:scan', dir),
    read: (file) => ipcRenderer.invoke('folder:read', file),
    register: (dir) => ipcRenderer.invoke('folder:register', dir),
    forget: (dir) => ipcRenderer.invoke('folder:forget', dir),
  },
  recording: {
    save: (name, data) => ipcRenderer.invoke('recording:save', name, data),
    read: (file) => ipcRenderer.invoke('recording:read', file),
  },
  plugins: {
    scan: () => ipcRenderer.invoke('plugins:scan'),
    write: (file, source) => ipcRenderer.invoke('plugins:write', file, source),
    remove: (file) => ipcRenderer.invoke('plugins:remove', file),
    openFolder: () => ipcRenderer.invoke('plugins:open-folder'),
  },
  gallery: {
    fetch: (url) => ipcRenderer.invoke('gallery:fetch', url),
  },
  autosave: {
    write: (json) => ipcRenderer.invoke('autosave:write', json),
    clear: () => ipcRenderer.invoke('autosave:clear'),
    check: () => ipcRenderer.invoke('autosave:check'),
  },
  debug: {
    alwaysOnTop: (on) => ipcRenderer.invoke('debug:always-on-top', on),
  },
  server: {
    status: () => ipcRenderer.invoke('server:status'),
    interfaces: () => ipcRenderer.invoke('server:interfaces'),
    start: () => ipcRenderer.invoke('server:start'),
    stop: () => ipcRenderer.invoke('server:stop'),
  },
};

contextBridge.exposeInMainWorld('orbit', api);
