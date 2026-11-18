/**
 * Pedir un nombre sin `window.prompt` (Electron 43 lo lanza: «prompt() is not
 * supported») y sin obligar a quien lo pide a ser un componente React.
 *
 * La parte pura —normalizar y validar— vive aquí junto a un store de zustand
 * mínimo; el dibujo vive en `NameDialog.tsx`, y `App` monta UN
 * `<NameDialogHost />` que escucha este store. Así el menú, el Browser, la
 * paleta o un editor pueden pedir un nombre con `askName()` y todos usan el
 * mismo diálogo.
 *
 * **Política de concurrencia: gana la última petición.** Si ya hay un diálogo
 * abierto y llega otro `askName`, el anterior se resuelve con `null` (como si
 * se hubiera cancelado) y se abre el nuevo. Se elige sobre la cola porque dos
 * peticiones a la vez en esta app son un doble clic/una carrera, no un flujo
 * de dos pasos: encolar dejaría al usuario escribiendo un nombre para una
 * acción que ya decidió antes de la segunda, sin verlo.
 *
 * Sin DOM y sin React: los tests ejercitan el store tal cual.
 */

import { create } from 'zustand';

/** Largo máximo de un nombre (medido después de recortar espacios). */
export const MAX_DIALOG_NAME_LENGTH = 80;

/**
 * Recorta y valida. `null` significa «no hay nombre que confirmar»: vacío,
 * solo espacios o cualquier cosa que no sea un string. Lo que pasa del límite
 * se recorta en vez de rechazarse — pegar una ruta larga no debe perder el
 * diálogo entero.
 */
export function normalizeDialogName(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_DIALOG_NAME_LENGTH);
}

export interface AskNameOptions {
  title: string;
  label?: string;
  initial?: string;
  confirmLabel?: string;
  /** Devuelve un mensaje de error, o null si el nombre vale. */
  validate?: (name: string) => string | null;
}

/** Una petición viva: los datos para pintar y el resolvedor de su promesa. */
export interface NameDialogRequest {
  id: number;
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  validate?: (name: string) => string | null;
  resolve: (name: string | null) => void;
}

interface NameDialogState {
  request: NameDialogRequest | null;
  /** Abre el diálogo; resuelve `null` el anterior si ya había uno. */
  open: (options: AskNameOptions) => Promise<string | null>;
  /**
   * Confirma con el texto tal como está (normaliza y valida aquí). Devuelve el
   * mensaje de error si no se pudo cerrar, o `null` si el diálogo se cerró y la
   * promesa quedó resuelta.
   */
  confirm: (raw: string) => string | null;
  /** Cancela el diálogo vivo y resuelve su promesa con `null`. */
  cancel: () => void;
}

let nextRequestId = 0;

export const useNameDialogStore = create<NameDialogState>((set, get) => ({
  request: null,

  open: (options) =>
    new Promise<string | null>((resolve) => {
      const previous = get().request;
      if (previous) previous.resolve(null);
      set({
        request: {
          id: ++nextRequestId,
          title: options.title,
          label: options.label ?? 'Nombre',
          initial: options.initial ?? '',
          confirmLabel: options.confirmLabel ?? 'Guardar',
          ...(options.validate ? { validate: options.validate } : null),
          resolve,
        },
      });
    }),

  confirm: (raw) => {
    const request = get().request;
    if (!request) return 'No hay ningún diálogo abierto.';
    const normalized = normalizeDialogName(raw);
    if (normalized === null) return 'Escribe un nombre.';
    const error = request.validate?.(normalized) ?? null;
    if (error !== null) return error;
    set({ request: null });
    request.resolve(normalized);
    return null;
  },

  cancel: () => {
    const request = get().request;
    if (!request) return;
    set({ request: null });
    request.resolve(null);
  },
}));

/**
 * Pide un nombre. Resuelve `null` si se cancela (Esc, clic en el fondo,
 * Cancelar o una petición posterior) y el nombre YA normalizado si se confirma.
 */
export function askName(options: AskNameOptions): Promise<string | null> {
  return useNameDialogStore.getState().open(options);
}
