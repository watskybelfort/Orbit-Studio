/** Estado de UI (no del proyecto): ventanas, selección, transporte visible. */

import { create } from 'zustand';

export type WindowId =
  | 'channelRack'
  | 'pianoRoll'
  | 'playlist'
  | 'mixer'
  | 'settings'
  | 'export'
  | 'automation'
  | 'lfo'
  | 'nova'
  | 'prisma'
  | 'channelEditor'
  | 'history'
  | 'projectInfo'
  | 'collab'
  | 'scope'
  | 'audioEditor'
  | 'liveView'
  | 'graph';

export interface WindowState {
  open: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

export interface UiState {
  windows: Record<WindowId, WindowState>;
  topZ: number;

  playMode: 'pattern' | 'song';
  playing: boolean;
  positionBeats: number;
  metronome: boolean;
  masterPeakL: number;
  /** RMS master (media L/R), lineal. */
  masterRms: number;
  /** Hubo un pico >= 0 dBFS; enclavado hasta que el usuario lo resetea. */
  clipped: boolean;
  cpu: number;
  trackPeaks: Float32Array | null;
  /** RMS por pista de mixer (post-fader, del kernel), lineal. */
  trackRms: Float32Array | null;
  /** Últimos samples de la pista tapeada para el Orbit Scope / analizador del EQ. */
  scopeFrame: Float32Array | null;
  /** Región de loop de la playlist en beats (también fuente del export). */
  loopRegion: { start: number; end: number } | null;

  activePatternId: string | null;
  /** Canal cuyo piano roll está abierto. */
  pianoRollChannelId: string | null;
  /** Clip de automatización abierto en el editor de automatización. */
  automationClipId: string | null;
  /** Clip de audio abierto en el editor de audio. */
  audioClipId: string | null;
  /** Canal de Orbit Nova que edita su panel. */
  novaChannelId: string | null;
  /** Canal de Orbit Prisma que edita su panel. */
  prismaChannelId: string | null;
  /** Canal abierto en el editor de sonido (doble clic en el rack). */
  channelEditorId: string | null;
  selectedMixerTrack: number;
  browserOpen: boolean;
  claudePanelOpen: boolean;
  /** Modo compacto (Zen): oculta Browser y panel de Claude sin perder su estado. */
  compact: boolean;
  /** Semáforo macOS en la barra de título (persistido en settings). */
  trafficLights: boolean;

  openWindow: (id: WindowId) => void;
  closeWindow: (id: WindowId) => void;
  toggleWindow: (id: WindowId) => void;
  focusWindow: (id: WindowId) => void;
  moveWindow: (id: WindowId, x: number, y: number) => void;
  resizeWindow: (id: WindowId, w: number, h: number) => void;
}

const defaultWindows: Record<WindowId, WindowState> = {
  channelRack: { open: true, x: 60, y: 40, w: 480, h: 420, z: 2 },
  pianoRoll: { open: false, x: 180, y: 80, w: 900, h: 520, z: 1 },
  playlist: { open: true, x: 560, y: 40, w: 760, h: 420, z: 3 },
  mixer: { open: false, x: 120, y: 300, w: 980, h: 440, z: 1 },
  settings: { open: false, x: 260, y: 120, w: 640, h: 480, z: 1 },
  export: { open: false, x: 320, y: 100, w: 420, h: 500, z: 1 },
  automation: { open: false, x: 240, y: 140, w: 720, h: 380, z: 1 },
  lfo: { open: false, x: 280, y: 200, w: 780, h: 300, z: 1 },
  nova: { open: false, x: 200, y: 90, w: 760, h: 470, z: 1 },
  prisma: { open: false, x: 150, y: 70, w: 940, h: 580, z: 1 },
  channelEditor: { open: false, x: 220, y: 100, w: 820, h: 540, z: 1 },
  history: { open: false, x: 320, y: 120, w: 420, h: 460, z: 1 },
  projectInfo: { open: false, x: 340, y: 140, w: 460, h: 480, z: 1 },
  collab: { open: false, x: 380, y: 140, w: 420, h: 380, z: 1 },
  scope: { open: false, x: 300, y: 180, w: 560, h: 360, z: 1 },
  audioEditor: { open: false, x: 260, y: 160, w: 720, h: 340, z: 1 },
  liveView: { open: false, x: 200, y: 120, w: 560, h: 420, z: 1 },
  graph: { open: false, x: 160, y: 100, w: 860, h: 520, z: 1 },
};

/** Todos los editores, en runtime (para validar lo que venga de settings.json). */
export const WINDOW_IDS = Object.keys(defaultWindows) as WindowId[];

export function isWindowId(value: unknown): value is WindowId {
  return typeof value === 'string' && (WINDOW_IDS as string[]).includes(value);
}

/**
 * Base del apilado de ventanas internas.
 *
 * Antes cada `focusWindow` hacía `topZ + 1` sin techo y sin comprobar si la
 * ventana ya estaba arriba, así que un rato de trabajo bastaba para que las
 * ventanas superaran el z-index de los menús contextuales (1000), del aviso de
 * la app (1000) y hasta de la paleta de comandos (1200): los menús "dejaban de
 * funcionar" porque quedaban pintados DEBAJO. Ahora los z se renumeran en un
 * rango pequeño y acotado, muy por debajo de cualquier overlay.
 */
const Z_BASE = 10;

/**
 * Sube una ventana al frente renumerando el resto. Devuelve `null` si ya
 * estaba arriba — así el clic dentro de una ventana enfocada no reescribe el
 * objeto `windows` ni obliga a repintar los quince editores.
 */
function raiseWindows(
  windows: Record<WindowId, WindowState>,
  id: WindowId,
): { windows: Record<WindowId, WindowState>; topZ: number } | null {
  const current = windows[id];
  const others = (Object.keys(windows) as WindowId[])
    .filter((k) => k !== id)
    .sort((a, b) => windows[a].z - windows[b].z);
  const top = Z_BASE + others.length;
  if (current.z === top) return null;
  const next = { ...windows };
  others.forEach((k, i) => {
    const w = windows[k];
    if (w.z !== Z_BASE + i) next[k] = { ...w, z: Z_BASE + i };
  });
  next[id] = { ...current, z: top };
  return { windows: next, topZ: top };
}

export const useUiStore = create<UiState>((set) => ({
  windows: defaultWindows,
  topZ: Z_BASE,

  playMode: 'pattern',
  playing: false,
  positionBeats: 0,
  metronome: false,
  masterPeakL: 0,
  masterRms: 0,
  clipped: false,
  cpu: 0,
  trackPeaks: null,
  trackRms: null,
  scopeFrame: null,
  loopRegion: null,

  activePatternId: null,
  pianoRollChannelId: null,
  automationClipId: null,
  audioClipId: null,
  novaChannelId: null,
  prismaChannelId: null,
  channelEditorId: null,
  selectedMixerTrack: 0,
  browserOpen: true,
  claudePanelOpen: false,
  compact: false,
  trafficLights: false,

  openWindow: (id) =>
    set((s) => {
      const raised = raiseWindows(s.windows, id) ?? { windows: s.windows, topZ: s.topZ };
      return {
        windows: { ...raised.windows, [id]: { ...raised.windows[id], open: true } },
        topZ: raised.topZ,
      };
    }),
  closeWindow: (id) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], open: false } } })),
  toggleWindow: (id) =>
    set((s) => {
      if (s.windows[id].open) {
        return { windows: { ...s.windows, [id]: { ...s.windows[id], open: false } } };
      }
      const raised = raiseWindows(s.windows, id) ?? { windows: s.windows, topZ: s.topZ };
      return {
        windows: { ...raised.windows, [id]: { ...raised.windows[id], open: true } },
        topZ: raised.topZ,
      };
    }),
  focusWindow: (id) => set((s) => raiseWindows(s.windows, id) ?? s),
  moveWindow: (id, x, y) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], x, y } } })),
  resizeWindow: (id, w, h) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], w, h } } })),
}));
