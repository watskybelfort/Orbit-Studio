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

import {
  MAX_INPUT_CHANNELS,
  MAX_INPUT_ROUTES,
  createInputRoute,
  inputRouteLabel,
  inputRoutesSignature,
  projectInputRoutes,
  resolveInputRoutes,
  type Command,
  type Id,
  type InputRoute,
  type ResolvedInputRoute,
} from '@orbit/core';
import { create } from 'zustand';
import { engine, ensureAudioReady, store } from './app';

export interface InputDevice {
  id: string;
  label: string;
  /**
   * Entradas que declara el aparato. El navegador solo lo cuenta DESPUÉS de
   * dar permiso al micro, así que antes de abrirlo la primera vez esto no
   * está (ver `openStream`).
   */
  channels?: number;
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
  /**
   * Canales del aparato abierto ahora mismo (0 = no hay micro abierto). Es lo
   * que decide qué rutas de entrada se pueden usar de verdad.
   */
  channelCount: number;
  /**
   * Pico por ruta, en el orden de `resolveInputRoutes`. Con dos micros a la
   * vez es lo único que dice cuál de los dos está saturando.
   */
  routePeaks: number[];
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
  channelCount: 0,
  routePeaks: [],
  error: null,
}));

/** Stream abierto ahora mismo y su nodo en el grafo. */
let stream: MediaStream | null = null;
let source: MediaStreamAudioSourceNode | null = null;

/** Lo llama el bucle de medidores del kernel. */
export function setInputPeak(peak: number): void {
  const st = useInputMonitorStore.getState();
  // Los picos por ruta salen del MISMO frame que acaba de llegar: el motor
  // guarda el frame en `lastMeters` justo antes de avisar, así que leerlo aquí
  // es leer el de ahora. Va por aquí y no por otro gancho para que el puente
  // de medidores siga siendo una sola llamada.
  const perRoute = engine.lastMeters?.inputPeaks;
  if (perRoute && perRoute.length > 0) {
    const next = Array.from(perRoute);
    const prev = st.routePeaks;
    const changed =
      prev.length !== next.length ||
      next.some((v, i) => Math.abs(v - (prev[i] ?? 0)) >= 0.002);
    if (changed) useInputMonitorStore.setState({ routePeaks: next });
  } else if (st.routePeaks.length > 0 && !st.listening) {
    useInputMonitorStore.setState({ routePeaks: [] });
  }
  // Solo se escribe si cambia de verdad: esto entra ~20 veces por segundo y
  // repintar toda la UI por un cero constante no tiene sentido.
  if (!st.listening && st.peak === 0) return;
  if (Math.abs(st.peak - peak) < 0.002) return;
  useInputMonitorStore.setState({ peak });
}

/**
 * Las rutas de entrada efectivas AHORA: las del proyecto resueltas contra el
 * aparato abierto. Sin rutas declaradas sale la implícita —el par 1-2 con los
 * ajustes de esta pantalla—, que es el comportamiento de siempre.
 *
 * Es la fuente única para la UI, el motor y el grabador: si cada uno
 * resolviera por su cuenta, el índice de una ruta podría no significar lo
 * mismo en los tres, y ese índice es justo lo que enlaza una toma con su pista.
 */
export function currentInputRoutes(): ResolvedInputRoute[] {
  const st = useInputMonitorStore.getState();
  return resolveInputRoutes(store.project, {
    ...(st.channelCount > 0 ? { channelCount: st.channelCount } : null),
    fallback: { mixerTrack: st.trackIndex, gain: st.gain, monitor: st.monitor },
  });
}

/** Última firma enviada al kernel (para no repetir el mismo enrutado). */
let lastRoutesSent: string | null = null;

/**
 * Manda al kernel el enrutado de entrada. Se llama en cada cambio del
 * proyecto, así que se compara la firma antes: renombrar una entrada no es un
 * mensaje al motor.
 */
function pushRoutes(): void {
  const routes = currentInputRoutes();
  const signature = inputRoutesSignature(routes);
  if (signature === lastRoutesSent) return;
  lastRoutesSent = signature;
  engine.setInputRoutes(
    routes.map((r) => ({
      srcL: r.srcL,
      srcR: r.srcR,
      mixerTrack: r.mixerTrack,
      gain: r.gain,
      monitor: r.monitor,
    })),
  );
}

/**
 * El enrutado vive en el PROYECTO, así que cambia por el bus de comandos
 * —también desde la sala o desde un undo— y no solo desde esta pantalla. La
 * suscripción se engancha al abrir el micro y no al cargar el módulo: `store`
 * viene de `./app`, que a su vez importa esto, y usarlo en la evaluación del
 * módulo sería usarlo a medio construir.
 */
let unsubscribeProject: (() => void) | null = null;

function watchProject(): void {
  if (unsubscribeProject) return;
  unsubscribeProject = store.subscribe(() => pushRoutes());
}

/** Manda al kernel el estado actual. */
function push(): void {
  const { listening, monitor, trackIndex, gain } = useInputMonitorStore.getState();
  engine.setLiveInput(listening, monitor, trackIndex, gain);
  pushRoutes();
}

/**
 * Fuente del micro; inyectable para QA igual que en el grabador (fuente
 * sintética, sin micro real).
 *
 * `channels` pide las entradas REALES del aparato en vez del estéreo de
 * siempre. Va como `ideal` y no como `exact` a propósito: un aparato que no
 * las tenga tiene que abrirse igual con las que tenga, no fallar.
 */
let streamFactory: (deviceId: string, channels?: number) => Promise<MediaStream> = (
  deviceId,
  channels,
) =>
  navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : null),
      ...(channels && channels > 1 ? { channelCount: { ideal: channels } } : null),
      // Nada de procesado del navegador: la cadena la pone Orbit. El
      // cancelador de eco además se come el beat que suena por los altavoces
      // y hace cosas raras con la voz cantada.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

export function setInputStreamFactory(
  f: (deviceId: string, channels?: number) => Promise<MediaStream>,
): void {
  streamFactory = f;
}

/** Canales que trae un stream ya abierto (1 si el navegador no lo dice). */
function streamChannels(media: MediaStream): number {
  const settings = media.getAudioTracks()[0]?.getSettings();
  const count = settings?.channelCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0
    ? Math.min(MAX_INPUT_CHANNELS, Math.round(count))
    : 1;
}

/** El deviceId REAL del stream abierto (el elegido, o el que puso el sistema). */
function streamDeviceId(media: MediaStream, chosen: string): string {
  if (chosen) return chosen;
  const id = media.getAudioTracks()[0]?.getSettings().deviceId;
  return typeof id === 'string' ? id : '';
}

/** Entradas que declara un aparato de la lista (undefined = todavía no se sabe). */
function knownChannels(deviceId: string): number | undefined {
  if (!deviceId) return undefined;
  return useInputMonitorStore.getState().devices.find((d) => d.id === deviceId)?.channels;
}

/**
 * Abre el micro con TODAS sus entradas.
 *
 * El navegador no cuenta las entradas de un aparato hasta que se le ha dado
 * permiso: la primera vez que se abre no hay forma de pedir las ocho de una
 * interfaz porque todavía no se sabe que son ocho. Así que se abre a lo que
 * dé, se relee la lista —que ahora ya trae las capacidades— y si resulta que
 * el aparato tiene más de las que se abrieron, se reabre UNA vez pidiéndolas.
 *
 * Reabrir es barato (el permiso ya está dado) y es lo único que evita que en
 * el primer arranque con una interfaz de verdad se queden seis entradas fuera
 * sin que nada lo explique.
 */
async function openStream(deviceId: string): Promise<{ media: MediaStream; channels: number }> {
  let media = await streamFactory(deviceId, knownChannels(deviceId));
  let channels = streamChannels(media);
  await refreshInputDevices();
  const max = knownChannels(streamDeviceId(media, deviceId));
  if (max !== undefined && max > channels) {
    media.getTracks().forEach((t) => t.stop());
    media = await streamFactory(deviceId, max);
    channels = streamChannels(media);
  }
  return { media, channels };
}

/** Cierra el micro y lo desengancha del kernel. */
export function stopInputMonitor(): void {
  source?.disconnect();
  source = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  useInputMonitorStore.setState({
    listening: false,
    monitor: false,
    peak: 0,
    // Con el micro cerrado no se sabe cuántas entradas hay: dejar el número
    // puesto marcaría como disponibles rutas que ahora mismo no lo están.
    channelCount: 0,
    routePeaks: [],
  });
  push();
}

/** Abre el micro (sin sacarlo todavía por los altavoces). */
export async function startInputMonitor(): Promise<boolean> {
  if (stream) return true;
  try {
    ensureAudioReady();
    await engine.init();
    const { deviceId } = useInputMonitorStore.getState();
    const opened = await openStream(deviceId);
    stream = opened.media;
    // El nodo del kernel se ensancha a las entradas del aparato: sin esto el
    // grafo mezclaría la interfaz de ocho a dos canales y los otros seis se
    // perderían antes de que nadie pudiera elegirlos.
    source = engine.connectInput(stream, opened.channels);
    if (!source) throw new Error('El audio no ha arrancado');
    useInputMonitorStore.setState({
      listening: true,
      error: null,
      channelCount: opened.channels,
    });
    // La cuenta de canales cambia qué rutas están disponibles, así que el
    // enrutado se remanda entero (su firma es otra).
    push();
    watchProject();
    return true;
  } catch (err) {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    source = null;
    useInputMonitorStore.setState({
      listening: false,
      monitor: false,
      channelCount: 0,
      routePeaks: [],
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

// ── Enrutado de entrada: acciones ───────────────────────────────────────────
//
// Todas pasan por `store.dispatch`, nunca escriben el proyecto a mano: el
// enrutado es parte del proyecto, así que tiene undo, viaja a la sala y se
// guarda en el `.orbit` como cualquier otra cosa. Escribirlo desde aquí sería
// romper las dos.

/** El primer canal físico que no esté ya cogido por otra ruta. */
function firstFreeChannel(routes: readonly InputRoute[], total: number): number {
  const used = new Set<number>();
  for (const r of routes) {
    used.add(r.channel);
    if (r.channelRight !== undefined) used.add(r.channelRight);
  }
  for (let c = 0; c < total; c++) if (!used.has(c)) return c;
  return 0;
}

/**
 * Añade una entrada. Si el proyecto todavía no declaraba ninguna, primero se
 * hace EXPLÍCITA la de siempre (el par 1-2 con los ajustes de esta pantalla) y
 * después se añade la nueva, todo en un paso de undo.
 *
 * Ese primer paso no es ceremonia: en cuanto hay una ruta declarada, la
 * implícita deja de existir. Sin materializarla, pulsar "añadir" movería el
 * micro que ya estaba sonando a otra entrada sin que nadie lo hubiera pedido.
 */
export function addInputRoute(): void {
  const declared = projectInputRoutes(store.project);
  if (declared.length >= MAX_INPUT_ROUTES) return;
  const st = useInputMonitorStore.getState();
  const total = Math.max(2, st.channelCount || 2);
  const commands: Command[] = [];
  const routes: InputRoute[] = [...declared];

  if (declared.length === 0) {
    const base = createInputRoute(0, 1, inputRouteLabel(0, 1));
    base.mixerTrack = st.trackIndex;
    base.gain = st.gain;
    base.monitor = st.monitor;
    commands.push({ type: 'addInputRoute', route: base });
    routes.push(base);
  }
  if (routes.length < MAX_INPUT_ROUTES) {
    const channel = firstFreeChannel(routes, Math.max(total, routes.length * 2 + 2));
    // Mono de fábrica: una entrada nueva es un micro hasta que se diga lo
    // contrario, y un micro en estéreo es medio canal de silencio.
    const route = createInputRoute(channel);
    route.mixerTrack = Math.max(1, st.trackIndex);
    commands.push({ type: 'addInputRoute', route });
  }

  const label = commands.length > 1 ? 'Configurar entradas' : 'Añadir entrada';
  store.dispatch({ type: 'batch', label, commands }, { label });
}

export function removeInputRoute(routeId: Id): void {
  store.dispatch({ type: 'removeInputRoute', routeId });
}

export function patchInputRoute(routeId: Id, patch: Partial<Omit<InputRoute, 'id'>>): void {
  store.dispatch({ type: 'patchInputRoute', routeId, patch });
}

/**
 * Cambia los canales físicos de una entrada. `right === null` la vuelve MONO,
 * que es lo que quiere un micro: su canal a los dos lados.
 */
export function setInputRouteChannels(routeId: Id, left: number, right: number | null): void {
  const route = store.project.inputRoutes[routeId];
  if (!route) return;
  const patch: Partial<Omit<InputRoute, 'id'>> = { channel: left };
  // `undefined` se pierde al serializar el comando (y por la sala no llegaría
  // a quitar nada), así que el mono se pide con el mismo canal a los dos
  // lados y `normalizeInputRoute`/el resolutor lo entienden igual.
  patch.channelRight = right === null ? left : right;
  // Nombre por defecto: si el usuario no lo tocó, sigue el par.
  if (route.name === inputRouteLabel(route.channel, route.channelRight)) {
    patch.name = inputRouteLabel(left, right === null ? undefined : right);
  }
  store.dispatch({ type: 'patchInputRoute', routeId, patch }, { label: 'Canales de la entrada' });
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
      .map((d, i) => {
        // `getCapabilities` solo existe en Chromium y solo dice la verdad con
        // el permiso ya dado; sin él la entrada se queda sin cuenta de canales
        // y se abre a lo que el sistema dé, como siempre.
        const caps = (
          d as MediaDeviceInfo & {
            getCapabilities?: () => { channelCount?: { max?: number } };
          }
        ).getCapabilities?.();
        const max = caps?.channelCount?.max;
        return {
          id: d.deviceId,
          label: d.label || `Entrada ${i + 1}`,
          ...(typeof max === 'number' && Number.isFinite(max) && max > 0
            ? { channels: Math.min(MAX_INPUT_CHANNELS, Math.round(max)) }
            : null),
        };
      });
    useInputMonitorStore.setState({ devices });
  } catch {
    // Sin permiso todavía: la lista se queda como esté.
  }
}

/** El stream abierto, para que el grabador no abra un SEGUNDO micro. */
export function currentInputStream(): MediaStream | null {
  return stream;
}
