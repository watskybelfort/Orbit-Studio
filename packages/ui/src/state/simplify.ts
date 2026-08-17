/**
 * Simplificación de curvas grabadas (Douglas-Peucker por distancia
 * VERTICAL: el eje X es tiempo, no espacio, así que la distancia
 * perpendicular clásica no tendría sentido dimensional).
 *
 * Un barrido de filtro grabado a mano deja cientos de muestras; con esto el
 * clip queda en unas decenas de puntos, se dibuja igual y se puede seguir
 * editando a mano sin pelearse con una nube de breakpoints.
 */

export interface CurveSample {
  /** Tiempo en beats (creciente). */
  time: number;
  /** Valor normalizado 0..1. */
  norm: number;
}

export function simplifyCurve(points: CurveSample[], eps: number): CurveSample[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // Pila explícita: una curva de miles de puntos no debe recursar.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!;
    const b = points[hi]!;
    const span = b.time - a.time;
    let worst = -1;
    let worstDist = eps;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i]!;
      const t = span <= 0 ? 0 : (p.time - a.time) / span;
      const dist = Math.abs(p.norm - (a.norm + (b.norm - a.norm) * t));
      if (dist > worstDist) {
        worstDist = dist;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([lo, worst], [worst, hi]);
  }
  return points.filter((_, i) => keep[i] === 1);
}
