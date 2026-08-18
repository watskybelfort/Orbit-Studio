/**
 * Puntos de corte del Orbit Slicer.
 *
 * El Slicer troceaba SIEMPRE en partes iguales (el parámetro `slices`), que va
 * bien con un loop cuadrado y fatal con uno tocado a mano: el corte cae en
 * mitad del golpe. Un canal puede guardar ahora sus propios cortes —los que
 * saca el detector de transientes, o los que muevas tú— y el motor los usa tal
 * cual.
 *
 * Formato: números normalizados 0..1 sobre la duración del sample, ordenados,
 * y cada uno es el INICIO de un trozo; el final es el siguiente punto (el
 * último trozo llega al final del sample). El primero es siempre 0: un hueco
 * mudo al principio no es un trozo, es silencio que nadie quiere disparar.
 *
 * Todo aquí es puro: el mismo audio da los mismos cortes, y el proyecto suena
 * igual hoy que dentro de un año.
 */

/** Tope de trozos que se guardan (y que puede disparar el teclado con sentido). */
export const MAX_SLICE_POINTS = 64;

/**
 * Deja una lista de cortes utilizable, o `undefined` si no hay nada que
 * guardar. Ordena, recorta al rango, tira duplicados y lo que caiga demasiado
 * pegado al anterior (menos de 1 ms de un sample corriente), y garantiza el 0
 * inicial. Un solo punto no es un troceado: eso es el sample entero.
 */
export function normalizeSlicePoints(
  points: readonly number[] | undefined | null,
): number[] | undefined {
  if (!points || points.length === 0) return undefined;
  const clean = points
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .map((v) => Math.min(1, Math.max(0, v)))
    .sort((a, b) => a - b);
  const out: number[] = [0];
  for (const v of clean) {
    const last = out[out.length - 1]!;
    if (v - last < 1e-4) continue; // duplicado o pegado al anterior
    if (v >= 1) break; // un corte en el final no abre trozo nuevo
    out.push(v);
    if (out.length >= MAX_SLICE_POINTS) break;
  }
  return out.length > 1 ? out : undefined;
}

/** Cortes en partes iguales (lo que hacía el Slicer de siempre). */
export function evenSlicePoints(count: number): number[] {
  const n = Math.min(MAX_SLICE_POINTS, Math.max(2, Math.round(count)));
  return Array.from({ length: n }, (_, i) => i / n);
}

/**
 * Trozo `index` en fracciones 0..1 del sample. Con `points` manda la lista; sin
 * ella, se reparte en `evenCount` partes iguales. El índice se envuelve, que es
 * lo que hace que el teclado siga dando trozos más allá del último.
 */
export function sliceRange(
  points: readonly number[] | undefined,
  index: number,
  evenCount: number,
): { start: number; end: number } {
  const list = points && points.length > 1 ? points : evenSlicePoints(evenCount);
  const n = list.length;
  const i = ((Math.round(index) % n) + n) % n;
  return { start: list[i]!, end: i + 1 < n ? list[i + 1]! : 1 };
}

/** Cuántos trozos hay de verdad en un canal (con cortes propios o sin ellos). */
export function sliceCount(
  points: readonly number[] | undefined,
  evenCount: number,
): number {
  return points && points.length > 1
    ? points.length
    : Math.min(MAX_SLICE_POINTS, Math.max(2, Math.round(evenCount)));
}
