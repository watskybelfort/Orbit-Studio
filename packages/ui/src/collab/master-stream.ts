/**
 * Emitir el master propio a la sala y escuchar el de otro.
 *
 * Emitir: el kernel ya sabe copiar la salida post-fader de una pista (es lo
 * que usa "grabar la salida de una pista"); aquí se le pide la 0 —el master— y
 * cada trozo que llega con los medidores se manda a la sala en mono Int16.
 *
 * Escuchar: los trozos que llegan NO pasan por el kernel (no son del
 * proyecto): se meten en un AudioBuffer y se programan en el AudioContext de
 * la app, uno detrás de otro, con el colchón que decide `StreamClock`. Es
 * monitorización — para responder al "¿lo estás oyendo igual que yo?" — y por
 * eso lleva su propio volumen y no entra en el render de nadie.
 *
 * Solo puede haber UNA pista tapada en el kernel: si se está grabando la
 * salida de una pista, emitir se lo quitaría de debajo, así que no se deja.
 */

import { StreamClock, fromInt16, toMonoInt16, type AudioChunk } from '@orbit/collab';
import { create } from 'zustand';
import { engine } from '../state/app';
import { useTrackCapture } from '../state/track-capture';

/** Pista del mixer que se emite: el master. */
const MASTER_TRACK = 0;

interface MasterStreamState {
  /** Estamos emitiendo nuestro master a la sala. */
  broadcasting: boolean;
  /** clientID de a quién escuchamos, o null. */
  listeningTo: number | null;
  /** Volumen de lo que escuchamos (no toca el proyecto). */
  volume: number;
  /** Trozos recibidos desde que empezó la escucha (para verlo vivo). */
  received: number;
  /** Trozos tirados por ir demasiado por delante. */
  dropped: boolean;
  error: string | null;
}

export const useMasterStream = create<MasterStreamState>(() => ({
  broadcasting: false,
  listeningTo: null,
  volume: 0.9,
  received: 0,
  dropped: false,
  error: null,
}));

/** Lo cablea collab-state al abrir sesión (no importamos la sesión: círculo). */
let sendChunk: ((samples: Int16Array, sampleRate: number) => void) | null = null;

export function setStreamSender(
  send: ((samples: Int16Array, sampleRate: number) => void) | null,
): void {
  sendChunk = send;
  if (!send) stopBroadcast();
}

// ── Emitir ───────────────────────────────────────────────────────────────────

export function startBroadcast(): void {
  if (useMasterStream.getState().broadcasting) return;
  if (!sendChunk) {
    useMasterStream.setState({ error: 'Entra en una sala para emitir tu master.' });
    return;
  }
  if (useTrackCapture.getState().trackIndex !== null) {
    useMasterStream.setState({
      error: 'Estás grabando la salida de una pista: el kernel solo puede tapar una.',
    });
    return;
  }
  engine.setTrackCapture(MASTER_TRACK, true);
  useMasterStream.setState({ broadcasting: true, error: null });
}

export function stopBroadcast(): void {
  if (!useMasterStream.getState().broadcasting) return;
  // Solo se suelta el tap si no lo está usando la grabación de pista.
  if (useTrackCapture.getState().trackIndex === null) {
    engine.setTrackCapture(MASTER_TRACK, false);
  }
  useMasterStream.setState({ broadcasting: false });
}

export function toggleBroadcast(): void {
  if (useMasterStream.getState().broadcasting) stopBroadcast();
  else startBroadcast();
}

/**
 * Trozo de audio del kernel (lo llama el puente de medidores). Se manda tal
 * cual: el tamaño lo marca el propio kernel con su ventana de medidores.
 */
export function pushMasterStreamChunk(left: Float32Array, right: Float32Array): void {
  if (!useMasterStream.getState().broadcasting || !sendChunk) return;
  if (left.length === 0) return;
  sendChunk(toMonoInt16(left, right), engine.sampleRate);
}

// ── Escuchar ─────────────────────────────────────────────────────────────────

const clock = new StreamClock();
let gain: GainNode | null = null;

/** Nodo de salida de la escucha (se crea con el AudioContext ya despierto). */
function output(ctx: AudioContext): GainNode {
  if (!gain || gain.context !== ctx) {
    gain = ctx.createGain();
    gain.connect(ctx.destination);
  }
  gain.gain.value = useMasterStream.getState().volume;
  return gain;
}

export function listenTo(clientId: number): void {
  clock.reset();
  useMasterStream.setState({ listeningTo: clientId, received: 0, dropped: false, error: null });
}

export function stopListening(): void {
  clock.reset();
  useMasterStream.setState({ listeningTo: null });
}

export function setStreamVolume(volume: number): void {
  const clamped = Math.min(1.5, Math.max(0, volume));
  useMasterStream.setState({ volume: clamped });
  if (gain) gain.gain.value = clamped;
}

/** Llega un trozo de la sala: se programa detrás de lo que ya suena. */
export function playIncomingChunk(chunk: AudioChunk): void {
  const state = useMasterStream.getState();
  if (state.listeningTo !== chunk.from) return;
  const ctx = engine.audioContext;
  // Sin AudioContext (nadie ha tocado nada aún) no hay dónde sacarlo.
  if (!ctx) return;

  const duration = chunk.samples.length / chunk.sampleRate;
  const plan = clock.plan(ctx.currentTime, duration);
  if (plan.dropped) {
    useMasterStream.setState({ dropped: true });
    return;
  }

  const buffer = ctx.createBuffer(1, chunk.samples.length, chunk.sampleRate);
  // getChannelData + set en vez de copyToChannel: el tipo de Float32Array que
  // devuelve fromInt16 no encaja con la firma de copyToChannel en TS 5.7.
  buffer.getChannelData(0).set(fromInt16(chunk.samples));
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(output(ctx));
  source.start(plan.at);
  useMasterStream.setState({ received: state.received + 1, dropped: false });
}

/** Al salir de la sala: ni se emite ni se escucha. */
export function resetMasterStream(): void {
  stopBroadcast();
  stopListening();
  useMasterStream.setState({ received: 0, dropped: false, error: null });
}
