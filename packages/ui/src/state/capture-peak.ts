/**
 * Pico de una toma de micro y el aviso que se da al guardarla.
 *
 * El WAV se escribe a 24 bits y recorta a ±1: una toma que llegó al tope suena
 * rota y no hay forma de recuperarla después. El medidor de entrada ya lo
 * enseña EN VIVO mientras se canta, pero el aviso se va con el siguiente
 * bloque de medidores — quien mira el teclado mientras graba no lo ve, y quien
 * mira el medidor no siempre distingue un pico de un pasaje fuerte. Lo que
 * faltaba era el aviso ENCLAVADO al guardar, que es cuando ya no se puede
 * hacer nada salvo saberlo y repetir la toma.
 *
 * Vive aparte de `recorder.ts` porque es aritmética pura y se puede probar sin
 * micro, sin kernel y sin Electron (convención del repo: la lógica que puede
 * fallar en silencio va a un módulo hermano con tests).
 */

/**
 * Umbral de clipping. No es 1 exacto: un pico de 0,999 en float32 ya es un
 * valor que, al cuantizar a 24 bits enteros y volver, se lee como el tope, y
 * los conversores reales suelen recortar un pelo antes de 1. 0,9989 deja
 * margen para no avisar por un pico que en la práctica está limpio.
 */
export const TAKE_CLIP_THRESHOLD = 0.9989;

/** Pico absoluto de un par estéreo (0 si no hay muestras). */
export function peakOf(left: ArrayLike<number>, right?: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < left.length; i++) {
    const value = Math.abs(left[i]!);
    if (value > peak) peak = value;
  }
  if (right) {
    for (let i = 0; i < right.length; i++) {
      const value = Math.abs(right[i]!);
      if (value > peak) peak = value;
    }
  }
  return Number.isFinite(peak) ? peak : 0;
}

/** ¿Este pico llegó al tope? */
export function isClipped(peak: number): boolean {
  return Number.isFinite(peak) && peak >= TAKE_CLIP_THRESHOLD;
}

/**
 * Texto del aviso, o `null` si no hubo clipping.
 *
 * Nombra las tomas una por una cuando son pocas: en una grabación de dos
 * micros puede haber recortado solo la guitarra, y decir «la grabación
 * recortó» obliga a escuchar las dos para saber cuál repetir.
 */
export function takeClipWarning(
  takes: readonly { name: string; peak: number }[],
): string | null {
  const clipped = takes.filter((take) => isClipped(take.peak));
  if (clipped.length === 0) return null;
  const names = clipped.map((take) => `«${take.name}»`).join(', ');
  const plural = clipped.length === 1 ? 'La toma' : 'Las tomas';
  return `${plural} ${names} llegó al tope y puede sonar recortada. Baja la ganancia del aparato o del sistema antes de la toma (la de Orbit es posterior y no cambia el WAV ya capturado); si se oye rota, repítela.`;
}
