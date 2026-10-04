import type { Clip } from '@orbit/core';

/**
 * Dos ventanas de la misma curva. Conservar las anclas fuera de cada ventana
 * es necesario: sustituir un segmento curvo por un punto en el corte cambia
 * su potencia/tensión. La cola traslada TODAS las anclas a su nuevo origen.
 * El origen de muestreo también viaja: recompilar desde cero en un corte libre
 * desplazaría la rejilla de 1/8 y cambiaría incluso una curva bien trasladada.
 */
export function sliceAutomationCurve(clip: Clip, headLength: number): {
  head: Partial<Clip>;
  tail: Partial<Clip>;
} {
  const offset = clip.automationOffset ?? 0;
  const length = Math.max(clip.automationLength ?? clip.length, offset + clip.length);
  return {
    head: { automationOffset: offset, automationLength: length },
    tail: {
      automationOffset: offset + headLength,
      automationLength: length,
      points: clip.points?.map((point) => ({ ...point, time: point.time - headLength })),
    },
  };
}
