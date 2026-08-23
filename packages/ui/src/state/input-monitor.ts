/**
 * Monitor de entrada: oír el micro (o el instrumento) EN VIVO con la cadena
 * de su pista de mixer puesta, mientras se graba o antes de grabar.
 *
 * Hasta ahora la toma se oía después: grababas a ciegas, y el reverb y el
 * compresor que iba a llevar la voz no aparecían hasta el playback. El
 * kernel ya sabe meter su entrada antes de los inserts de una pista
 * (`setLiveInput`); esto es quién le abre el micro y le dice a qué pista.
 *
 * Hay dos estados y no uno:
 *
 * - **Escuchar** mide el nivel sin sacarlo por los altavoces. Es como se
 *   ajusta la ganancia de entrada sin montar un acople.
 * - **Monitorizar** además lo saca. Con altavoces eso ES un acople: el aviso
 *   de los cascos no es un adorno.
 */

import { create } from 'zustand';
import { engine, ensureAudioReady } from './app';

export interface InputDevice {
  id: string;
  label: string;
}

interface InputMonitorState {
  /** Micro abierto y midiendo. */
  listening: boolean;
  /** Además saliendo por la pista (con su cadena puesta). */
  monitor: boolean;
  /** Pista de mixer por la que entra. */
  trackIndex: number;
  /** Ganancia de entrada (lineal). */
  gain: number;
  /** Dispositivo elegido ('' = el que diga el sistema). */
  deviceId: string;
  devices: InputDevice[];
  /** Pico de lo que entra, ANTES de la ganancia (lo manda el kernel). */
  peak: number;
  error: string | null;
}

export const useInputMonitorStore = create<InputMonitorState>(() => ({
  listening: false,
  monitor: false,
  trackIndex: 1,
  gain: 1,
  deviceId: '',
  devices: [],
  peak: 0,
  error: null,
}));

/** Stream abierto ahora mismo y su nodo en el grafo. */
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;

/** Lo llama el bucle de medidores del kernel. */
export function setInputPeak(peak: number): void {
  const st = useInputMonitorStore.getState();
  // Solo se escribe si cambia de verdad: esto entra ~20 veces por segundo y
  // repintar toda la UI por un cero constante no tiene sentido.
  if (!st.listening && st.peak === 0) return;
  if (Math.abs(st.peak - peak) < 0.002) return;
  useInputMonitorStore.setState({ peak });
}

/** Manda al kernel el estado actual. */
function push(): void {
  const { listening, monitor, trackIndex, gain } = useInputMonitorStore.getState();
  engine.setLiveInput(listening, monitor, trackIndex, gain);
}

/**
 * Fuente del micro; inyectable para QA igual que en el grabador (fuente
 * sintética, sin micro real).
 */
let streamFactory: (deviceId: string) => Promise<MediaStream> = (deviceId) =>
  navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : null),
      // Nada de procesado del navegador: la cadena la pone Orbit. El
      // cancelador de eco además se come el beat que suena por los altavoces
      // y hace cosas raras con la voz cantada.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

export function setInputStreamFactory(f: (deviceId: string) => Promise<MediaStream>): void {
  streamFactory = f;
}

/** Cierra el micro y lo desengancha del kernel. */
export function stopInputMonitor(): void {
  source?.disconnect();
  source = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  useInputMonitorStore.setState({ listening: false, monitor: false, peak: 0 });
  push();
}

/** Abre el micro (sin sacarlo todavía por los altavoces). */
export async function startInputMonitor(): Promise<boolean> {
  if (stream) return true;
  try {
    ensureAudioReady();
    await engine.init();
    const { deviceId } = useInputMonitorStore.getState();
    stream = await streamFactory(deviceId);
    source = engine.connectInput(stream);
    if (!source) throw new Error('El audio no ha arrancado');
    useInputMonitorStore.setState({ listening: true, error: null });
    push();
    void refreshInputDevices();
    return true;
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    source = null;
    useInputMonitorStore.setState({
      listening: false,
      monitor: false,
      error: err instanceof Error ? err.message : 'No se pudo abrir el micro',
    });
    return false;
  }
}

/** Enciende/apaga el monitor (abriendo el micro si hacía falta). */
export async function toggleInputMonitor(): Promise<void> {
  const st = useInputMonitorStore.getState();
  if (st.monitor) {
    useInputMonitorStore.setState({ monitor: false });
    push();
    return;
  }
  if (!st.listening && !(await startInputMonitor())) return;
  useInputMonitorStore.setState({ monitor: true });
  push();
}

/** Enciende/apaga solo la escucha (medir sin oírse). */
export async function toggleInputListening(): Promise<void> {
  if (useInputMonitorStore.getState().listening) stopInputMonitor();
  else await startInputMonitor();
}

export function setInputTrack(trackIndex: number): void {
  useInputMonitorStore.setState({ trackIndex: Math.max(0, Math.round(trackIndex)) });
  push();
}

export function setInputGain(gain: number): void {
  useInputMonitorStore.setState({ gain: Math.max(0, gain) });
  push();
}

/** Cambia de dispositivo; si el micro estaba abierto, se reabre con el nuevo. */
export async function setInputDevice(deviceId: string): Promise<void> {
  const was = useInputMonitorStore.getState();
  useInputMonitorStore.setState({ deviceId });
  if (!was.listening) return;
  stopInputMonitor();
  if (await startInputMonitor()) {
    useInputMonitorStore.setState({ monitor: was.monitor });
    push();
  }
}

/**
 * Relee la lista de entradas. Los nombres solo los da el navegador DESPUÉS de
 * conceder permiso, así que antes de abrir el micro la lista sale sin
 * etiquetas — de ahí el nombre de repuesto.
 */
export async function refreshInputDevices(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const devices = all
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Entrada ${i + 1}` }));
    useInputMonitorStore.setState({ devices });
  } catch {
    // Sin permiso todavía: la lista se queda como esté.
  }
}

/** El stream abierto, para que el grabador no abra un SEGUNDO micro. */
export function currentInputStream(): MediaStream | null {
  return stream;
}
