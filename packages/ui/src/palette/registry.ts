/**
 * Registro de comandos de la paleta (Ctrl+K).
 * Los módulos registran PROVEEDORES (funciones que devuelven comandos), no
 * listas fijas: la paleta los evalúa al ABRIRSE, así los comandos siempre
 * reflejan el estado actual (ventanas abiertas, proyecto cargado, etc.).
 */

import { create } from 'zustand';

export interface PaletteCommand {
  /** Único, ej. "ver.mixer". */
  id: string;
  /** Título visible, ej. "Abrir el Mixer". */
  title: string;
  /** Grupo visible ("Ver", "Archivo", "Transporte", "Herramientas"...). */
  group: string;
  /** Texto extra buscable (sinónimos), opcional. */
  keywords?: string;
  /** Atajo visible (solo informativo), opcional. */
  shortcut?: string;
  run(): void;
}

/** Proveedor: devuelve los comandos vigentes en el momento de abrir la paleta. */
export type PaletteProvider = () => PaletteCommand[];

const providers = new Set<PaletteProvider>();

/** Registra un proveedor de comandos; devuelve el unregister. */
export function registerPaletteProvider(provider: PaletteProvider): () => void {
  providers.add(provider);
  return () => {
    providers.delete(provider);
  };
}

/** Todos los comandos actuales (proveedores concatenados, en orden de registro). */
export function getPaletteCommands(): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  for (const provider of providers) out.push(...provider());
  return out;
}

// ── Los últimos comandos usados ──────────────────────────────────────────────

/** Cuántos se recuerdan: los justos para que "lo de siempre" esté arriba. */
const RECENT_KEEP = 12;

let recentIds: string[] = [];

/** Ids usados, del más reciente al más viejo. */
export function recentCommands(): readonly string[] {
  return recentIds;
}

/**
 * Sube un comando al principio de la lista y la persiste.
 *
 * Va a settings.json y no al proyecto: es una costumbre de quien usa la app, no
 * algo del beat, y tiene que seguir ahí mañana. La escritura se lanza sin
 * esperar a propósito — el comando ya se ha ejecutado y la paleta no tiene por
 * qué quedarse abierta esperando al disco.
 */
export function rememberCommand(id: string): void {
  recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, RECENT_KEEP);
  void window.orbit?.settings.set({ paletteRecent: recentIds });
}

/** Carga la lista guardada. Se llama una vez al arrancar. */
export async function loadRecentCommands(): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  try {
    const raw = (await api.settings.get())['paletteRecent'];
    if (!Array.isArray(raw)) return;
    recentIds = raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_KEEP);
  } catch {
    // Sin ajustes legibles la paleta funciona igual, solo sin memoria.
  }
}

/** Estado de apertura de la paleta. El atajo global (Ctrl+K) lo cablea el orquestador. */
export interface PaletteState {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false }),
  togglePalette: () => set((s) => ({ open: !s.open })),
}));
