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
}

interface Window {
  /** Puente del preload; ausente si la UI corre fuera de Electron (vite web). */
  orbit?: OrbitApi;
}
