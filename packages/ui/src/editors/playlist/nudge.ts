/**
 * Ajuste fino de clips con el teclado, en milisegundos.
 *
 * Nace de grabar con audífonos inalámbricos: el Bluetooth retrasa lo que se
 * oye, se canta a tiempo con eso y la toma cae corrida. Arrastrarla a mano no
 * sirve: aun sin rejilla, con el zoom normal un píxel son ~18 ms a 140 BPM, y
 * cuadrar una voz con el beat pide pasos de 1 a 10 ms. Con un clip
 * seleccionado, Alt+←/→ lo corre `NUDGE_MS` y Alt+Shift+←/→ `NUDGE_FINE_MS`.
 *
 * Puro (sin React ni store) para probar lo que se puede romper en silencio:
 *
 * - Un clip de AUDIO que ya está en el beat 0 y hay que adelantar no se queda
 *   clavado: se recorta su arranque (`audioOffset` sube, `length` baja). Es el
 *   caso más común —se graba desde el compás 1— y justo el que más importa:
 *   la toma llega tarde y hay que traerla hacia atrás.
 * - Un clip estirado (`audioStretch`) o de patrón/automatización no tiene
 *   «audio antes» que destapar: se acota en 0.
 */

/** Paso normal (Alt+flecha). */
export const NUDGE_MS = 10;
/** Paso fino (Alt+Shift+flecha). */
export const NUDGE_FINE_MS = 1;

/** Milisegundos a beats a un tempo dado. */
export function msToBeats(ms: number, tempo: number): number {
  if (!(tempo > 0)) return 0;
  return (ms / 1000) * (tempo / 60);
}

export interface NudgeClip {
  id: string;
  kind: 'pattern' | 'audio' | 'automation';
  start: number;
  length: number;
  audioOffset?: number;
  audioStretch?: boolean;
}

export interface NudgePatch {
  id: string;
  start: number;
  length?: number;
  audioOffset?: number;
}

/**
 * Los parches que corren `clips` `deltaBeats` (negativo = antes). `tempo`
 * convierte beats recortados a segundos de audio. Los clips que no se mueven
 * no salen en la lista.
 */
export function nudgePatches(clips: readonly NudgeClip[], deltaBeats: number, tempo: number): NudgePatch[] {
  if (!Number.isFinite(deltaBeats) || deltaBeats === 0 || !(tempo > 0)) return [];
  const secPerBeat = 60 / tempo;
  const out: NudgePatch[] = [];
  for (const clip of clips) {
    const wanted = clip.start + deltaBeats;
    if (wanted >= 0) {
      out.push({ id: clip.id, start: wanted });
      continue;
    }
    const overflow = -wanted;
    // Recortar el arranque: no puede comerse el clip entero.
    if (clip.kind === 'audio' && !clip.audioStretch && overflow < clip.length - 1e-6) {
      out.push({
        id: clip.id,
        start: 0,
        length: clip.length - overflow,
        audioOffset: (clip.audioOffset ?? 0) + overflow * secPerBeat,
      });
      continue;
    }
    if (clip.start > 0) out.push({ id: clip.id, start: 0 });
  }
  return out;
}
