/**
 * MIDI learn: atar un mando físico a CUALQUIER parámetro del proyecto.
 *
 * Clic derecho en la perilla → "Aprender MIDI" → mueves el mando del
 * controlador y quedan casados. A partir de ahí ese mando escribe el destino
 * por el bus de comandos (`paramRefCommand`), así que tiene undo y viaja a la
 * sala como cualquier otro cambio.
 *
 * **El mapa va por mando, no por dispositivo.** La clave es `cc:74`, no
 * "cc 74 del teclado tal": desenchufar el controlador y volver a enchufarlo en
 * otro puerto USB le cambia el id, y perder todos los mapeos por eso sería
 * absurdo. Qué dispositivos entran ya lo decide `live-input.ts` (se apagan uno
 * a uno) y qué canal se escucha también.
 *
 * Los mensajes de un mando llegan a ~1 kHz. Despachar un comando por mensaje
 * ahogaría al motor recompilando el proyecto, así que se guarda el ÚLTIMO
 * valor de cada origen y se vuelca una vez por frame.
 */

import { describeParamRef, paramRefCommand, paramRefKey, type ParamRef } from '@orbit/core';

import { create } from 'zustand';
import { store } from './app';

/** Un mando atado a un destino. */
export interface MidiMapping {
  /** Origen: `cc:<0..127>` o `bend`. */
  source: string;
  ref: ParamRef;
}

export const SOURCE_BEND = 'bend';

/** Clave de origen de un control continuo. */
export function ccSource(controller: number): string {
  return 'cc:' + Math.round(controller);
}

/** Nombre legible de un origen ("CC 74", "Rueda de modulación"…). */
export function midiSourceLabel(source: string): string {
  if (source === SOURCE_BEND) return 'Rueda de tono';
  if (source === 'cc:1') return 'Rueda de modulación';
  if (source === 'cc:11') return 'Pedal de expresión';
  const cc = source.startsWith('cc:') ? source.slice(3) : null;
  return cc === null ? source : 'CC ' + cc;
}

/** ¿Esto que salió de settings.json es un ParamRef de verdad? */
function isParamRef(value: unknown): value is ParamRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  switch (ref['kind']) {
    case 'channel':
    case 'channelMix':
      return typeof ref['channelId'] === 'string' && typeof ref['param'] === 'string';
    case 'mixer':
      return typeof ref['trackIndex'] === 'number' && typeof ref['param'] === 'string';
    case 'effect':
      return (
        typeof ref['trackIndex'] === 'number' &&
        typeof ref['slotIndex'] === 'number' &&
        typeof ref['param'] === 'string'
      );
    case 'channelFx':
      return (
        typeof ref['channelId'] === 'string' &&
        typeof ref['slotIndex'] === 'number' &&
        typeof ref['param'] === 'string'
      );
    case 'transport':
      return ref['param'] === 'tempo' || ref['param'] === 'swing';
    default:
      return false;
  }
}

/**
 * Lee la tabla de mapeos de settings.json descartando lo que no cuadre. El
 * archivo lo puede haber tocado cualquiera y un mapeo roto no puede impedir
 * que carguen los demás.
 */
export function parseMidiMappings(raw: unknown): MidiMapping[] {
  if (!Array.isArray(raw)) return [];
  const out: MidiMapping[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const m = item as Record<string, unknown>;
    const source = m['source'];
    if (typeof source !== 'string' || source === '') continue;
    if (!(source === SOURCE_BEND || /^cc:(?:\d|[1-9]\d|1[01]\d|12[0-7])$/.test(source))) continue;
    if (!isParamRef(m['ref'])) continue;
    // Un origen, un destino: si el archivo trae dos, manda el último escrito.
    if (seen.has(source)) {
      const at = out.findIndex((x) => x.source === source);
      if (at >= 0) out.splice(at, 1);
    }
    seen.add(source);
    out.push({ source, ref: m['ref'] });
  }
  return out;
}

interface MidiLearnState {
  /** Mapeos por origen. */
  mappings: Record<string, MidiMapping>;
  /** Destino esperando a que muevas un mando (null = no estamos aprendiendo). */
  learning: ParamRef | null;
  /** Último origen que se movió: el rótulo del panel y del aviso de aprender. */
  lastSource: string | null;
}

export const useMidiLearnStore = create<MidiLearnState>(() => ({
  mappings: {},
  learning: null,
  lastSource: null,
}));

const SETTINGS_KEY = 'midiMappings';

function persistMappings(): void {
  const list = Object.values(useMidiLearnStore.getState().mappings);
  void window.orbit?.settings.set({ [SETTINGS_KEY]: list }).catch(() => {
    // Sin puente de escritorio los mapeos valen para esta sesión.
  });
}

/** Carga los mapeos guardados (lo llama `initLiveInput`). */
export async function loadMidiMappings(): Promise<void> {
  const raw = (await window.orbit?.settings.get().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!raw) return;
  const list = parseMidiMappings(raw[SETTINGS_KEY]);
  if (list.length === 0) return;
  const mappings: Record<string, MidiMapping> = {};
  for (const m of list) mappings[m.source] = m;
  useMidiLearnStore.setState({ mappings });
}

/** Empieza a aprender: el siguiente mando que se mueva se queda con `ref`. */
export function startMidiLearn(ref: ParamRef): void {
  useMidiLearnStore.setState({ learning: ref });
}

/** ¿Es ESTE destino el que está esperando a que muevas un mando? */
export function isLearning(ref: ParamRef, learning: ParamRef | null): boolean {
  return learning !== null && paramRefKey(learning) === paramRefKey(ref);
}

/**
 * ¿Se va a comer `onMidiControl` los mensajes de este mando?
 *
 * Lo pregunta la rueda de tono, que tiene dos vidas: de fábrica dobla el tono
 * del canal, pero si alguien la ATÓ a un destino con MIDI learn manda el
 * destino — atarla ahí fue una decisión, y hacer las dos cosas a la vez sería
 * un mando que mueve algo y además desafina.
 */
export function handlesMidiSource(source: string): boolean {
  const { learning, mappings } = useMidiLearnStore.getState();
  return learning !== null || mappings[source] !== undefined;
}


export function cancelMidiLearn(): void {
  useMidiLearnStore.setState({ learning: null });
}

/** Quita el mapeo de un origen. */
export function removeMidiMapping(source: string): void {
  const mappings = { ...useMidiLearnStore.getState().mappings };
  delete mappings[source];
  useMidiLearnStore.setState({ mappings });
  persistMappings();
}

/** Mapeo que apunta a este destino, si lo hay (para el menú de la perilla). */
export function midiMappingFor(
  ref: ParamRef,
  mappings: Record<string, MidiMapping>,
): MidiMapping | null {
  const key = paramRefKey(ref);
  for (const m of Object.values(mappings)) {
    if (paramRefKey(m.ref) === key) return m;
  }
  return null;
}

// ── Volcado por frame ───────────────────────────────────────────────────────

/** Último valor recibido de cada origen, pendiente de escribir. */
const pending = new Map<string, number>();
let flushHandle: number | null = null;

function flush(): void {
  flushHandle = null;
  const { mappings } = useMidiLearnStore.getState();
  for (const [source, value] of pending) {
    const mapping = mappings[source];
    if (!mapping) continue;
    const command = paramRefCommand(mapping.ref, value, store.project);
    // null = el destino ya no existe (efecto quitado, canal borrado). El mapeo
    // se queda por si vuelve; lo que no puede es reventar aquí.
    if (!command) continue;
    store.dispatch(command, {
      label: describeParamRef(mapping.ref, store.project),
      // Un barrido del mando entero es UN paso de undo, no doscientos.
      mergeKey: 'midi:' + source,
    });
  }
  pending.clear();
}

function scheduleFlush(): void {
  if (flushHandle !== null) return;
  flushHandle =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 16) as unknown as number);
}

/**
 * Un mando continuo se movió. Si estamos aprendiendo, se casa con el destino
 * en vuelo; si no, escribe el suyo (una vez por frame).
 */
export function onMidiControl(source: string, value: number): void {
  useMidiLearnStore.setState({ lastSource: source });
  const { learning, mappings } = useMidiLearnStore.getState();
  if (learning) {
    const next = { ...mappings, [source]: { source, ref: learning } };
    useMidiLearnStore.setState({ mappings: next, learning: null });
    persistMappings();
    return;
  }
  if (!mappings[source]) return;
  pending.set(source, Math.min(1, Math.max(0, value)));
  scheduleFlush();
}
