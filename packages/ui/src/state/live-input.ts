/**
 * Entrada en vivo: tocar el canal seleccionado con un controlador MIDI
 * (Web MIDI) o con el teclado del PC (fila Z = octava central, fila Q = la
 * de arriba, estilo FL), y grabación MIDI armada: mientras suena el
 * transporte, lo tocado se acumula y al parar (o desarmar) cae al patrón
 * activo con los inicios cuantizados a 1/16 — en un solo undo.
 */

import { newId, type Note } from '@orbit/core';
import { create } from 'zustand';
import { engine, ensureAudioReady, store } from './app';
import { useUiStore } from './ui';

const SIXTEENTH = 0.25; // 1/16 en beats

export const useLiveInputStore = create<{
  /** Dispositivos MIDI de entrada conectados. */
  midiInputs: number;
  /** Grabación MIDI armada. */
  armed: boolean;
  /** Notas sonando ahora mismo (indicador). */
  heldKeys: number;
}>(() => ({ midiInputs: 0, armed: false, heldKeys: 0 }));

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
  engine.previewNote(ch.index, key, true);
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
  engine.previewNote(h.channelIndex, h.key, false);

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

/** Vuelca lo grabado al patrón activo (inicios cuantizados a 1/16). */
function commitRecording(): void {
  const notes = recorded;
  const channelId = recordChannelId;
  recorded = [];
  recordChannelId = null;
  if (notes.length === 0 || !channelId) return;
  const patternId = useUiStore.getState().activePatternId ?? store.project.patternOrder[0];
  if (!patternId || !store.project.channels[channelId]) return;
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

let wired = false;

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
    const note = KEY_TO_NOTE[e.key.toLowerCase()];
    if (note === undefined) return;
    noteOn(`pc:${e.key.toLowerCase()}`, note, 0.8);
  });
  window.addEventListener('keyup', (e) => {
    const note = KEY_TO_NOTE[e.key.toLowerCase()];
    if (note === undefined) return;
    noteOff(`pc:${e.key.toLowerCase()}`);
  });
  window.addEventListener('blur', () => {
    for (const source of [...held.keys()]) noteOff(source);
  });

  // ── Web MIDI ──
  const nav = navigator as Navigator & {
    requestMIDIAccess?: (opts?: { sysex?: boolean }) => Promise<MIDIAccess>;
  };
  if (!nav.requestMIDIAccess) return;
  void nav
    .requestMIDIAccess()
    .then((access) => {
      const attach = () => {
        let count = 0;
        for (const input of access.inputs.values()) {
          count++;
          input.onmidimessage = (e: MIDIMessageEvent) => {
            const data = e.data;
            if (!data || data.length < 3) return;
            const status = data[0]! & 0xf0;
            const key = data[1]!;
            const vel = data[2]!;
            if (status === 0x90 && vel > 0) noteOn(`midi:${key}`, key, vel / 127);
            else if (status === 0x80 || (status === 0x90 && vel === 0)) noteOff(`midi:${key}`);
          };
        }
        useLiveInputStore.setState({ midiInputs: count });
      };
      attach();
      access.onstatechange = attach;
    })
    .catch(() => {
      // sin permiso o sin soporte: el teclado del PC sigue funcionando
    });
}
