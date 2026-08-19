/**
 * Beats ⇄ segundos con el mapa de tempo por delante.
 *
 * Vivía dentro del kernel como método privado, y por eso el resto de la app
 * seguía haciendo `beat * 60 / tempo` con el tempo del proyecto. Eso es cierto
 * SOLO si no hay ni un marcador de cambio de tempo: en cuanto lo hay, el
 * timeline deja de ser lineal y cualquier cuenta hecha así apunta a otro sitio
 * (el recorte de "exportar la selección", sin ir más lejos, cortaba por donde
 * no era). Aquí, puro y compartido.
 */

export interface TempoSegment {
  beat: number;
  tempo: number;
}

/**
 * Segundos absolutos del timeline hasta `beat`, sumando tramo a tramo. Sin
 * mapa es `beat * 60 / fallbackTempo`.
 */
export function secondsAtBeat(
  map: readonly TempoSegment[] | undefined,
  beat: number,
  fallbackTempo: number,
): number {
  if (!map || map.length === 0) return (beat * 60) / fallbackTempo;
  let sec = 0;
  for (let i = 0; i < map.length; i++) {
    const segStart = map[i]!.beat;
    if (beat <= segStart) break;
    const segEnd = i + 1 < map.length ? map[i + 1]!.beat : Infinity;
    sec += ((Math.min(beat, segEnd) - segStart) * 60) / map[i]!.tempo;
    if (beat <= segEnd) break;
  }
  return sec;
}
