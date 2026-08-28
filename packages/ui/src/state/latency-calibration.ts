/**
 * Bucle de calibración de latencia de entrada: cuánto tarda un sonido en
 * volver del altavoz al micro, EN MUESTRAS, en ESTE aparato con ESTE tamaño
 * de buffer. Es el número que hoy el usuario corrige a ojo arrastrando cada
 * toma en la playlist — aquí se mide una vez y `recorder.ts` lo aplica solo
 * en cada grabación siguiente.
 *
 * La medida en sí (generar el chirp, correlacionarlo) vive en
 * `input-latency.ts`, puro y sin Web Audio. Este módulo es el pegamento con
 * el motor real:
 *
 * - Saca el chirp por los altavoces DIRECTO a `ctx.destination` — no por el
 *   kernel: la calibración no depende de que haya proyecto, pista ni fader,
 *   mide el aparato, no la mezcla.
 * - Abre el micro (reusando el monitor de entrada si ya estaba abierto, con
 *   el mismo cuidado de no pedir un segundo `getUserMedia` que ya documenta
 *   `recorder.ts:276`) y captura la entrada en crudo por el mismo camino que
 *   usa la grabación de tomas (`recorder.ts` expone `setRawInputSink` para
 *   esto: mientras el sumidero de calibración está puesto, la toma normal no
 *   ve nada — las dos cosas nunca corren a la vez).
 * - Guarda el resultado en ajustes junto al resto de entrada.
 *
 * ── Por qué el bucle necesita que la salida llegue a la entrada ──
 *
 * Con auriculares puestos el circuito está abierto: nada de lo que sale por
 * el altavoz entra por el micro. Eso no es un caso raro a avisar de pasada,
 * es EL caso más probable la primera vez que alguien aprieta el botón — así
 * que se detecta como silencio (ver `input-latency.ts`) y se explica en la
 * UI, nunca se guarda un cero por defecto.
 *
 * ── Cómo se ancla el retardo sin depender de un reloj compartido exacto ──
 *
 * La captura arranca (índice 0 del buffer capturado) cuando el kernel
 * procesa el mensaje `setInputCapture`; eso tarda del orden de un bloque de
 * render (unos pocos ms), no lo sabemos con precisión de muestra desde el
 * hilo de UI. Para que ese margen de incertidumbre sea IRRELEVANTE frente al
 * retardo que se mide, el chirp no se dispara "ya": se programa con
 * `AudioBufferSourceNode.start(cuando)` a `CAPTURE_LEAD_MS` por delante,
 * usando el MISMO reloj de audio (`ctx.currentTime`) que ya evita el mismo
 * problema en `recorder.ts` (ver `waitCountIn`). Como `start(cuando)` es
 * exacto a la muestra por especificación, el desfase entre "empieza la
 * captura" y "empieza a sonar el chirp" es CAPTURE_LEAD_MS con un error
 * acotado por ese único bloque de render inicial (unos cientos de muestras
 * como mucho) — y ESE es el margen que hay que declarar en el test, no cero.
 */

import { generateChirp, estimateDelaySamples, samplesToMs } from './input-latency';
import { engine, ensureAudioReady } from './app';
import {
  currentInputStream,
  startInputMonitor,
  stopInputMonitor,
  useInputMonitorStore,
} from './input-monitor';
import { setRawInputSink, useRecorderStore } from './recorder';
import { create } from 'zustand';

/** Margen antes del chirp: tiempo de sobra para que la captura esté YA activa. */
const CAPTURE_LEAD_MS = 200;
/** Cuánto se busca el eco después de que el chirp termine de sonar. */
const MAX_SEARCH_MS = 500;
/** Colchón extra al final por si el último paquete de medidores llega tarde. */
const CAPTURE_GUARD_MS = 150;

export type CalibrationStatus = 'idle' | 'measuring' | 'error';

interface LatencyCalibrationState {
  status: CalibrationStatus;
  /** Retardo activo, en muestras — el que aplica `recorder.ts`. 0 = sin compensar. */
  delaySamples: number;
  /** De dónde salió el valor activo. */
  source: 'measured' | 'manual' | null;
  /** Confianza (0..1) de la última medida aceptada; null si nunca se aceptó una. */
  confidence: number | null;
  /** Por qué falló el último intento (rechazo o error), para mostrar en la UI. */
  error: string | null;
  /** sampleRate·deviceId con los que se calibró el valor activo, para saber si sigue valiendo. */
  calibratedFingerprint: string | null;
  /** ¿El aparato o el buffer cambiaron desde que se calibró? Solo aviso, no bloquea. */
  stale: boolean;
}

export const useLatencyCalibrationStore = create<LatencyCalibrationState>(() => ({
  status: 'idle',
  delaySamples: 0,
  source: null,
  confidence: null,
  error: null,
  calibratedFingerprint: null,
  stale: false,
}));

/** El número que `recorder.ts` usa para correr el clip hacia atrás. */
export function getLatencyCompensationSamples(): number {
  const s = useLatencyCalibrationStore.getState();
  return s.delaySamples > 0 ? s.delaySamples : 0;
}

// ── Ajustes persistidos ─────────────────────────────────────────────────

const SETTINGS_SAMPLES = 'inputLatencySamples';
const SETTINGS_SOURCE = 'inputLatencySource';
const SETTINGS_FINGERPRINT = 'inputLatencyFingerprint';

function persist(patch: Record<string, unknown>): void {
  void window.orbit?.settings.set(patch).catch(() => {
    // Sin puente de escritorio el ajuste vale para esta sesión y ya está.
  });
}

/**
 * Identifica "el aparato con este tamaño de buffer": dispositivo de entrada
 * elegido, sample rate y `baseLatency` del contexto, que en Chromium sigue
 * de cerca el tamaño de buffer real que negoció el driver. No hay una API
 * web que dé el tamaño de buffer en muestras de forma estable entre
 * navegadores — esto es la mejor aproximación sin código nativo, y basta
 * para el propósito de "avisar si ya no vale", no hace falta que sea exacta.
 */
function currentFingerprint(): string {
  const deviceId = useInputMonitorStore.getState().deviceId || '(sistema)';
  const sampleRate = engine.sampleRate;
  const baseLatency = engine.audioContext?.baseLatency ?? 0;
  return `${deviceId}|${sampleRate}|${Math.round(baseLatency * 1e6)}`;
}

/** Recalcula `stale` contra el fingerprint de ahora mismo. Llamar tras cualquier cambio de entrada. */
export function refreshStaleness(): void {
  const st = useLatencyCalibrationStore.getState();
  if (st.calibratedFingerprint === null) return;
  const stale = st.calibratedFingerprint !== currentFingerprint();
  if (stale !== st.stale) useLatencyCalibrationStore.setState({ stale });
}

export async function loadLatencySettings(): Promise<void> {
  const raw = (await window.orbit?.settings.get().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!raw) return;
  const patch: Partial<LatencyCalibrationState> = {};
  const samples = raw[SETTINGS_SAMPLES];
  if (typeof samples === 'number' && Number.isFinite(samples) && samples >= 0) {
    patch.delaySamples = Math.round(samples);
  }
  const source = raw[SETTINGS_SOURCE];
  if (source === 'measured' || source === 'manual') patch.source = source;
  const fingerprint = raw[SETTINGS_FINGERPRINT];
  if (typeof fingerprint === 'string') patch.calibratedFingerprint = fingerprint;
  if (Object.keys(patch).length > 0) useLatencyCalibrationStore.setState(patch);
  refreshStaleness();
}

/**
 * Ajuste a mano: quien conoce su interfaz sabe su cifra. No exige haber
 * calibrado antes ni toca `stale` — un valor puesto a mano es, por
 * definición, el que el usuario quiere usar ahora mismo.
 */
export function setLatencySamplesManually(samples: number): void {
  const value = Math.max(0, Math.round(samples));
  useLatencyCalibrationStore.setState({
    delaySamples: value,
    source: 'manual',
    confidence: null,
    error: null,
  });
  persist({ [SETTINGS_SAMPLES]: value, [SETTINGS_SOURCE]: 'manual' });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function concatMono(chunks: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Corre el bucle de calibración entero: chirp por los altavoces, captura por
 * el micro, correlación, y si pasa el umbral, guardado en ajustes.
 *
 * Rechaza arrancar si hay una toma en curso (le robaría los paquetes de
 * entrada a `pushInputChunk` — ver `recorder.ts`) y de forma simétrica
 * `recorder.ts` rechaza arrancar una toma mientras esto está en marcha.
 */
export async function runLatencyCalibration(): Promise<void> {
  const st = useLatencyCalibrationStore.getState();
  if (st.status === 'measuring') return;
  if (useRecorderStore.getState().phase !== 'idle') {
    useLatencyCalibrationStore.setState({
      status: 'error',
      error: 'Hay una toma en curso: para grabar antes de calibrar.',
    });
    return;
  }

  useLatencyCalibrationStore.setState({ status: 'measuring', error: null });

  let ownsInput = false;
  try {
    ensureAudioReady();
    await engine.init();
    const ctx = engine.audioContext;
    if (!ctx) throw new Error('El audio no ha arrancado');

    // Mismo cuidado que `recorder.ts:276`: si el monitor ya tiene el micro
    // abierto, se calibra con ESE — abrir un segundo `getUserMedia` sobre el
    // mismo aparato es pedirle al sistema dos capturas de un mismo micro.
    ownsInput = currentInputStream() === null;
    if (ownsInput && !(await startInputMonitor())) {
      throw new Error(useInputMonitorStore.getState().error ?? 'No se pudo abrir el micro');
    }

    const sampleRate = ctx.sampleRate;
    const probe = generateChirp({ sampleRate });
    const leadSamples = Math.round((CAPTURE_LEAD_MS / 1000) * sampleRate);
    const totalMs = CAPTURE_LEAD_MS + (probe.length / sampleRate) * 1000 + MAX_SEARCH_MS;
    const totalSamples = Math.ceil(((totalMs + CAPTURE_GUARD_MS) / 1000) * sampleRate);

    const chunks: Float32Array[] = [];
    let collected = 0;
    setRawInputSink((left) => {
      // Mono basta para correlacionar: el chirp sale por los dos canales
      // igual, así que el izquierdo ya trae la medida.
      chunks.push(left);
      collected += left.length;
    });
    engine.setInputCapture(true);

    // El chirp se programa por delante en el reloj de audio (no "ya"): así
    // el margen de CAPTURE_LEAD_MS absorbe la latencia del mensaje que activa
    // la captura, y el desfase entre "arranca la captura" y "arranca el
    // chirp" queda fijado a `leadSamples` con un error de un puñado de
    // muestras, no de un frame de medidores entero (~43 ms).
    const buffer = ctx.createBuffer(1, probe.length, sampleRate);
    // getChannelData + set en vez de copyToChannel: mismo choque de tipos de
    // Float32Array que ya documenta `master-stream.ts`.
    buffer.getChannelData(0).set(probe);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // DIRECTO a destino: no por el kernel/mesa de mezclas.
    src.connect(ctx.destination);
    src.start(ctx.currentTime + CAPTURE_LEAD_MS / 1000);

    const deadline = performance.now() + totalMs + CAPTURE_GUARD_MS + 1000;
    while (collected < totalSamples && performance.now() < deadline) {
      await wait(20);
    }

    engine.setInputCapture(false);
    setRawInputSink(null);
    if (ownsInput) stopInputMonitor();
    ownsInput = false;

    if (collected === 0) {
      useLatencyCalibrationStore.setState({
        status: 'error',
        error: 'No entró nada por el micro. ¿Está el aparato conectado y con permiso?',
      });
      return;
    }

    const captured = concatMono(chunks, collected);
    const result = estimateDelaySamples(probe, captured, { sampleRate });

    if (!result.ok) {
      const message =
        result.reason === 'silence'
          ? 'No llegó nada por el micro: con auriculares no hay bucle que medir. Prueba con un cable de salida a entrada, o altavoces con el micro delante.'
          : result.reason === 'too-short'
            ? 'La captura salió demasiado corta para medir.'
            : `La correlación salió floja (confianza ${(result.confidence * 100).toFixed(0)}%): puede que el volumen esté muy bajo o el micro muy lejos. No se guardó ningún número.`;
      useLatencyCalibrationStore.setState({ status: 'idle', error: message });
      return;
    }

    // El retardo de ida y vuelta es lo que se tardó DESDE que se programó el
    // chirp, no desde que arrancó la captura: se descuenta el margen.
    const roundTripSamples = result.delaySamples - leadSamples;
    if (roundTripSamples < 0) {
      // Correlacionó "antes" de cuando se programó el chirp: no puede ser un
      // eco real (nada puede volver antes de sonar). Señal de una medida
      // espuria — se rechaza en vez de guardar un negativo sin sentido.
      useLatencyCalibrationStore.setState({
        status: 'idle',
        error: 'La medida no tiene sentido (retardo negativo): repite la calibración.',
      });
      return;
    }

    const fingerprint = currentFingerprint();
    useLatencyCalibrationStore.setState({
      status: 'idle',
      delaySamples: roundTripSamples,
      source: 'measured',
      confidence: result.confidence,
      error: null,
      calibratedFingerprint: fingerprint,
      stale: false,
    });
    persist({
      [SETTINGS_SAMPLES]: roundTripSamples,
      [SETTINGS_SOURCE]: 'measured',
      [SETTINGS_FINGERPRINT]: fingerprint,
    });
  } catch (err) {
    if (ownsInput) stopInputMonitor();
    setRawInputSink(null);
    engine.setInputCapture(false);
    useLatencyCalibrationStore.setState({
      status: 'error',
      error: err instanceof Error ? err.message : 'No se pudo calibrar',
    });
  }
}

/** Milisegundos del retardo activo, para mostrarlo en la UI. */
export function latencyMs(): number {
  return samplesToMs(useLatencyCalibrationStore.getState().delaySamples, engine.sampleRate);
}
