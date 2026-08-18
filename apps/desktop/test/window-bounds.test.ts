/**
 * Restaurar el sitio de una ventana desacoplada.
 *
 * Lo que se prueba es lo que duele en una máquina de verdad: el monitor del
 * mixer ya no está, la resolución cambió, o settings.json trae basura. En
 * todos esos casos hay que RENUNCIAR a los bounds guardados; una ventana
 * restaurada fuera de pantalla existe, se lleva el foco y no se puede agarrar.
 */

import { describe, expect, it } from 'vitest';
import {
  childWindowId,
  isReachable,
  MIN_CHILD_HEIGHT,
  MIN_CHILD_WIDTH,
  parseBounds,
  usableBounds,
  type Area,
} from '../src/main/window-bounds';

/** Portátil (primario) + un monitor a su derecha. */
const PRIMARY: Area = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND: Area = { x: 1920, y: -180, width: 2560, height: 1400 };
/** Y otro montaje habitual: el segundo a la IZQUIERDA (coordenadas negativas). */
const LEFT: Area = { x: -1920, y: 0, width: 1920, height: 1040 };

describe('parseBounds', () => {
  it('acepta cuatro números', () => {
    expect(parseBounds({ x: 10.4, y: 20.6, width: 800, height: 600 })).toEqual({
      x: 10,
      y: 21,
      width: 800,
      height: 600,
    });
  });

  it('rechaza lo que no lo sea', () => {
    expect(parseBounds(null)).toBeNull();
    expect(parseBounds('1200x800')).toBeNull();
    expect(parseBounds({ x: 0, y: 0, width: 800 })).toBeNull();
    expect(parseBounds({ x: 0, y: 0, width: 800, height: '600' })).toBeNull();
    expect(parseBounds({ x: 0, y: 0, width: Number.NaN, height: 600 })).toBeNull();
    expect(parseBounds({ x: 0, y: 0, width: 0, height: 600 })).toBeNull();
  });
});

describe('ventana alcanzable', () => {
  it('la que está en el monitor secundario lo es', () => {
    expect(isReachable({ x: 2200, y: 120, width: 1200, height: 800 }, [PRIMARY, SECOND])).toBe(true);
  });

  it('y también con el segundo monitor a la izquierda (x negativa)', () => {
    expect(isReachable({ x: -1500, y: 60, width: 900, height: 600 }, [PRIMARY, LEFT])).toBe(true);
  });

  it('la que vive en un monitor que ya no está, no', () => {
    expect(isReachable({ x: 2200, y: 120, width: 1200, height: 800 }, [PRIMARY])).toBe(false);
  });

  it('asomando solo un dedo por el borde tampoco cuenta', () => {
    expect(isReachable({ x: 1830, y: 200, width: 1200, height: 800 }, [PRIMARY])).toBe(false);
  });

  it('con la barra de título por encima del borde superior, tampoco', () => {
    expect(isReachable({ x: 300, y: -120, width: 900, height: 700 }, [PRIMARY])).toBe(false);
  });

  it('ni pegada al borde de abajo, donde no queda barra que agarrar', () => {
    expect(isReachable({ x: 300, y: 1030, width: 900, height: 700 }, [PRIMARY])).toBe(false);
  });
});

describe('usableBounds', () => {
  it('devuelve el sitio guardado si sigue habiendo dónde ponerlo', () => {
    const saved = { x: 2100, y: 40, width: 1400, height: 900 };
    expect(usableBounds(saved, [PRIMARY, SECOND])).toEqual(saved);
  });

  it('renuncia si el monitor desapareció', () => {
    expect(usableBounds({ x: 2100, y: 40, width: 1400, height: 900 }, [PRIMARY])).toBeNull();
  });

  it('renuncia si la resolución encogió y la ventana quedó fuera', () => {
    const saved = { x: 1700, y: 900, width: 800, height: 600 };
    expect(usableBounds(saved, [{ x: 0, y: 0, width: 1280, height: 720 }])).toBeNull();
  });

  it('sube al mínimo una ventana guardada demasiado pequeña', () => {
    const got = usableBounds({ x: 100, y: 100, width: 40, height: 30 }, [PRIMARY]);
    expect(got).toEqual({ x: 100, y: 100, width: MIN_CHILD_WIDTH, height: MIN_CHILD_HEIGHT });
  });

  it('con basura en settings.json, ni lo intenta', () => {
    expect(usableBounds(undefined, [PRIMARY])).toBeNull();
    expect(usableBounds({ x: 1, y: 2 }, [PRIMARY])).toBeNull();
  });

  it('sin monitores (aún no hay pantalla) no restaura nada', () => {
    expect(usableBounds({ x: 100, y: 100, width: 800, height: 600 }, [])).toBeNull();
  });
});

describe('childWindowId', () => {
  it('saca el editor del frameName', () => {
    expect(childWindowId('orbit-mixer')).toBe('mixer');
    expect(childWindowId('orbit-pianoRoll')).toBe('pianoRoll');
  });

  it('no deja pasar nombres que ensucien settings.json', () => {
    expect(childWindowId('mixer')).toBeNull();
    expect(childWindowId('orbit-')).toBeNull();
    expect(childWindowId('orbit-../../etc')).toBeNull();
    expect(childWindowId('orbit-mi ventana')).toBeNull();
    expect(childWindowId('orbit-__proto__')).toBeNull();
  });
});
