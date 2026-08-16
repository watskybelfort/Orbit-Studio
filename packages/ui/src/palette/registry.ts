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
