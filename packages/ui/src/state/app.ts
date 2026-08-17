/**
 * Núcleo de estado de la app: UN ProjectStore + UN AudioEngine, cableados.
 * Cualquier cambio del proyecto recompila y sincroniza el kernel (debounce
 * por microtask para agrupar ráfagas de comandos).
 */

import { ProjectStore } from '@orbit/core';
import { AudioEngine } from '@orbit/engine';
import { pushCaptureChunk } from './track-capture';
import { useUiStore } from './ui';

export const store = new ProjectStore();
export const engine = new AudioEngine();

let syncQueued = false;

function queueSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    engine.syncProject(store.project);
  });
}

store.subscribe(queueSync);

/** Último frame del kernel (para interpolar la posición entre frames). */
let meterStamp = { beats: 0, at: 0, playing: false };

/**
 * Posición del playhead AHORA, no la del último frame: los medidores llegan
 * cada ~46 ms y eso, grabando movimientos de perilla, se nota como escalones.
 * Entre frames se extrapola con el tempo del proyecto.
 */
export function currentBeat(): number {
  if (!meterStamp.playing) return meterStamp.beats;
  const dt = (performance.now() - meterStamp.at) / 1000;
  return meterStamp.beats + (dt * store.project.tempo) / 60;
}

// Medidores del kernel → estado UI (~20 fps)
engine.onMeters = (frame) => {
  const peak = frame.peaks[0] ?? 0;
  meterStamp = { beats: frame.positionBeats, at: performance.now(), playing: frame.playing };
  useUiStore.setState({
    playing: frame.playing,
    positionBeats: frame.positionBeats,
    masterPeakL: peak,
    masterRms: (frame.masterRms[0] + frame.masterRms[1]) / 2,
    // El clip queda enclavado: solo lo limpia el usuario clicando el LED.
    ...(peak >= 1 ? { clipped: true } : null),
    cpu: frame.cpu,
    trackPeaks: frame.peaks,
    trackRms: frame.rms,
    scopeFrame: frame.scope ?? null,
  });
  if (frame.captureL && frame.captureR) {
    pushCaptureChunk(frame.captureL, frame.captureR);
  }
};

/** Ajusta el modo de reproducción (PAT/SONG) y resincroniza el kernel. */
export function setPlayMode(mode: 'pattern' | 'song'): void {
  const { activePatternId } = useUiStore.getState();
  engine.playMode =
    mode === 'pattern'
      ? { mode: 'pattern', patternId: activePatternId ?? store.project.patternOrder[0]! }
      : { mode: 'song' };
  useUiStore.setState({ playMode: mode });
  queueSync();
}

/** Cambia el patrón activo (afecta al modo PAT y a los editores). */
export function setActivePattern(patternId: string): void {
  useUiStore.setState({ activePatternId: patternId });
  if (useUiStore.getState().playMode === 'pattern') {
    engine.playMode = { mode: 'pattern', patternId };
    queueSync();
  }
}

/** Play desde el caret actual (0 tras stop; donde estaba tras pause/seek). */
export async function play(): Promise<void> {
  await engine.init();
  engine.syncProject(store.project);
  engine.play(useUiStore.getState().positionBeats);
}

export function stopPlayback(): void {
  engine.stop();
  useUiStore.setState({ playing: false, positionBeats: 0 });
}

/** Pausa: para el motor pero conserva el caret (play reanuda desde ahí). */
export function pausePlayback(): void {
  engine.stop();
  useUiStore.setState({ playing: false });
}

export async function togglePlay(): Promise<void> {
  if (useUiStore.getState().playing) stopPlayback();
  else await play();
}

/** Primer gesto del usuario → despierta el AudioContext (política de autoplay). */
export function ensureAudioReady(): void {
  void engine.init().then(() => engine.syncProject(store.project));
}

// Ganchos de QA solo-dev: inspeccionar estado vivo desde CDP.
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w['__orbitStore'] = store;
  w['__orbitUi'] = useUiStore;
  w['__orbitEngine'] = engine;
}
