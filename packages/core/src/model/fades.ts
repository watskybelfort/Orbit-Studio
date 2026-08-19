/**
 * Fundidos de entrada y salida de un clip de audio.
 *
 * Se guardan en BEATS (no en segundos) porque el clip vive en el timeline: si
 * cambias el tempo, el clip se mueve y el fundido tiene que moverse con él.
 *
 * La lógica está aquí, en el modelo, porque la usan tres sitios que NO pueden
 * discrepar: el compilador (lo que se manda al kernel), el kernel (lo que
 * suena) y la playlist (lo que se dibuja). Un clamp distinto en cada uno
 * significaría oír algo que no es lo que se ve.
 */

export interface ClipFades {
  fadeIn: number;
  fadeOut: number;
}

/**
 * Acota un par de fundidos a la longitud del clip.
 *
 * Cada uno se limita primero al clip y, si aun así los dos juntos pasan de
 * largo, se reparten a proporción en vez de recortar solo a uno: arrastrar los
 * dos a tope da un pico limpio en el centro, que es lo que uno espera al verlo,
 * y nunca deja ganancia por encima de 1.
 * Valores raros (negativos, NaN, un clip de longitud 0) salen como 0.
 */
export function clampFades(
  fadeIn: number | undefined,
  fadeOut: number | undefined,
  length: number,
): ClipFades {
  const len = Number.isFinite(length) && length > 0 ? length : 0;
  const inn = Number.isFinite(fadeIn) && fadeIn! > 0 ? Math.min(fadeIn!, len) : 0;
  const out = Number.isFinite(fadeOut) && fadeOut! > 0 ? Math.min(fadeOut!, len) : 0;
  const total = inn + out;
  if (total <= len || total === 0) return { fadeIn: inn, fadeOut: out };
  const k = len / total;
  return { fadeIn: inn * k, fadeOut: out * k };
}

/**
 * Ganancia del fundido en un beat DENTRO del clip (0 = su principio).
 *
 * Rampa lineal en amplitud, como la de cualquier DAW: lo que se ve dibujado en
 * el clip es exactamente la recta que se aplica. Fuera del clip devuelve 0.
 */
export function fadeGainAt(beat: number, fades: ClipFades, length: number): number {
  if (beat < 0 || beat > length) return 0;
  let g = 1;
  if (fades.fadeIn > 0 && beat < fades.fadeIn) g = beat / fades.fadeIn;
  if (fades.fadeOut > 0 && beat > length - fades.fadeOut) {
    g = Math.min(g, (length - beat) / fades.fadeOut);
  }
  return g < 0 ? 0 : g > 1 ? 1 : g;
}
