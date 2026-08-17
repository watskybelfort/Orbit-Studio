/**
 * Layouts de ventanas: la disposición del escritorio, guardada CON el proyecto.
 *
 * El modelo ya tiene el hueco (`Project.layouts`: nombre → ventana → caja) y el
 * comando `setLayout` con su inverso, así que guardar y borrar layouts pasa por
 * el bus como cualquier otra edición: entra en el undo y viaja por collab.
 *
 * Lo que NO va al modelo es el estado vivo de las ventanas — ese vive en
 * `useUiStore` (es UI, no proyecto). Aquí se hace el puente en los dos
 * sentidos: `captureLayout()` fotografía el escritorio y `applyLayoutWindows()`
 * lo vuelve a montar con `useUiStore.setState`.
 *
 * Dos detalles de contrato:
 * 1. Un layout describe el escritorio ENTERO: lo que no menciona se cierra
 *    (conservando su geometría para la próxima vez que se abra). Así aplicar
 *    "Mezclar" da siempre el mismo escritorio, vengas de donde vengas.
 * 2. Además de las ventanas, el layout guarda dos claves "pseudo-ventana" para
 *    los paneles fijos del shell (navegador y panel de Claude), que no son
 *    ventanas pero sí forman parte de la disposición. El modelo solo transporta
 *    las claves: es la UI la que decide cuáles usa.
 */

import type { LayoutWindow, Project } from '@orbit/core';
import { store } from './app';
import { useUiStore, type WindowId, type WindowState } from './ui';

/** Paneles fijos del shell dentro del layout (no son ventanas internas). */
export const BROWSER_KEY = 'browser';
export const CLAUDE_KEY = 'claudePanel';

/** Margen del escritorio para los predefinidos. */
const GAP = 12;

// ── Capturar / aplicar ───────────────────────────────────────────────────────

/** Fotografía el escritorio actual (sin el z-order: se recalcula al aplicar). */
export function captureLayout(): Record<string, LayoutWindow> {
  const ui = useUiStore.getState();
  const out: Record<string, LayoutWindow> = {};
  for (const [id, w] of Object.entries(ui.windows)) {
    out[id] = { open: w.open, x: w.x, y: w.y, w: w.w, h: w.h };
  }
  out[BROWSER_KEY] = panelFlag(ui.browserOpen);
  out[CLAUDE_KEY] = panelFlag(ui.claudePanelOpen);
  return out;
}

/**
 * Monta un layout en el escritorio. Las ventanas abiertas se apilan en el orden
 * en que aparecen en el layout, así que la última mandada queda al frente.
 */
export function applyLayoutWindows(windows: Record<string, LayoutWindow>): void {
  const ui = useUiStore.getState();
  const next: Record<WindowId, WindowState> = { ...ui.windows };
  let z = 0;

  for (const id of Object.keys(next) as WindowId[]) {
    const box = windows[id];
    if (!box) {
      next[id] = { ...next[id], open: false };
      continue;
    }
    next[id] = {
      ...next[id],
      open: box.open,
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      // Solo se renumera lo visible; lo cerrado conserva su z (invisible da igual).
      z: box.open ? ++z : next[id].z,
    };
  }

  const browser = windows[BROWSER_KEY];
  const claude = windows[CLAUDE_KEY];
  useUiStore.setState({
    windows: next,
    topZ: Math.max(z, 1),
    ...(browser ? { browserOpen: browser.open } : null),
    ...(claude ? { claudePanelOpen: claude.open } : null),
  });
}

// ── Layouts guardados en el proyecto ─────────────────────────────────────────

/** Los nombres que tiene guardados el proyecto, en orden alfabético. */
export function listLayouts(project: Project = store.project): string[] {
  return Object.keys(project.layouts ?? {}).sort((a, b) => a.localeCompare(b, 'es'));
}

/** Guarda (o pisa) un layout con el escritorio de ahora mismo. */
export function saveLayout(name: string): boolean {
  const clean = name.trim();
  if (clean === '') return false;
  store.dispatch({ type: 'setLayout', name: clean, windows: captureLayout() });
  return true;
}

/** Aplica un layout guardado del proyecto. false si ese nombre no existe. */
export function applyLayout(name: string): boolean {
  const windows = store.project.layouts?.[name];
  if (!windows) return false;
  applyLayoutWindows(windows);
  return true;
}

/** Borra un layout guardado (deshacer lo devuelve: el inverso lo restaura). */
export function deleteLayout(name: string): boolean {
  if (!store.project.layouts?.[name]) return false;
  store.dispatch({ type: 'setLayout', name, windows: null });
  return true;
}

// ── Predefinidos ─────────────────────────────────────────────────────────────

/** Tamaño útil del escritorio (`.workspace`), en píxeles. */
export interface LayoutArea {
  w: number;
  h: number;
}

export interface LayoutPreset {
  id: string;
  name: string;
  hint: string;
  /**
   * Se construye con el tamaño real del escritorio: un predefinido con píxeles
   * fijos se ve ridículo en una pantalla grande y se sale en una pequeña.
   */
  build: (area: LayoutArea) => Record<string, LayoutWindow>;
}

/**
 * Tres arranques que cubren el flujo real: componer la idea, arreglar el tema y
 * mezclarlo. No hace falta haber guardado nada para usarlos.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'componer',
    name: 'Componer',
    hint: 'Rack a la izquierda y piano roll grande al lado.',
    build: (area) => {
      const rackW = clamp(Math.round(area.w * 0.3), 320, 460);
      const h = area.h - GAP * 2;
      return {
        channelRack: box(GAP, GAP, rackW, h),
        pianoRoll: box(GAP * 2 + rackW, GAP, area.w - rackW - GAP * 3, h),
        [BROWSER_KEY]: panelFlag(true),
        [CLAUDE_KEY]: panelFlag(false),
      };
    },
  },
  {
    id: 'mezclar',
    name: 'Mezclar',
    hint: 'Playlist arriba y mixer a lo ancho abajo.',
    build: (area) => {
      const w = area.w - GAP * 2;
      const topH = Math.round((area.h - GAP * 3) * 0.46);
      return {
        playlist: box(GAP, GAP, w, topH),
        mixer: box(GAP, GAP * 2 + topH, w, area.h - topH - GAP * 3),
        // Sin navegador: el mixer agradece cada píxel de ancho.
        [BROWSER_KEY]: panelFlag(false),
        [CLAUDE_KEY]: panelFlag(false),
      };
    },
  },
  {
    id: 'arreglar',
    name: 'Arreglar',
    hint: 'Playlist a pantalla completa con el navegador de samples.',
    build: (area) => ({
      playlist: box(GAP, GAP, area.w - GAP * 2, area.h - GAP * 2),
      [BROWSER_KEY]: panelFlag(true),
      [CLAUDE_KEY]: panelFlag(false),
    }),
  },
];

/** Aplica un predefinido por su id. false si ese id no existe. */
export function applyPreset(id: string): boolean {
  const preset = LAYOUT_PRESETS.find((p) => p.id === id);
  if (!preset) return false;
  applyLayoutWindows(preset.build(workspaceArea()));
  return true;
}

/** Guarda un predefinido en el proyecto con su nombre (para retocarlo luego). */
export function savePresetAs(id: string, name?: string): boolean {
  const preset = LAYOUT_PRESETS.find((p) => p.id === id);
  if (!preset) return false;
  store.dispatch({
    type: 'setLayout',
    name: (name ?? preset.name).trim(),
    windows: preset.build(workspaceArea()),
  });
  return true;
}

// ── Utilidades ───────────────────────────────────────────────────────────────

/**
 * El escritorio real. Antes del primer render (o en tests sin DOM) cae a un
 * tamaño de portátil razonable: mejor un layout algo apretado que uno a cero.
 */
export function workspaceArea(): LayoutArea {
  if (typeof document !== 'undefined') {
    const el = document.querySelector('.workspace');
    if (el instanceof HTMLElement && el.clientWidth > 0 && el.clientHeight > 0) {
      return { w: el.clientWidth, h: el.clientHeight };
    }
  }
  return { w: 1400, h: 780 };
}

function box(x: number, y: number, w: number, h: number): LayoutWindow {
  return { open: true, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** Pseudo-ventana: de los paneles del shell solo importa si están abiertos. */
function panelFlag(open: boolean): LayoutWindow {
  return { open, x: 0, y: 0, w: 0, h: 0 };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
