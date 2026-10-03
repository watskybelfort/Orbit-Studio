import { describe, expect, it } from 'vitest';
import { fitWindowToWorkspace } from '../src/shell/window-bounds';

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
