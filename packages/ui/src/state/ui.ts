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
  | 'collab'
  | 'scope'
  | 'audioEditor';

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
  /** Últimos samples del master para el Orbit Scope (solo con la ventana abierta). */
  scopeFrame: Float32Array | null;

  activePatternId: string | null;
  /** Canal cuyo piano roll está abierto. */
  pianoRollChannelId: string | null;
  /** Clip de automatización abierto en el editor de automatización. */
  automationClipId: string | null;
  /** Clip de audio abierto en el editor de audio. */
  audioClipId: string | null;
  selectedMixerTrack: number;
  browserOpen: boolean;
  claudePanelOpen: boolean;
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
  collab: { open: false, x: 380, y: 140, w: 420, h: 380, z: 1 },
  scope: { open: false, x: 300, y: 180, w: 560, h: 360, z: 1 },
  audioEditor: { open: false, x: 260, y: 160, w: 720, h: 340, z: 1 },
};

export const useUiStore = create<UiState>((set) => ({
  windows: defaultWindows,
  topZ: 3,

  playMode: 'pattern',
  playing: false,
  positionBeats: 0,
  metronome: false,
  masterPeakL: 0,
  masterRms: 0,
  clipped: false,
  cpu: 0,
  trackPeaks: null,
  scopeFrame: null,

  activePatternId: null,
  pianoRollChannelId: null,
  automationClipId: null,
  audioClipId: null,
  selectedMixerTrack: 0,
  browserOpen: true,
  claudePanelOpen: false,
  trafficLights: false,

  openWindow: (id) =>
    set((s) => ({
      windows: { ...s.windows, [id]: { ...s.windows[id], open: true, z: s.topZ + 1 } },
      topZ: s.topZ + 1,
    })),
  closeWindow: (id) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], open: false } } })),
  toggleWindow: (id) =>
    set((s) => {
      const w = s.windows[id];
      return w.open
        ? { windows: { ...s.windows, [id]: { ...w, open: false } } }
        : {
            windows: { ...s.windows, [id]: { ...w, open: true, z: s.topZ + 1 } },
            topZ: s.topZ + 1,
          };
    }),
  focusWindow: (id) =>
    set((s) => ({
      windows: { ...s.windows, [id]: { ...s.windows[id], z: s.topZ + 1 } },
      topZ: s.topZ + 1,
    })),
  moveWindow: (id, x, y) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], x, y } } })),
  resizeWindow: (id, w, h) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id], w, h } } })),
}));
