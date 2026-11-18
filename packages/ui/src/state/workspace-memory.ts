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
import { isMaximizedBox } from '../shell/window-bounds';
import {
  applyLayoutWindows,
  applyStartupLayout,
  captureLayout,
  fitToArea,
  workspaceArea,
  BROWSER_KEY,
  CLAUDE_KEY,
} from './layouts';
import { useUiStore, isWindowId } from './ui';

/** Clave de settings.json con la disposición de la última sesión. */
const SETTINGS_KEY = 'workspaceLayout';
/** Clave de settings.json para apagar la memoria (por defecto está encendida). */
export const REMEMBER_KEY = 'rememberWorkspace';

/** Retardo de guardado tras el último cambio, en ms. */
const SAVE_DEBOUNCE_MS = 700;

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

/** Pseudo-ventana de los paneles del shell: solo importa si están abiertos. */
function parsePanel(raw: unknown): LayoutWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  return { open: (raw as Record<string, unknown>)['open'] === true, x: 0, y: 0, w: 0, h: 0 };
}

/**
 * Una caja guardada que llenaba el escritorio no era «maximizada»: la memoria no
 * guarda marcas. Restaurarla tal cual deja una ventana del tamaño del área, que
 * no puede moverse (no cabe ningún desplazamiento: `fitWindowToWorkspace` la
 * devuelve a 0,0) y con «Maximizar» deshabilitado. Se restaura una caja de
 * descanso grande y centrada; si el usuario la quería a pantalla completa, la
 * maximiza otra vez con un clic (y esta vez la marca existe).
 */
function restingBox(box: LayoutWindow, area: { w: number; h: number }): LayoutWindow {
  const fitted = fitToArea(box, area);
  // El render termina de recortar x/y para que la caja quepa
  // (`fitWindowToWorkspace`): una caja del tamaño del área guardada con y=120
  // acababa pintada igual en 0,0, así que se juzga la caja que se va a VER.
  const shown = {
    ...fitted,
    x: Math.max(0, Math.min(fitted.x, area.w - fitted.w)),
    y: Math.max(0, Math.min(fitted.y, area.h - fitted.h)),
  };
  if (!isMaximizedBox(shown, area)) return fitted;
  const w = Math.max(1, area.w - 120);
  const h = Math.max(1, area.h - 120);
  return fitToArea(
    { ...box, w, h, x: Math.round((area.w - w) / 2), y: Math.round((area.h - h) / 2) },
    area,
  );
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
    out[key] = restingBox(box, area);
    windows++;
  }
  return windows > 0 ? out : null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Última disposición VISTA (se compara en cada cambio del store). */
let lastSeen = '';
/** Última disposición ESCRITA a settings.json. */
let lastSaved = '';
/** Referencia de `windows` ya medida: evita serializar 18 cajas por medidor. */
let lastWindows: unknown = null;
let lastPanels = '';
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
  const ui = useUiStore.getState();
  // Los medidores del motor cambian el store ~20 veces por segundo con la
  // MISMA referencia de `windows`. Sin esta guarda se serializaban las 18
  // ventanas en cada tick para descubrir que nada se había movido.
  const panels = `${ui.browserOpen ? 1 : 0}${ui.claudePanelOpen ? 1 : 0}${ui.compact ? 1 : 0}`;
  if (ui.windows === lastWindows && panels === lastPanels) return;
  lastWindows = ui.windows;
  lastPanels = panels;
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
  // Sin memoria (o sin nada guardado) no se dejan las cajas de fábrica
  // solapadas: el arranque se coloca según el espacio que hay de verdad.
  if (!restored) applyStartupLayout();
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
  lastWindows = null;
  lastPanels = '';
  unsubscribe = useUiStore.subscribe(onStoreChange);
}

/** ¿Está recordando la disposición? (para el interruptor de Ajustes) */
export function workspaceMemoryOn(): boolean {
  return enabled;
}

/** Olvida la disposición guardada (el próximo arranque sale de fábrica). */
export function forgetWorkspace(): void {
  // El guardado en vuelo también se olvida: sin esto, mover una ventana y
  // pulsar «Olvidar» dentro de los 700 ms del debounce volvía a escribir el
  // layout recién olvidado, sin ningún aviso.
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  lastSaved = '';
  lastSeen = '';
  // El próximo cambio real tiene que volver a programar un guardado.
  lastWindows = null;
  lastPanels = '';
  void window.orbit?.settings.set({ [SETTINGS_KEY]: null });
}
