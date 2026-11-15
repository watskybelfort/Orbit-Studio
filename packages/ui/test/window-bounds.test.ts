import { describe, expect, it } from 'vitest';
import { clampResize, fitWindowToWorkspace } from '../src/shell/window-bounds';

const minimum = { w: 320, h: 200 };
const saved = { x: 260, y: 120, w: 640, h: 480 };

describe('ventanas dentro del escritorio visible', () => {
  it('mantiene el tamaño y posición cuando caben', () => {
    expect(fitWindowToWorkspace(saved, { w: 1400, h: 780 }, minimum)).toEqual(saved);
  });

  it('una escala mayor reduce el área y conserva accesibles cierre y bordes', () => {
    expect(fitWindowToWorkspace(saved, { w: 853, h: 445 }, minimum)).toEqual({ x: 213, y: 0, w: 640, h: 445 });
  });

  it('un viewport menor que el mínimo contiene la ventana completa', () => {
    expect(fitWindowToWorkspace(saved, { w: 220, h: 130 }, minimum)).toEqual({ x: 0, y: 0, w: 220, h: 130 });
  });

  it('recupera la geometría original al crecer sin modificar el guardado', () => {
    const box = { ...saved };
    fitWindowToWorkspace(box, { w: 450, h: 300 }, minimum);
    expect(box).toEqual(saved);
    expect(fitWindowToWorkspace(box, { w: 1600, h: 900 }, minimum)).toEqual(saved);
  });

  it('corrige posiciones restauradas fuera del monitor y respeta mínimos', () => {
    expect(fitWindowToWorkspace({ x: -80, y: 1600, w: 10, h: 10 }, { w: 900, h: 600 }, minimum)).toEqual({ x: 0, y: 400, w: 320, h: 200 });
  });

  it('antes de medir o sin área utilizable no colapsa las ventanas', () => {
    expect(fitWindowToWorkspace(saved, null, minimum)).toBe(saved);
    expect(fitWindowToWorkspace(saved, { w: 0, h: 0 }, minimum)).toBe(saved);
  });
});

describe('redimensionar sin pasarse del escritorio', () => {
  it('crece hasta el borde y ahí se queda', () => {
    // x = 100, área 800: como mucho 700 de ancho.
    expect(clampResize({ x: 100, y: 80, w: 700, h: 400 }, { w: 800, h: 600 }, minimum))
      .toEqual({ w: 700, h: 400 });
    expect(clampResize({ x: 100, y: 80, w: 900, h: 700 }, { w: 800, h: 600 }, minimum))
      .toEqual({ w: 700, h: 520 });
  });

  it('volver hacia atrás responde desde el primer píxel', () => {
    // Sin el tope, el store seguía en 2000 y arrastrar 300 px a la izquierda
    // no movía nada visible.
    const capped = clampResize({ x: 0, y: 0, w: 2000, h: 300 }, { w: 800, h: 600 }, minimum);
    expect(capped.w).toBe(800);
    expect(clampResize({ x: 0, y: 0, w: capped.w - 300, h: 300 }, { w: 800, h: 600 }, minimum).w).toBe(500);
  });

  it('respeta los mínimos aunque el área sea más chica que ellos', () => {
    // Misma regla que el render: si el escritorio no da para el mínimo, manda
    // el escritorio (una ventana de 320 en 220 se saldría por los dos lados).
    expect(clampResize({ x: 190, y: 100, w: 10, h: 10 }, { w: 220, h: 130 }, minimum))
      .toEqual({ w: 220, h: 130 });
  });

  it('una ventana desacoplada solo respeta los mínimos', () => {
    expect(clampResize({ x: 3000, y: 2000, w: 120, h: 90 }, null, minimum))
      .toEqual({ w: 320, h: 200 });
    expect(clampResize({ x: 0, y: 0, w: 1200, h: 900 }, null, minimum))
      .toEqual({ w: 1200, h: 900 });
  });
});
