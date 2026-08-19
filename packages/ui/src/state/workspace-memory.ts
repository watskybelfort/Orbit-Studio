/**
 * Memoria del escritorio: las ventanas vuelven a salir donde las dejaste.
 *
 * Ojo con la diferencia respecto a `state/layouts.ts`, que ya existía: aquel
 * guarda layouts CON NOMBRE dentro del proyecto (van por el bus, entran en el
 * undo y viajan por la sala). Esto es otra cosa — es la disposición de trabajo
 * de ESTA máquina, que no es del proyecto y no tiene por qué viajar a la de
 * nadie: por eso vive en settings.json, como el tema o las ventanas
 * desacopladas. Abrir un .orbit de otro no te reordena el escritorio.
 *
 * Se guarda con retardo porque durante un arrastre el store cambia a 60 fps y
 * escribir el settings.json en cada frame sería absurdo.
 */

import type { LayoutWindow } from '@orbit/core';
import { applyLayoutWindows, captureLayout, workspaceArea, BROWSER_KEY, CLAUDE_KEY } from './layouts';
import { useUiStore, isWindowId } from './ui';

/** Clave de settings.json con la disposición de la última sesión. */
const SETTINGS_KEY = 'workspaceLayout';
/** Clave de settings.json para apagar la memoria (por defecto está encendida). */
export const REMEMBER_KEY = 'rememberWorkspace';

/** Retardo de guardado tras el último cambio, en ms. */
const SAVE_DEBOUNCE_MS = 700;

/** Mínimos de una ventana interna (los de InternalWindow). */
const MIN_W = 320;
const MIN_H = 200;
/** Píxeles de ventana que se garantizan dentro del escritorio al restaurar. */
const KEEP_VISIBLE = 80;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Valida una caja venida de settings.json (que es un archivo de texto que
 * cualquiera puede editar, y que además puede venir de una sesión con OTRO
 * monitor). Devuelve null si no hay caja que valga.
 */
function parseBox(raw: unknown): LayoutWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const x = num(o['x']);
  const y = num(o['y']);
  const w = num(o['w']);
  const h = num(o['h']);
  if (x === null || y === null || w === null || h === null) return null;
  return { open: o['open'] === true, x, y, w, h };
}

/**
 * Mete la caja dentro del escritorio de AHORA.
 *
 * Sin esto, cerrar la app con el mixer en el segundo monitor y volver a
 * abrirla sin ese monitor dejaría la ventana en x = 2400: existe, se puede
 * arrastrar por el store, pero no la ves ni la puedes agarrar. Se garantiza
 * que quedan KEEP_VISIBLE píxeles suyos dentro (incluida la barra de título,
 * que es de donde se arrastra).
 */
function fitToArea(box: LayoutWindow, area: { w: number; h: number }): LayoutWindow {
  const w = Math.max(MIN_W, Math.min(box.w, Math.max(MIN_W, area.w)));
  const h = Math.max(MIN_H, Math.min(box.h, Math.max(MIN_H, area.h)));
  return {
    open: box.open,
    w,
    h,
    x: Math.max(0, Math.min(box.x, Math.max(0, area.w - KEEP_VISIBLE))),
    y: Math.max(0, Math.min(box.y, Math.max(0, area.h - KEEP_VISIBLE / 2))),
  };
}

/** Pseudo-ventana de los paneles del shell: solo importa si están abiertos. */
function parsePanel(raw: unknown): LayoutWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  return { open: (raw as Record<string, unknown>)['open'] === true, x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Traduce lo guardado a un layout aplicable. Una entrada rota se ignora sin
 * tumbar las buenas, y si no queda ninguna válida devuelve null (mejor el
 * escritorio de fábrica que uno a medias).
 */
export function parseWorkspace(raw: unknown, area: { w: number; h: number }): Record<string, LayoutWindow> | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const out: Record<string, LayoutWindow> = {};
  let windows = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === BROWSER_KEY || key === CLAUDE_KEY) {
      const panel = parsePanel(value);
      if (panel) out[key] = panel;
      continue;
    }
    if (!isWindowId(key)) continue;
    const box = parseBox(value);
    if (!box) continue;
    out[key] = fitToArea(box, area);
    windows++;
  }
  return windows > 0 ? out : null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Última disposición VISTA (se compara en cada cambio del store). */
let lastSeen = '';
/** Última disposición ESCRITA a settings.json. */
let lastSaved = '';
let enabled = false;
let unsubscribe: (() => void) | null = null;

/**
 * Reacciona a un cambio del store.
 *
 * La comparación va AQUÍ y no dentro del temporizador, y no es un detalle: el
 * store cambia por mil cosas que no son el escritorio — los medidores del
 * motor lo tocan veinte veces por segundo mientras suena algo. Si cada uno de
 * esos avisos reiniciara el retardo, el guardado no llegaría a dispararse
 * JAMÁS mientras estuvieras reproduciendo, que es justo cuando más ratos
 * seguidos pasa la app abierta.
 */
function onStoreChange(): void {
  if (!enabled) return;
  const key = JSON.stringify(captureLayout());
  if (key === lastSeen) return;
  lastSeen = key;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (lastSeen === lastSaved) return;
    lastSaved = lastSeen;
    void window.orbit?.settings.set({ [SETTINGS_KEY]: JSON.parse(lastSaved) as unknown });
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Restaura la disposición de la sesión anterior y empieza a recordarla.
 *
 * Devuelve si llegó a restaurar algo. Llamar antes que `restoreDetached()`:
 * los editores que viven fuera se abren después y mandan ellos.
 */
export async function initWorkspaceMemory(): Promise<boolean> {
  const settings = await window.orbit?.settings.get().catch(() => undefined);
  let restored = false;
  if (settings && settings[REMEMBER_KEY] !== false) {
    const layout = parseWorkspace(settings[SETTINGS_KEY], workspaceArea());
    if (layout) {
      applyLayoutWindows(layout);
      restored = true;
    }
    setWorkspaceMemory(true);
  }
  return restored;
}

/** Enciende o apaga la memoria del escritorio (y se acuerda de la decisión). */
export function setWorkspaceMemory(on: boolean, persist = false): void {
  if (persist) void window.orbit?.settings.set({ [REMEMBER_KEY]: on });
  if (on === enabled) return;
  enabled = on;
  if (!on) {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    unsubscribe?.();
    unsubscribe = null;
    return;
  }
  // Lo que hay ahora cuenta como ya guardado: encender la memoria no puede
  // pisar el settings.json antes de que el usuario mueva nada.
  lastSaved = JSON.stringify(captureLayout());
  lastSeen = lastSaved;
  unsubscribe = useUiStore.subscribe(onStoreChange);
}

/** ¿Está recordando la disposición? (para el interruptor de Ajustes) */
export function workspaceMemoryOn(): boolean {
  return enabled;
}

/** Olvida la disposición guardada (el próximo arranque sale de fábrica). */
export function forgetWorkspace(): void {
  lastSaved = '';
  lastSeen = '';
  void window.orbit?.settings.set({ [SETTINGS_KEY]: null });
}
