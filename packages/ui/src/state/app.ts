/**
 * Núcleo de estado de la app: UN ProjectStore + UN AudioEngine, cableados.
 * Cualquier cambio del proyecto recompila y sincroniza el kernel, agrupando
 * ráfagas de comandos en una sola compilación.
 */

import { ProjectStore } from '@orbit/core';
import { AudioEngine } from '@orbit/engine';
import { setKernelNotes } from './active-notes';
import { pushCaptureChunk } from './track-capture';
import { pushMasterStreamChunk } from '../collab/master-stream';
import { useUiStore } from './ui';

export const store = new ProjectStore();
export const engine = new AudioEngine();

/**
 * Ventana de agrupación de la resincronización. Antes era un `queueMicrotask`,
 * que solo junta lo que cae en el MISMO tick: los comandos locales de un
 * arrastre sí, pero cada mensaje del socket de colaboración llega en su propio
 * macrotask, así que una ráfaga remota costaba una compilación COMPLETA del
 * proyecto por comando. 40 ms sigue por debajo del umbral de "instantáneo" y se
 * come la ráfaga entera.
 */
const SYNC_DEBOUNCE_MS = 40;

/**
 * Tope desde el primer cambio pendiente. Sin él, un flujo continuo (arrastrar
 * una perilla a 60 fps, un peer moviendo un fader) reiniciaría el debounce sin
 * parar y no oirías el barrido hasta soltar.
 */
const SYNC_MAX_WAIT_MS = 120;

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncDeadline = 0;
/** Hay cambios sin llevar al kernel (porque el motor está congelado). */
let syncPending = false;
/** El kernel ya recibió al menos un snapshot (si no, congelar sería silencio). */
let syncedOnce = false;
let syncFrozen = false;

function pushSnapshot(): void {
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  syncDeadline = 0;
  syncPending = false;
  syncedOnce = true;
  engine.syncProject(store.project);
}

function queueSync(): void {
  // Congelado: el modelo sigue cambiando (la UI converge con la sala) pero el
  // kernel se queda con el último snapshot. Al descongelar se manda de golpe.
  if (syncFrozen && syncedOnce) {
    syncPending = true;
    return;
  }
  const now = performance.now();
  if (syncTimer === null) syncDeadline = now + SYNC_MAX_WAIT_MS;
  else clearTimeout(syncTimer);
  const wait = Math.max(0, Math.min(SYNC_DEBOUNCE_MS, syncDeadline - now));
  syncTimer = setTimeout(pushSnapshot, wait);
}

store.subscribe(queueSync);

/**
 * Congela lo que SUENA sin tocar lo que se edita.
 *
 * Es lo que hay detrás de "Silenciar lo que toca el otro" del panel de
 * colaboración. Ojo con el concepto: el otro no reproduce nada en tu máquina —
 * lo que oyes es TU motor tocando el proyecto compartido. Así que congelar el
 * snapshot del kernel es exactamente "dejar de oír lo que él va metiendo":
 * sus comandos se siguen aplicando al modelo y la UI converge igual, pero el
 * audio se queda como estaba. Al descongelar, si algo cambió, se resincroniza
 * al instante.
 */
export function setEngineSyncFrozen(frozen: boolean): void {
  if (syncFrozen === frozen) return;
  syncFrozen = frozen;
  if (frozen) {
    // Lo ya encolado se descarta como envío: queda pendiente para el deshielo.
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
      syncDeadline = 0;
      syncPending = true;
    }
    return;
  }
  if (syncPending) pushSnapshot();
}

/** ¿Está congelado el motor (no recibe cambios nuevos)? */
export function isEngineSyncFrozen(): boolean {
  return syncFrozen;
}

/** Congelado Y con cambios esperando: la UI lo dice ("hay cambios sin oír"). */
export function hasFrozenChanges(): boolean {
  return syncFrozen && syncPending;
}

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
  // Teclas que suenan de verdad (secuenciador incluido) para los teclados.
  setKernelNotes(frame.notes);
  if (frame.captureL && frame.captureR) {
    pushCaptureChunk(frame.captureL, frame.captureR);
    // Y, si se está emitiendo el master a la sala, ese mismo trozo viaja.
    pushMasterStreamChunk(frame.captureL, frame.captureR);
  }
};

/**
 * Patrón que debe sonar en modo PAT. Comprueba EXISTENCIA, no solo que haya un
 * id: si el patrón activo se borró (o llegó borrado desde la sala), mandarle al
 * kernel un id fantasma deja el modo PAT completamente mudo sin decir por qué.
 * Con cero patrones devuelve cadena vacía: no hay nada que tocar y el kernel lo
 * resuelve como silencio, que es la verdad, en vez de reventar con un `!`.
 */
function patternToPlay(): string {
  const { activePatternId } = useUiStore.getState();
  const { patterns, patternOrder } = store.project;
  if (activePatternId !== null && patterns[activePatternId]) return activePatternId;
  return patternOrder.find((id) => patterns[id] !== undefined) ?? '';
}

// La UI arranca en modo PAT (state/ui.ts) — el motor tiene que arrancar igual.
// Con 'song' de fábrica los dos quedaban desincronizados hasta el primer
// setPlayMode: pulsabas play con PAT encendido y sonaba la canción entera.
engine.playMode = { mode: 'pattern', patternId: patternToPlay() };

/**
 * Caret guardado de cada modo. PAT y SONG llevan playheads INDEPENDIENTES,
 * como en FL: el beat 200 de la canción no significa nada dentro de un patrón
 * de cuatro compases. Compartirlo tenía una consecuencia bastante peor que la
 * confusión — arrancar el patrón en el beat 200 dejaba el motor tocando fuera
 * de su región de loop, o sea MUDO hasta reiniciar la app. El kernel ya se
 * defiende de eso por su cuenta, pero el sitio donde nacía el disparate es
 * este.
 */
const modePos: Record<'pattern' | 'song', number> = { pattern: 0, song: 0 };

/** Ajusta el modo de reproducción (PAT/SONG) y resincroniza el kernel. */
export function setPlayMode(mode: 'pattern' | 'song'): void {
  const ui = useUiStore.getState();
  if (ui.playMode !== mode) {
    modePos[ui.playMode] = ui.positionBeats;
    const beat = modePos[mode];
    engine.seek(beat);
    useUiStore.setState({ positionBeats: beat });
  }
  engine.playMode =
    mode === 'pattern' ? { mode: 'pattern', patternId: patternToPlay() } : { mode: 'song' };
  useUiStore.setState({ playMode: mode });
  queueSync();
}

/** Cambia el patrón activo (afecta al modo PAT y a los editores). */
export function setActivePattern(patternId: string): void {
  useUiStore.setState({ activePatternId: patternId });
  if (useUiStore.getState().playMode === 'pattern') {
    // Por patternToPlay() y no directo: si ese patrón ya no existe, cae al
    // primero que sí, en vez de dejar el modo PAT mudo.
    engine.playMode = { mode: 'pattern', patternId: patternToPlay() };
    queueSync();
  }
}

/** Play desde el caret actual (0 tras stop; donde estaba tras pause/seek). */
export async function play(): Promise<void> {
  await engine.init();
  // Congelado a propósito (ver setEngineSyncFrozen): dar al play NO puede ser
  // la puerta trasera por la que se cuela lo que pediste no oír.
  if (!syncFrozen || !syncedOnce) pushSnapshot();
  engine.play(useUiStore.getState().positionBeats);
}

export function stopPlayback(): void {
  engine.stop();
  // Stop devuelve al principio el caret del modo en el que estás; el del otro
  // modo se queda donde lo dejaste, que es justo la gracia de tenerlos aparte.
  modePos[useUiStore.getState().playMode] = 0;
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
  void engine.init().then(() => {
    if (!syncFrozen || !syncedOnce) pushSnapshot();
  });
}

// Ganchos de QA solo-dev: inspeccionar estado vivo desde CDP.
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w['__orbitStore'] = store;
  w['__orbitUi'] = useUiStore;
  w['__orbitEngine'] = engine;
}
