/**
 * Entrada en vivo: tocar el canal seleccionado con un controlador MIDI
 * (Web MIDI) o con el teclado del PC (fila Z = octava central, fila Q = la
 * de arriba, estilo FL), y grabación MIDI armada: mientras suena el
 * transporte, lo tocado se acumula y al parar (o desarmar) cae al patrón
 * activo con los inicios cuantizados a 1/16 — en un solo undo.
 *
 * Los controladores no se tratan como "una entrada MIDI genérica": cada
 * dispositivo se enciende y se apaga por su cuenta (el teclado maestro sí, la
 * superficie de mandos no), se elige qué canal se escucha, cuántas octavas se
 * transpone y con qué curva pega el teclado. El pedal de sostenido (CC 64) va
 * por dispositivo, en `sustain.ts`. La lectura de los bytes vive en
 * `midi-message.ts`. Las dos piezas se prueban sin hardware.
 */


import { newId, type Note } from '@orbit/core';
import { create } from 'zustand';
import { ensureAudioReady, store } from './app';
import { previewNote } from './active-notes';
import {
  applyVelocityCurve,
  channelMatches,
  isVelocityCurve,
  parseMidiMessage,
  transposeKey,
  type VelocityCurve,
} from './midi-message';
import { SustainPedal } from './sustain';
import { useUiStore } from './ui';

const SIXTEENTH = 0.25; // 1/16 en beats

/** Un controlador conectado. */
export interface MidiDeviceInfo {
  id: string;
  name: string;
  /** Lo apaga el usuario en Ajustes (se recuerda entre sesiones). */
  enabled: boolean;
}

export const useLiveInputStore = create<{
  /** Dispositivos MIDI de entrada ACTIVOS (los que están escuchando). */
  midiInputs: number;
  /** Todos los conectados, encendidos o no. */
  devices: MidiDeviceInfo[];
  /** Grabación MIDI armada. */
  armed: boolean;
  /** Notas sonando ahora mismo (indicador). */
  heldKeys: number;
  /** Notas que solo siguen sonando porque el pedal está pisado. */
  sustainedKeys: number;

  /** `performance.now()` del último mensaje que entró (LED de actividad). */
  lastMessageAt: number;
  /** Canal que se escucha: 0 = todos. */
  channel: number;
  /** Octavas de transposición de lo que entra (teclado del PC incluido). */
  octave: number;
  velocityCurve: VelocityCurve;
}>(() => ({
  midiInputs: 0,
  devices: [],
  armed: false,
  heldKeys: 0,
  sustainedKeys: 0,
  lastMessageAt: 0,

  channel: 0,
  octave: 0,
  velocityCurve: 'linear',
}));

/** Nota MIDI por tecla del PC (fila Z = C4=60, fila Q = C5=72). */
const KEY_TO_NOTE: Record<string, number> = {
  z: 60, s: 61, x: 62, d: 63, c: 64, v: 65, g: 66, b: 67, h: 68, n: 69, j: 70, m: 71, ',': 72,
  q: 72, '2': 73, w: 74, '3': 75, e: 76, r: 77, '5': 78, t: 79, '6': 80, y: 81, '7': 82, u: 83, i: 84,
};

interface HeldNote {
  key: number;
  velocity: number;
  startBeat: number;
  channelIndex: number;
}

const held = new Map<string, HeldNote>();
/** Pedal de sostenido (CC 64), por dispositivo. */
const pedal = new SustainPedal();

let recorded: { key: number; velocity: number; start: number; duration: number }[] = [];
let recordChannelId: string | null = null;

function targetChannel(): { id: string; index: number } | null {
  const order = store.project.channelOrder;
  const id = useUiStore.getState().pianoRollChannelId ?? order[order.length - 1] ?? null;
  if (!id) return null;
  const index = order.indexOf(id);
  return index >= 0 ? { id, index } : null;
}

function noteOn(source: string, key: number, velocity: number): void {
  if (held.has(source)) return;
  const ch = targetChannel();
  if (!ch) return;
  ensureAudioReady();
  previewNote(ch.index, key, true);
  held.set(source, {
    key,
    velocity,
    startBeat: useUiStore.getState().positionBeats,
    channelIndex: ch.index,
  });
  useLiveInputStore.setState({ heldKeys: held.size });
  const st = useLiveInputStore.getState();
  if (st.armed && useUiStore.getState().playing) recordChannelId = ch.id;
}

function noteOff(source: string): void {
  const h = held.get(source);
  if (!h) return;
  held.delete(source);
  useLiveInputStore.setState({ heldKeys: held.size });
  previewNote(h.channelIndex, h.key, false);

  const ui = useUiStore.getState();
  if (useLiveInputStore.getState().armed && ui.playing) {
    // Si el patrón dio la vuelta mientras sonaba, la duración sale negativa:
    // se recorta a una semicorchea en vez de perder la nota.
    const raw = ui.positionBeats - h.startBeat;
    recorded.push({
      key: h.key,
      velocity: h.velocity,
      start: h.startBeat,
      duration: raw > 0 ? Math.max(SIXTEENTH, raw) : SIXTEENTH,
    });
  }
}

/** Suelta lo que esté pulsado (todo, o solo lo de un prefijo de fuente). */
function releaseAll(prefix = ''): void {
  // El pedal se olvida ANTES: si no, sus notas retenidas se saltarían el
  // note-off de abajo y se quedarían sonando sin nadie que las suelte.
  if (prefix === '') pedal.clear();
  for (const source of [...held.keys()]) {
    if (prefix === '' || source.startsWith(prefix)) noteOff(source);
  }
  useLiveInputStore.setState({ sustainedKeys: pedal.holding });
}

/** Vuelca lo grabado al patrón activo (inicios cuantizados a 1/16). */
function commitRecording(): void {
  const notes = recorded;
  const channelId = recordChannelId;
  recorded = [];
  recordChannelId = null;
  if (notes.length === 0 || !channelId) return;
  // El patrón activo es estado de UI y NADIE lo limpia al borrarlo: si apunta a
  // uno que ya no existe hay que caer al primero, o el addNotes de abajo tiraría
  // por el `must` de core y la toma se perdería con una excepción.
  const active = useUiStore.getState().activePatternId;
  const patternId =
    active !== null && store.project.patterns[active] ? active : store.project.patternOrder[0];
  if (!patternId || !store.project.patterns[patternId] || !store.project.channels[channelId]) {
    return;
  }
  const out: Note[] = notes.map((n) => ({
    id: newId(),
    key: n.key,
    start: Math.round(n.start / SIXTEENTH) * SIXTEENTH,
    duration: n.duration,
    velocity: n.velocity,
    pan: 0,
    slide: false,
  }));
  store.dispatch(
    { type: 'addNotes', patternId, channelId, notes: out },
    { label: `Grabación MIDI (${out.length} notas)` },
  );
}

/** Arma/desarma la grabación MIDI; al desarmar vuelca lo pendiente. */
export function toggleMidiArmed(): void {
  const next = !useLiveInputStore.getState().armed;
  useLiveInputStore.setState({ armed: next });
  if (!next) commitRecording();
}

// ── Ajustes de entrada (persistidos en settings.json) ───────────────────────

const SETTINGS_CHANNEL = 'midiInputChannel';
const SETTINGS_OCTAVE = 'midiInputOctave';
const SETTINGS_CURVE = 'midiInputVelocityCurve';
const SETTINGS_DISABLED = 'midiInputDisabled';

/** Ids de dispositivo que el usuario apagó (se recuerdan entre sesiones). */
let disabledIds = new Set<string>();

function persist(patch: Record<string, unknown>): void {
  void window.orbit?.settings.set(patch).catch(() => {
    // Sin puente de escritorio el ajuste vale para esta sesión y ya está.
  });
}

/** Canal MIDI que se escucha (0 = todos). */
export function setMidiChannel(channel: number): void {
  const value = Math.min(16, Math.max(0, Math.round(channel)));
  useLiveInputStore.setState({ channel: value });
  persist({ [SETTINGS_CHANNEL]: value });
}

/** Transposición en octavas de lo que entra. */
export function setMidiOctave(octave: number): void {
  const value = Math.min(4, Math.max(-4, Math.round(octave)));
  // Lo que ya está pulsado se suelta: si no, su note-off llegaría con la
  // transposición NUEVA y la nota vieja se quedaría sonando sola.
  releaseAll();
  useLiveInputStore.setState({ octave: value });
  persist({ [SETTINGS_OCTAVE]: value });
}

export function setMidiVelocityCurve(curve: VelocityCurve): void {
  useLiveInputStore.setState({ velocityCurve: curve });
  persist({ [SETTINGS_CURVE]: curve });
}

/** Prefijo de fuente de un dispositivo (para soltar solo lo suyo). */
function sourcePrefix(deviceId: string): string {
  return 'midi:' + deviceId + ':';
}

/** Enciende o apaga un controlador concreto. */
export function setMidiDeviceEnabled(id: string, enabled: boolean): void {
  if (enabled) disabledIds.delete(id);
  else disabledIds.add(id);
  persist({ [SETTINGS_DISABLED]: [...disabledIds] });
  // Apagar un teclado con el pedal pisado dejaba sus notas sonando: nadie iba
  // a mandar ya el CC 64 con valor 0.
  for (const source of pedal.forgetDevice(id)) noteOff(source);
  releaseAll(sourcePrefix(id));
  reattach?.();

}

async function loadSettings(): Promise<void> {
  const raw = (await window.orbit?.settings.get().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!raw) return;
  const patch: Partial<{ channel: number; octave: number; velocityCurve: VelocityCurve }> = {};
  const channel = raw[SETTINGS_CHANNEL];
  if (typeof channel === 'number') patch.channel = Math.min(16, Math.max(0, Math.round(channel)));
  const octave = raw[SETTINGS_OCTAVE];
  if (typeof octave === 'number') patch.octave = Math.min(4, Math.max(-4, Math.round(octave)));
  const curve = raw[SETTINGS_CURVE];
  if (isVelocityCurve(curve)) patch.velocityCurve = curve;
  const disabled = raw[SETTINGS_DISABLED];
  if (Array.isArray(disabled)) {
    disabledIds = new Set(disabled.filter((v): v is string => typeof v === 'string'));
  }
  if (Object.keys(patch).length > 0) useLiveInputStore.setState(patch);
  // Los ajustes llegan por IPC, o sea DESPUÉS de haberse repartido los
  // manejadores: hay que repartirlos otra vez con la lista de apagados puesta.
  reattach?.();
}

// Gancho de QA solo-dev: inspeccionar el estado de entrada en vivo desde CDP.
const env = (import.meta as { env?: { DEV?: boolean } }).env;
if (env?.DEV === true && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__orbitLive'] = useLiveInputStore;
  (window as unknown as Record<string, unknown>)['__orbitLiveDebug'] = () => ({
    held: held.size,
    recorded: recorded.length,
    recordChannelId,
  });
}

let wired = false;
/** Vuelve a repartir los manejadores (al cambiar qué está encendido). */
let reattach: (() => void) | null = null;

export function initLiveInput(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;

  // Al parar el transporte con la grabación armada, se vuelca lo tocado.
  useUiStore.subscribe((s, prev) => {
    if (prev.playing && !s.playing && useLiveInputStore.getState().armed) commitRecording();
  });

  // ── Teclado del PC ──
  const typing = (): boolean => {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
  };
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    const base = KEY_TO_NOTE[e.key.toLowerCase()];
    if (base === undefined) return;
    const note = transposeKey(base, useLiveInputStore.getState().octave);
    if (note === null) return;
    noteOn('pc:' + e.key.toLowerCase(), note, 0.8);
  });
  window.addEventListener('keyup', (e) => {
    const note = KEY_TO_NOTE[e.key.toLowerCase()];
    if (note === undefined) return;
    noteOff('pc:' + e.key.toLowerCase());
  });
  window.addEventListener('blur', () => releaseAll());

  void loadSettings();

  // ── Web MIDI ──
  const nav = navigator as Navigator & {
    requestMIDIAccess?: (opts?: { sysex?: boolean }) => Promise<MIDIAccess>;
  };
  if (!nav.requestMIDIAccess) return;
  void nav
    .requestMIDIAccess()
    .then((access) => {
      const attach = () => {
        const devices: MidiDeviceInfo[] = [];
        for (const input of access.inputs.values()) {
          const id = input.id;
          const enabled = !disabledIds.has(id);
          devices.push({ id, name: input.name ?? 'Controlador MIDI', enabled });
          // Apagado = sin manejador. No basta con filtrar dentro: apagar un
          // controlador tiene que dejarlo mudo del todo, LED de actividad
          // incluido.
          input.onmidimessage = enabled ? (e: MIDIMessageEvent) => handleMidi(id, e) : null;
        }
        useLiveInputStore.setState({
          devices,
          midiInputs: devices.filter((d) => d.enabled).length,
        });
      };
      reattach = attach;
      attach();
      access.onstatechange = attach;
    })
    .catch(() => {
      // sin permiso o sin soporte: el teclado del PC sigue funcionando
    });
}

/** Un mensaje de un controlador encendido. */
function handleMidi(deviceId: string, e: MIDIMessageEvent): void {
  const data = e.data;
  if (!data) return;
  const msg = parseMidiMessage(data);
  if (!msg) return;
  const st = useLiveInputStore.getState();
  if (!channelMatches(msg.channel, st.channel)) return;
  useLiveInputStore.setState({ lastMessageAt: performance.now() });

  // La fuente lleva el dispositivo y la tecla SIN transponer: así el note-off
  // encuentra su nota aunque la octava haya cambiado con la tecla pulsada, y
  // dos teclados en el mismo do no se pisan el uno al otro.
  switch (msg.kind) {
    case 'noteOn': {
      const key = transposeKey(msg.key, st.octave);
      if (key === null) return;
      const source = sourcePrefix(deviceId) + msg.key;
      // Repicar una tecla que el pedal retiene: hay que soltarla antes, o el
      // note-on se ignora (esa fuente ya suena) y la nota nueva no ataca.
      if (pedal.takeRetrigger(source)) noteOff(source);
      noteOn(source, key, applyVelocityCurve(msg.velocity, st.velocityCurve));
      useLiveInputStore.setState({ sustainedKeys: pedal.holding });
      break;
    }
    case 'noteOff': {
      const source = sourcePrefix(deviceId) + msg.key;
      if (pedal.holdNoteOff(deviceId, source)) {
        useLiveInputStore.setState({ sustainedKeys: pedal.holding });
      } else {
        noteOff(source);
      }
      break;
    }
    case 'sustain':
      if (msg.down) {
        pedal.press(deviceId);
      } else {
        for (const source of pedal.release(deviceId)) noteOff(source);
      }
      useLiveInputStore.setState({ sustainedKeys: pedal.holding });
      break;
    case 'allNotesOff':
      // El panic del teclado se lleva por delante su pedal también.
      for (const source of pedal.forgetDevice(deviceId)) noteOff(source);
      releaseAll(sourcePrefix(deviceId));
      break;
    default:
      break;
  }
}

