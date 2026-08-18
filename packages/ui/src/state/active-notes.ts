/**
 * Qué teclas están sonando, para que los teclados de la pantalla se iluminen.
 *
 * Dos fuentes que se suman:
 *
 * 1. **Lo que tienes pulsado aquí** (`previewNote`, el envoltorio por el que
 *    pasan TODAS las audiciones de la UI: teclado del piano roll, teclado de
 *    Prisma, botones del rack, teclado del PC y MIDI). Se enciende en el mismo
 *    gesto, sin esperar al motor, que es lo que hace que el teclado responda
 *    instantáneo.
 * 2. **Lo que el kernel dice que suena** (`MeterFrame.notes`, ~cada 42 ms). Es
 *    la verdad: incluye lo que dispara el secuenciador durante la reproducción
 *    y las notas de los demás editores.
 *
 * Se publica la UNIÓN de las dos: una tecla que sigues apretando se queda
 * encendida aunque el kernel le robe la voz (MAX_VOICES), y una nota
 * secuenciada se enciende sola sin que nadie toque nada.
 *
 * El Set publicado se reutiliza cuando el contenido no cambia: sin eso los
 * teclados se repintarían con cada frame de medidores.
 */

import { useMemo, useRef } from 'react';
import { create } from 'zustand';
import { engine } from './app';

/** Clave empaquetada `(canal<<8)|tecla`, el mismo formato que manda el kernel. */
export function packNote(channelIndex: number, key: number): number {
  return ((channelIndex & 0xff) << 8) | (key & 0xff);
}

const EMPTY: ReadonlySet<number> = new Set<number>();

interface ActiveNotesState {
  /** Notas sonando ahora mismo, empaquetadas. Cambia de referencia solo si cambia el contenido. */
  notes: ReadonlySet<number>;
}

export const useActiveNotesStore = create<ActiveNotesState>(() => ({ notes: EMPTY }));

/** Teclas que este cliente tiene pulsadas ahora (fuente 1). */
const held = new Set<number>();
/** Última foto del kernel (fuente 2). */
let fromKernel: ReadonlySet<number> = EMPTY;

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Recalcula la unión y publica solo si de verdad cambió. */
function publish(): void {
  const next = new Set<number>(fromKernel);
  for (const v of held) next.add(v);
  const prev = useActiveNotesStore.getState().notes;
  if (sameSet(prev, next)) return;
  useActiveNotesStore.setState({ notes: next.size === 0 ? EMPTY : next });
}

/**
 * Audiciona una nota (o la suelta) y deja la tecla encendida mientras dure.
 * Sustituye a `engine.previewNote` en toda la UI: si alguien llama al motor
 * directamente la tecla sigue iluminándose por el frame del kernel, pero con
 * el retardo de los medidores.
 */
export function previewNote(channelIndex: number, key: number, on: boolean): void {
  engine.previewNote(channelIndex, key, on);
  const packed = packNote(channelIndex, key);
  if (on) held.add(packed);
  else held.delete(packed);
  publish();
}

/** Suelta en la UI todo lo que quedara pulsado (cambio de canal, foco perdido…). */
export function clearHeldNotes(): void {
  if (held.size === 0) return;
  held.clear();
  publish();
}

/** Notas que reporta el kernel en cada frame de medidores. */
export function setKernelNotes(packed: Uint16Array | undefined): void {
  if (!packed || packed.length === 0) {
    if (fromKernel.size === 0) return;
    fromKernel = EMPTY;
    publish();
    return;
  }
  const next = new Set<number>(packed);
  if (sameSet(fromKernel, next)) return;
  fromKernel = next;
  publish();
}

/**
 * Teclas (0..127) de un canal que están sonando. Devuelve la MISMA referencia
 * mientras el conjunto de ESE canal no cambie — lo de otro canal no repinta su
 * teclado —, así que sirve de dependencia de un memo sin coste. `channelIndex`
 * negativo (sin canal elegido) da siempre el conjunto vacío.
 */
export function useActiveKeys(channelIndex: number): ReadonlySet<number> {
  const notes = useActiveNotesStore((s) => s.notes);
  const last = useRef<ReadonlySet<number>>(EMPTY);
  return useMemo(() => {
    let out: ReadonlySet<number> = EMPTY;
    if (channelIndex >= 0 && notes.size > 0) {
      const keys = new Set<number>();
      for (const p of notes) if (p >> 8 === channelIndex) keys.add(p & 0xff);
      if (keys.size > 0) out = keys;
    }
    if (sameSet(last.current, out)) return last.current;
    last.current = out;
    return out;
  }, [notes, channelIndex]);
}
