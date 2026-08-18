/**
 * Ventanas desacopladas: qué editores viven fuera de la ventana de Orbit
 * (en una ventana nativa del OS aparte). Vive en su propio store para no
 * mezclarse con el layout interno de ui.ts: al re-acoplar, la ventana
 * interna recupera su posición/tamaño de siempre.
 *
 * Lo que está fuera se guarda en settings.json y se vuelve a sacar al
 * arrancar: si el mixer vive en el segundo monitor, tiene que seguir ahí
 * mañana sin volver a sacarlo a mano. El SITIO de cada ventana lo recuerda el
 * main (apps/desktop/src/main/window-bounds.ts), que es quien lo sabe.
 */

import { create } from 'zustand';
import { isWindowId, useUiStore, type WindowId } from './ui';

/** Clave de settings.json con los editores que estaban fuera. */
const SETTINGS_KEY = 'detachedWindows';

interface DetachedState {
  /** true = ese editor está fuera, en una ventana nativa. */
  detached: Partial<Record<WindowId, boolean>>;
  /** Ventanas marcadas para quedarse por encima de las demás. */
  alwaysOnTop: Partial<Record<WindowId, boolean>>;
  detach: (id: WindowId) => void;
  attach: (id: WindowId) => void;
}

export const useDetachedStore = create<DetachedState>((set) => ({
  detached: {},
  alwaysOnTop: {},
  detach: (id) => set((s) => ({ detached: { ...s.detached, [id]: true } })),
  attach: (id) => set((s) => ({ detached: { ...s.detached, [id]: false } })),
}));

/** Editores fuera ahora mismo, en el orden estable de WindowId. */
function detachedIds(): WindowId[] {
  const { detached } = useDetachedStore.getState();
  return (Object.keys(detached) as WindowId[]).filter((id) => detached[id] === true);
}

/**
 * Guarda la lista tras cada cambio. Se suscribe UNA vez al store en vez de
 * escribir dentro de detach/attach: así el guardado no depende de por dónde se
 * saque la ventana (botón de la barra, la X nativa, la restauración).
 */
let lastSaved = '';
useDetachedStore.subscribe(() => {
  const ids = detachedIds();
  const key = ids.join(',');
  if (key === lastSaved) return;
  lastSaved = key;
  void window.orbit?.settings.set({ [SETTINGS_KEY]: ids });
});

/**
 * Vuelve a sacar los editores que estaban fuera la última vez (y abre su
 * ventana si estaba cerrada: un editor fuera pero "cerrado" no se vería).
 * Si el navegador bloquea la ventana emergente, DetachedWindow re-acopla solo.
 */
export async function restoreDetached(): Promise<void> {
  const settings = await window.orbit?.settings.get().catch(() => undefined);
  if (!settings) return;
  const raw = settings[SETTINGS_KEY];
  const ids = (Array.isArray(raw) ? raw : []).filter(isWindowId);
  if (ids.length === 0) {
    lastSaved = '';
    return;
  }
  // Marca lo guardado como ya escrito: restaurar no puede disparar un guardado
  // que, a medio camino, dejara la lista a medias.
  lastSaved = ids.join(',');
  const ui = useUiStore.getState();
  for (const id of ids) ui.openWindow(id);
  useDetachedStore.setState((s) => ({
    detached: { ...s.detached, ...Object.fromEntries(ids.map((id) => [id, true])) },
  }));
  await syncAlwaysOnTop(ids);
}

/**
 * Lee del main el siempre-encima de esas ventanas (lo guarda él, y él lo
 * aplica al abrirlas: sin esto el botón diría "no" con la ventana ya encima).
 */
export async function syncAlwaysOnTop(ids: WindowId[]): Promise<void> {
  const api = window.orbit?.detached;
  if (!api) return;
  const flags = await Promise.all(
    ids.map(async (id) => [id, (await api.state(id).catch(() => null))?.alwaysOnTop === true] as const),
  );
  useDetachedStore.setState((s) => ({
    alwaysOnTop: { ...s.alwaysOnTop, ...Object.fromEntries(flags) },
  }));
}

/** Deja (o quita) una ventana desacoplada siempre por encima. */
export async function setAlwaysOnTop(id: WindowId, on: boolean): Promise<void> {
  const api = window.orbit?.detached;
  // Sin puente (web/QA) el botón no puede hacer nada: no se miente al usuario.
  if (!api) return;
  const real = await api.alwaysOnTop(id, on).catch(() => on);
  useDetachedStore.setState((s) => ({ alwaysOnTop: { ...s.alwaysOnTop, [id]: real } }));
}
