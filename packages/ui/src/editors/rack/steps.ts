/**
 * Rejilla del Channel Rack: helpers compartidos por el rack, el graph editor
 * de velocity y las herramientas de pasos (randomizar/humanizar).
 *
 * Un paso = 1/16 = 0.25 beats. Una nota "es un paso" cuando cae sobre la
 * rejilla (con holgura) y no dura más de 1/16; lo demás es melodía del Piano
 * Roll y el rack lo enseña como mini-preview.
 */

import type { InstrumentKind, Note } from '@orbit/core';

/** Un paso = 1/16 = 0.25 beats. */
export const STEP = 0.25;

/**
 * Holgura (en fracción de paso) para seguir considerando un paso a una nota
 * desplazada: humanizar mueve los pasos unos milisegundos y NO deben
 * convertirse de golpe en "melodía" y desaparecer del step sequencer.
 * 0.2 de paso = 1/80 de beat: sigue dejando fuera cualquier rejilla real
 * (1/32 = 0.5 pasos, tresillos = 0.33 pasos) que sí es melodía.
 */
export const STEP_TOL = 0.2;

/** Desplazamiento máximo de humanizar, en beats (±8% de paso). */
export const HUMANIZE_TIMING = 0.02;

/** Variación máxima de velocity al humanizar (±). */
export const HUMANIZE_VELOCITY = 0.12;

/** Velocity de un paso recién pintado (el "normal" del rack). */
export const DEFAULT_VELOCITY = 0.8;

/** Altura por defecto al pintar un paso: kick (36) en drums, C5 (60) en el resto. */
export function defaultKey(kind: InstrumentKind): number {
  return kind === 'drums' ? 36 : 60;
}

/** Celda del step sequencer a la que pertenece una nota (redondeo: aguanta humanize). */
export function stepIndexOf(n: Note): number {
  return Math.round(n.start / STEP);
}

/** Nota que no cabe en el step sequencer (melodía de Piano Roll). */
export function isMelodic(n: Note): boolean {
  const rel = n.start / STEP;
  return Math.abs(rel - Math.round(rel)) > STEP_TOL || n.duration > STEP + 1e-3;
}
