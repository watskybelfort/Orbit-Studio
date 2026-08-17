/**
 * Herramientas creativas de pasos del Channel Rack: randomizar y humanizar.
 *
 * Cada función devuelve UN comando (o `null` si no hay nada que hacer), así el
 * gesto entero cabe en un solo undo. Ninguna saca notas fuera del patrón y
 * ninguna toca la melodía del Piano Roll: solo trabajan sobre los pasos.
 *
 * Humanizar reutiliza `humanize` de @orbit/core (mismo criterio que el Piano
 * Roll) pero partiendo de la posición CUADRADA del paso, no de la actual: así
 * llamarlo diez veces no acumula deriva y los pasos siguen siendo pasos.
 */

import { humanize, newId, type Command, type Id, type InstrumentKind, type Note, type NotePatch } from '@orbit/core';
import {
  DEFAULT_VELOCITY,
  HUMANIZE_TIMING,
  HUMANIZE_VELOCITY,
  STEP,
  defaultKey,
  isMelodic,
  stepIndexOf,
} from './steps';

/** Float aleatorio en [min, max). */
function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Probabilidad de que caiga un paso en la celda `i`. No es plana: los pulsos
 * pesan más que las corcheas y estas más que las semicorcheas, que es lo que
 * hace que un patrón random suene a patrón y no a ruido.
 */
function stepChance(i: number): number {
  if (i % 4 === 0) return 0.55;
  if (i % 2 === 0) return 0.32;
  return 0.18;
}

/** Velocity del paso random: acento en el pulso, más flojo entre medias. */
function stepVelocity(i: number): number {
  if (i % 4 === 0) return rand(0.85, 1);
  if (i % 2 === 0) return rand(0.65, 0.9);
  return rand(0.5, 0.78);
}

export interface StepToolContext {
  patternId: Id;
  channelId: Id;
  kind: InstrumentKind;
  /** Notas del canal en el patrón activo. */
  notes: readonly Note[];
  /** Pasos visibles del patrón (pattern.length / STEP). */
  steps: number;
  /** Longitud del patrón en beats (nada puede pasarse de aquí). */
  patternLength: number;
}

/**
 * Reparte pasos al azar por todo el patrón, con velocity variada. Sustituye
 * los pasos que ya había (como el randomize de FL) pero respeta las notas
 * melódicas del canal: lo que se editó en el Piano Roll no se pierde.
 * Garantiza al menos un paso — un botón que a veces no hace nada es un botón
 * roto.
 */
export function randomizeStepsCommand(ctx: StepToolContext): Command | null {
  if (ctx.steps <= 0) return null;

  const key = defaultKey(ctx.kind);
  const previous = ctx.notes.filter((n) => !isMelodic(n));

  const notes: Note[] = [];
  for (let i = 0; i < ctx.steps; i++) {
    if (Math.random() >= stepChance(i)) continue;
    notes.push({
      id: newId(),
      start: i * STEP,
      duration: STEP,
      key,
      velocity: stepVelocity(i),
      pan: 0,
      slide: false,
    });
  }
  if (notes.length === 0) {
    notes.push({
      id: newId(),
      start: 0,
      duration: STEP,
      key,
      velocity: DEFAULT_VELOCITY,
      pan: 0,
      slide: false,
    });
  }

  const commands: Command[] = [];
  if (previous.length > 0) {
    commands.push({
      type: 'removeNotes',
      patternId: ctx.patternId,
      channelId: ctx.channelId,
      noteIds: previous.map((n) => n.id),
    });
  }
  commands.push({
    type: 'addNotes',
    patternId: ctx.patternId,
    channelId: ctx.channelId,
    notes,
  });
  return { type: 'batch', commands };
}

/**
 * Humaniza el canal en el patrón: desplaza el timing unos milisegundos y varía
 * la velocity. Los pasos parten de su posición cuadrada (sin deriva al
 * repetir) y las notas melódicas de su posición real; todo queda dentro del
 * patrón, así que nada se cae del compás.
 */
export function humanizeStepsCommand(ctx: StepToolContext): Command | null {
  if (ctx.notes.length === 0) return null;

  // Base: los pasos, cuadrados; la melodía, donde estaba.
  const base = ctx.notes.map<Note>((n) =>
    isMelodic(n) ? { ...n } : { ...n, start: stepIndexOf(n) * STEP },
  );

  const jittered = humanize(base, {
    timing: HUMANIZE_TIMING,
    velocity: HUMANIZE_VELOCITY,
    seed: (Math.random() * 0xffffffff) >>> 0,
  });

  const patches: NotePatch[] = jittered.map((n) => ({
    id: n.id,
    start: Math.min(Math.max(0, ctx.patternLength - n.duration), Math.max(0, n.start)),
    velocity: n.velocity,
  }));

  return { type: 'patchNotes', patternId: ctx.patternId, channelId: ctx.channelId, patches };
}
