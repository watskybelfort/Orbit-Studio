// @orbit/ui — interfaz React de Orbit Studio
export { App } from './App';
export { TitleBar } from './shell/TitleBar';
export type { TitleBarProps } from './shell/TitleBar';
export { applyTheme, loadThemeFromSettings, saveThemeToSettings, isThemeId } from './theme/theme';
export type { ThemeId, ThemeOverrides, ThemeState } from './theme/theme';

// Estado central (un ProjectStore + un AudioEngine por app)
export { store, engine, setPlayMode, setActivePattern, togglePlay, stopPlayback, ensureAudioReady } from './state/app';
export { useProject, useProjectVersion } from './state/useProject';
export { useUiStore } from './state/ui';
export type { WindowId, UiState } from './state/ui';

// Widgets
export { Knob } from './widgets/Knob';
export { Fader } from './widgets/Fader';
export { LevelMeter } from './widgets/LevelMeter';
export { NumberScrubber } from './widgets/NumberScrubber';
export { InternalWindow } from './shell/InternalWindow';
