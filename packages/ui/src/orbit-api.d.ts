// Tipos globales del puente preload (window.orbit).
// Copia autocontenida de la forma expuesta en apps/desktop/src/preload/index.ts
// — la UI no puede importar del preload (rompería la separación de paquetes),
// así que el tipo se duplica aquí; mantener ambos en sincronía.

type OrbitThemeId = 'dark' | 'light' | 'acrylic';

interface OrbitApi {
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
    /** Abre la carpeta de plugins en el explorador del sistema. */
    openFolder(): Promise<void>;
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
}

interface Window {
  /** Puente del preload; ausente si la UI corre fuera de Electron (vite web). */
  orbit?: OrbitApi;
}
