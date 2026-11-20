/**
 * Comandos de un corte de clip en la Playlist.
 *
 * Vive fuera del componente para poder probar la aritmética y el batch de undo
 * sin DOM: el mismo corte lo dispara Shift+clic (en el punto pulsado) y el
 * botón «Dividir» (en el playhead, sobre toda la selección). Un corte son dos
 * comandos —acortar la cabeza y crear la cola— dentro de UN batch, para que un
 * Ctrl+Z devuelva el clip entero de una vez.
 */

import {
  clampFades,
  newId,
  type Clip,
  type Command,
  type Id,
  type Project,
} from '@orbit/core';
import { sliceAutomationCurve } from '../automation/slice-curve';
import { projectTempoMap, sliceAudioWindow } from '../clip-slice';

/** Corta un clip en `cut` (beat absoluto). Lista vacía = el corte cae fuera. */
export function sliceClipCommands(
  project: Project,
  clip: Clip,
  cut: number,
  tailId: Id = newId(),
): Command[] {
  if (cut <= clip.start + 0.05 || cut >= clip.start + clip.length - 0.05) return [];
  const firstLen = cut - clip.start;
  const second: Clip = { ...clip, id: tailId, start: cut, length: clip.length - firstLen };
  let sliceHead: Partial<Clip> = {};
  // Los fundidos se reparten: la cabeza se queda el de entrada y la cola el de
  // salida. Copiar los dos a los dos trozos metería un fundido a mitad del
  // sonido justo donde antes no había ninguno.
  const cutFades = clampFades(clip.fadeIn, clip.fadeOut, clip.length);
  const headFadeIn = Math.min(cutFades.fadeIn, firstLen);
  const tailFadeOut = Math.min(cutFades.fadeOut, second.length);
  second.fadeIn = 0;
  second.fadeOut = tailFadeOut;
  if (clip.kind === 'pattern') {
    second.patternOffset = (clip.patternOffset ?? 0) + firstLen;
  } else if (clip.kind === 'automation') {
    const curve = sliceAutomationCurve(clip, firstLen);
    sliceHead = curve.head;
    Object.assign(second, curve.tail);
  } else if (clip.kind === 'audio') {
    // Ambas ventanas conservan su fuente y la fase de los grains.
    const sample = clip.sampleId ? project.samples[clip.sampleId] : undefined;
    const audio = sliceAudioWindow(clip, cut, {
      offset: clip.audioOffset ?? 0,
      sampleDuration: sample?.duration ?? 0,
      sourceLength: clip.audioSourceLength,
      stretch: clip.audioStretch === true,
      tempoMap: projectTempoMap(Object.values(project.markers), project.tempo),
      fallbackTempo: project.tempo,
    });
    sliceHead = audio.head;
    Object.assign(second, audio.tail);
  }
  return [
    {
      type: 'patchClips',
      patches: [{ id: clip.id, length: firstLen, fadeIn: headFadeIn, fadeOut: 0, ...sliceHead }],
    },
    { type: 'addClips', clips: [second] },
  ];
}

/**
 * Corta en `cut` todos los clips de `clipIds` que lo crucen, en un solo batch.
 * El playhead puede caer fuera de algunos de la selección: esos no se tocan.
 */
export function sliceClipsAt(
  project: Project,
  clipIds: readonly Id[],
  cut: number,
  tailId: () => Id = newId,
): Command[] {
  const commands: Command[] = [];
  for (const id of clipIds) {
    const clip = project.clips[id];
    if (!clip) continue;
    commands.push(...sliceClipCommands(project, clip, cut, tailId()));
  }
  return commands;
}
