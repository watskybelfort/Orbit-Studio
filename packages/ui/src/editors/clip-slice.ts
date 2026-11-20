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

import { clampFades, type Clip, type Marker } from '@orbit/core';
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
  /** Ventana ya recortada; ausente = resto del sample. */
  sourceLength?: number;
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
  const sourceSec = Math.max(0, ctx.sourceLength ?? (ctx.sampleDuration - ctx.offset));
  return ctx.offset + sourceSpanForOutput(headSec, clipSec, sourceSec, ctx.stretch);
}

/** Reparte fuente y fase sin reiniciar el estiramiento en ninguna pieza. */
export function sliceAudioWindow(clip: Clip, cut: number, ctx: AudioSliceContext): {
  head: Partial<Clip>;
  tail: Partial<Clip>;
} {
  const start = secondsAtBeat(ctx.tempoMap, clip.start, ctx.fallbackTempo);
  const seconds = secondsAtBeat(ctx.tempoMap, clip.start + clip.length, ctx.fallbackTempo) - start;
  const source = Math.max(0, ctx.sourceLength ?? (ctx.sampleDuration - ctx.offset));
  const threshold = ctx.sourceLength === undefined ? 0.01 : 0;
  const stretch = ctx.stretch && source > threshold && seconds > threshold;
  const offset = slicedTailOffset(clip.start, clip.start + clip.length, cut, {...ctx, stretch});
  const headSource = offset - ctx.offset;
  const grainOffset = clip.audioGrainOffset ?? 0;
  return {
    head: {audioSourceLength: headSource, audioGrainOffset: grainOffset, audioStretch: stretch},
    tail: {
      audioOffset: offset,
      audioSourceLength: Math.max(0, source - headSource),
      audioGrainOffset: grainOffset + headSource,
      audioStretch: stretch,
    },
  };
}

/** Recorte por asas en coordenadas de fuente: conserva velocidad y fase. */
export function trimAudioWindow(clip: Clip, from: number, to: number, oldSourceSpan: number): Partial<Clip> {
  const span = Math.max(0.02, to - from);
  return {
    audioOffset: from,
    audioSourceLength: span,
    audioGrainOffset: (clip.audioGrainOffset ?? 0) + from - (clip.audioOffset ?? 0),
    length: Math.max(0.05, span * clip.length / Math.max(0.001, oldSourceSpan)),
  };
}

/**
 * Cuánto se mueve el clip al recortar por la IZQUIERDA.
 *
 * La ventana de fuente y la longitud ya las da `trimAudioWindow`, pero el
 * `start` no: sin esto, el material que quedaba después del borde nuevo sonaba
 * donde estaba el borde viejo (el audio se adelantaba en el timeline). El
 * desplazamiento es proporcional: `span` de fuente equivale a `clip.length` de
 * timeline, así que el delta de fuente se convierte con esa misma regla.
 */
export function trimStartShift(clip: Clip, from: number, oldSourceSpan: number): number {
  const delta = from - (clip.audioOffset ?? 0);
  return delta * (clip.length / Math.max(0.001, oldSourceSpan));
}

/**
 * Recorta el INICIO de un clip de audio en la Playlist, en beats.
 *
 * El asa derecha de la Playlist ya existía; el inicio no tenía gesto y se
 * movía el clip entero. Aquí se convierte el beat nuevo a segundos de fuente
 * (con el mapa de tempo y el stretch del clip), se acorta la ventana y se
 * mueve el `start` para que el material que queda siga sonando donde toca.
 * Devuelve null si el borde no se movió o si el recorte pediría fuente antes
 * del inicio del sample.
 */
export function trimAudioStartAtBeat(
  clip: Clip,
  newStart: number,
  ctx: AudioSliceContext,
): Partial<Clip> | null {
  const end = clip.start + clip.length;
  const target = Math.min(end - 0.05, Math.max(0, newStart));
  if (Math.abs(target - clip.start) < 1e-6) return null;
  const startSec = secondsAtBeat(ctx.tempoMap, clip.start, ctx.fallbackTempo);
  const endSec = secondsAtBeat(ctx.tempoMap, end, ctx.fallbackTempo);
  const targetSec = secondsAtBeat(ctx.tempoMap, target, ctx.fallbackTempo);
  const clipSec = endSec - startSec;
  const available = Math.max(0, ctx.sampleDuration - ctx.offset);
  const sourceSpan = Math.min(
    ctx.sourceLength ?? (ctx.stretch ? available : Math.min(available, clipSec)),
    available,
  );
  if (clipSec <= 0 || sourceSpan <= 0) return null;
  const stretch = ctx.stretch && sourceSpan > 0.01 && clipSec > 0.01;
  const newOffset = ctx.offset +
    sourceSpanForOutput(targetSec - startSec, clipSec, sourceSpan, stretch);
  // Extender hacia la izquierda no puede inventar audio antes del offset 0.
  if (newOffset < -1e-9) return null;
  const from = Math.max(0, Math.min(newOffset, ctx.offset + sourceSpan - 0.02));
  const patch = trimAudioWindow(clip, from, ctx.offset + sourceSpan, sourceSpan);
  patch.start = target;
  // Un fadeIn más largo que el clip recortado se comería todo el sonido.
  patch.fadeIn = Math.min(clampFades(clip.fadeIn, clip.fadeOut, clip.length).fadeIn, patch.length ?? clip.length);
  return patch;
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
