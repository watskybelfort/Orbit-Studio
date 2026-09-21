/**
 * Aritmética de cortar y trocear clips de audio con time-stretch.
 *
 * El motor mapea `ratio = srcSec / clipSec` (kernel-core.ts): con stretch, el
 * clip llena su largo con TODA la fuente que le queda desde su offset hasta el
 * final del sample. La lectura NO va a tiempo real, y de ahí salieron los dos
 * bugs que aquí se resuelven:
 *
 * - La cola de un corte arrancaba en `offset + firstLen × secPerBeat` (tiempo
 *   real) en vez de en la parte proporcional del span de fuente.
 * - Los beats se pasaban a segundos con `project.tempo` a secas, que miente en
 *   cuanto hay un marcador de cambio de tempo (el motor integra el mapa).
 *
 * `naturalRatePieces` es la otra cara: al trocear un clip estirado, cada pieza
 * tiene que leer SU tramo a velocidad natural — dejarlas con stretch hacía que
 * cada una re-estirara lo que quedaba del sample sobre su largo.
 */

import type { Marker } from '@orbit/core';
import { secondsAtBeat, type TempoSegment } from '@orbit/engine';

/**
 * Segundos de FUENTE que consume un tramo de salida de `outputSec` segundos.
 *
 * Sin stretch la lectura va a tiempo real (1 s de salida = 1 s de fuente). Con
 * stretch el clip reparte `sourceSec` sobre `clipSec`, así que el tramo se
 * lleva su parte proporcional. Sin fuente o sin largo no hay nada que repartir:
 * se devuelve el tramo tal cual (el motor, sin ratio válido, lee a tiempo real).
 */
export function sourceSpanForOutput(
  outputSec: number,
  clipSec: number,
  sourceSec: number,
  stretch: boolean,
): number {
  if (!stretch || clipSec <= 0 || sourceSec <= 0) return outputSec;
  return (outputSec / clipSec) * sourceSec;
}

/** La inversa: segundos de salida que ocupa un tramo de `sourceSpan`. */
export function outputSpanForSource(
  sourceSpan: number,
  sourceSec: number,
  clipSec: number,
  stretch: boolean,
): number {
  if (!stretch || sourceSec <= 0) return sourceSpan;
  return (sourceSpan / sourceSec) * clipSec;
}

/**
 * Mapa de tempo del proyecto con la MISMA regla que `compileProject`: el tempo
 * del proyecto en el beat 0, un tramo por marcador con tempo (> 0), ordenados
 * y sin repetir el valor del tramo anterior; un marcador en el beat 0 redefine
 * el inicial. Así `secondsAtBeat` da los mismos segundos que integra el kernel.
 */
export function projectTempoMap(
  markers: readonly Marker[],
  fallbackTempo: number,
): TempoSegment[] {
  const map: TempoSegment[] = [{ beat: 0, tempo: fallbackTempo }];
  for (const m of [...markers].sort((a, b) => a.time - b.time)) {
    if (m.tempo === undefined || m.tempo <= 0) continue;
    if (m.time <= 0) {
      map[0]!.tempo = m.tempo;
      continue;
    }
    if (m.tempo !== map[map.length - 1]!.tempo) map.push({ beat: m.time, tempo: m.tempo });
  }
  return map;
}

export interface AudioSliceContext {
  /** Offset de fuente del clip, en segundos. */
  offset: number;
  /** Duración del sample, en segundos. */
  sampleDuration: number;
  /** ¿El clip estira la fuente para llenar su largo? */
  stretch: boolean;
  /** Mapa de tempo ya construido (ver `projectTempoMap`). */
  tempoMap: readonly TempoSegment[];
  /** Tempo de respaldo si el mapa viniera sin tramos. */
  fallbackTempo: number;
}

/**
 * Offset de fuente donde arranca la COLA de un corte en `cut` beats.
 *
 * La cabeza se queda `headSec = segundos(cut) - segundos(inicio)` de salida;
 * con stretch eso consume su parte del span de fuente (`sourceSec`), y por ahí
 * sigue la cola. Sin stretch consume exactamente `headSec` (tiempo real).
 */
export function slicedTailOffset(
  clipStart: number,
  clipEnd: number,
  cut: number,
  ctx: AudioSliceContext,
): number {
  const startSec = secondsAtBeat(ctx.tempoMap, clipStart, ctx.fallbackTempo);
  const clipSec = secondsAtBeat(ctx.tempoMap, clipEnd, ctx.fallbackTempo) - startSec;
  const headSec = secondsAtBeat(ctx.tempoMap, cut, ctx.fallbackTempo) - startSec;
  const sourceSec = Math.max(0, ctx.sampleDuration - ctx.offset);
  return ctx.offset + sourceSpanForOutput(headSec, clipSec, sourceSec, ctx.stretch);
}

/** Una pieza de un troceado, en coordenadas de fuente y de timeline natural. */
export interface SourcePiece {
  /** Offset de fuente, en segundos desde el inicio del sample. */
  offset: number;
  /** Posición de timeline, en segundos desde el inicio del clip original. */
  at: number;
  /** Largo de timeline, en segundos (lectura a velocidad natural). */
  seconds: number;
}

/**
 * Reparte el tramo de fuente `[from, to]` en piezas contiguas separadas por
 * `cuts`, a velocidad natural. Los cortes pegados a los bordes (± 0.01 s) se
 * ignoran: un corte en el borde no parte nada. Sin cortes no hay piezas.
 */
export function naturalRatePieces(
  from: number,
  to: number,
  cuts: readonly number[],
): SourcePiece[] {
  const inside = cuts.filter((t) => t > from + 0.01 && t < to - 0.01).sort((a, b) => a - b);
  if (inside.length === 0) return [];
  const bounds = [from, ...inside, to];
  const pieces: SourcePiece[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const start = bounds[i - 1]!;
    pieces.push({ offset: start, at: start - from, seconds: bounds[i]! - start });
  }
  return pieces;
}
