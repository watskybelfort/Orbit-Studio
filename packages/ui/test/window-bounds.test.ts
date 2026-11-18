import { describe, expect, it } from 'vitest';
import {
  clampResize,
  fitWindowToWorkspace,
  isMaximizedBox,
  maximizeBox,
  snapZoneAt,
  tileBox,
} from '../src/shell/window-bounds';

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

describe('maximizar y acoplar (geometría pura)', () => {
  const area = { w: 1200, h: 700 };

  it('maximizar ocupa el área desde la esquina', () => {
    expect(maximizeBox(area, minimum)).toEqual({ x: 0, y: 0, w: 1200, h: 700 });
  });

  it('si el área es más chica que el mínimo, manda el área', () => {
    // La misma política que fitWindowToWorkspace: en un portátil al 150 % no
    // se puede esconder el asa de cerrar para «respetar» 320×200.
    expect(maximizeBox({ w: 220, h: 130 }, minimum)).toEqual({ x: 0, y: 0, w: 220, h: 130 });
  });

  it('mitades izquierda y derecha, sin huecos ni negativos', () => {
    expect(tileBox(area, 'left', minimum)).toEqual({ x: 0, y: 0, w: 600, h: 700 });
    expect(tileBox(area, 'right', minimum)).toEqual({ x: 600, y: 0, w: 600, h: 700 });
    // Impar: la mitad se redondea hacia abajo y la derecha arranca donde acaba
    // la izquierda, así no queda una línea de un píxel sin pintar en el medio.
    expect(tileBox({ w: 801, h: 700 }, 'right', minimum)).toEqual({ x: 401, y: 0, w: 400, h: 700 });
  });

  it('si el escritorio no da para dos mínimos, devuelve el área completa', () => {
    expect(tileBox({ w: 600, h: 500 }, 'left', minimum)).toEqual({ x: 0, y: 0, w: 600, h: 500 });
    expect(tileBox({ w: 639, h: 500 }, 'right', minimum)).toEqual({ x: 0, y: 0, w: 639, h: 500 });
  });

  it('«top» es maximizar: la franja superior del escritorio', () => {
    expect(tileBox(area, 'top', minimum)).toEqual(maximizeBox(area, minimum));
  });

  it('un área vacía no produce números negativos', () => {
    expect(tileBox({ w: 0, h: 0 }, 'right', minimum)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    expect(tileBox({ w: -40, h: -10 }, 'left', minimum)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
});

describe('zona de acople bajo el puntero', () => {
  // Rect del .workspace en px de layout, coordenadas de viewport.
  const rect = { x: 100, y: 50, w: 900, h: 600 };

  it('los bordes laterales acoplan dentro del umbral de 14 px', () => {
    expect(snapZoneAt({ x: 100, y: 300 }, rect)).toBe('left');
    expect(snapZoneAt({ x: 114, y: 300 }, rect)).toBe('left');
    expect(snapZoneAt({ x: 115, y: 300 }, rect)).toBeNull();
    expect(snapZoneAt({ x: 1000, y: 300 }, rect)).toBe('right');
    expect(snapZoneAt({ x: 986, y: 300 }, rect)).toBe('right');
  });

  it('el borde superior maximiza', () => {
    expect(snapZoneAt({ x: 500, y: 50 }, rect)).toBe('top');
    expect(snapZoneAt({ x: 500, y: 64 }, rect)).toBe('top');
  });

  it('el centro no acopla', () => {
    expect(snapZoneAt({ x: 550, y: 300 }, rect)).toBeNull();
  });

  it('fuera del escritorio no acopla aunque esté cerca del borde', () => {
    // Sobre el navegador o el panel de Claude, que son hermanos del workspace.
    expect(snapZoneAt({ x: 99, y: 300 }, rect)).toBeNull();
    expect(snapZoneAt({ x: 500, y: 700 }, rect)).toBeNull();
    expect(snapZoneAt({ x: 500, y: 49 }, rect)).toBeNull();
  });

  it('en las esquinas laterales gana la mitad a la franja superior', () => {
    expect(snapZoneAt({ x: 100, y: 50 }, rect)).toBe('left');
    expect(snapZoneAt({ x: 1000, y: 50 }, rect)).toBe('right');
  });

  it('el umbral es configurable y un área degenerada no acopla de lado', () => {
    expect(snapZoneAt({ x: 120, y: 300 }, rect, 10)).toBeNull();
    expect(snapZoneAt({ x: 110, y: 300 }, rect, 10)).toBe('left');
    expect(snapZoneAt({ x: 10, y: 50 }, { x: 0, y: 0, w: 20, h: 100 })).toBeNull();
  });
});

describe('reconocer una caja maximizada', () => {
  const area = { w: 1200, h: 700 };

  it('tolera 1 px de redondeo y nada más', () => {
    expect(isMaximizedBox({ x: 0, y: 0, w: 1200, h: 700 }, area)).toBe(true);
    expect(isMaximizedBox({ x: 1, y: 0, w: 1199, h: 700 }, area)).toBe(true);
    expect(isMaximizedBox({ x: 2, y: 0, w: 1200, h: 700 }, area)).toBe(false);
    expect(isMaximizedBox({ x: 0, y: 0, w: 1200, h: 699 }, area)).toBe(true);
    expect(isMaximizedBox({ x: 0, y: 0, w: 1200, h: 697 }, area)).toBe(false);
  });

  it('sin área útil no hay maximizada que reconocer', () => {
    expect(isMaximizedBox({ x: 0, y: 0, w: 0, h: 0 }, { w: 0, h: 0 })).toBe(false);
  });
});
