import type { AutomationPoint } from './types';

/** Curva normalizada sobre puntos ordenados; las anclas pueden quedar fuera del clip. */
export function automationCurveValue(points: readonly AutomationPoint[], time: number): number {
  const first = points[0];
  if (!first) return 0;
  if (time <= first.time) return first.value;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (time <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return b.value;
      const t = (time - a.time) / span;
      const f = a.tension > 0 ? Math.pow(t, 1 + 3 * a.tension)
        : a.tension < 0 ? 1 - Math.pow(1 - t, 1 - 3 * a.tension) : t;
      return a.value + (b.value - a.value) * f;
    }
  }
  return points[points.length - 1]!.value;
}
