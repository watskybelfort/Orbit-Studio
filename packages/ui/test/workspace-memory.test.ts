import { describe, expect, it } from 'vitest';
import { parseWorkspace } from '../src/state/workspace-memory';

const AREA = { w: 1400, h: 780 };

describe('disposición guardada del escritorio', () => {
  it('acepta una disposición normal tal cual', () => {
    const got = parseWorkspace(
      {
        playlist: { open: true, x: 20, y: 30, w: 800, h: 400 },
        mixer: { open: false, x: 100, y: 100, w: 600, h: 300 },
        browser: { open: false },
      },
      AREA,
    );
    expect(got?.['playlist']).toEqual({ open: true, x: 20, y: 30, w: 800, h: 400 });
    expect(got?.['mixer']?.open).toBe(false);
    expect(got?.['browser']).toEqual({ open: false, x: 0, y: 0, w: 0, h: 0 });
  });

  it('una ventana que se quedó en el monitor que ya no está vuelve a la vista', () => {
    // Segundo monitor a la derecha: x = 2600 en un escritorio de 1400.
    const got = parseWorkspace({ mixer: { open: true, x: 2600, y: 1900, w: 600, h: 300 } }, AREA);
    expect(got?.['mixer']?.x).toBeLessThanOrEqual(AREA.w);
    expect(got?.['mixer']?.y).toBeLessThanOrEqual(AREA.h);
    expect(got?.['mixer']?.open).toBe(true);
  });

  it('una ventana más grande que la pantalla se encoge hasta caber', () => {
    const got = parseWorkspace({ mixer: { open: true, x: 0, y: 0, w: 4000, h: 3000 } }, AREA);
    expect(got?.['mixer']?.w).toBeLessThanOrEqual(AREA.w);
    expect(got?.['mixer']?.h).toBeLessThanOrEqual(AREA.h);
  });

  it('nunca deja una ventana por debajo de su tamaño mínimo', () => {
    const got = parseWorkspace({ mixer: { open: true, x: 0, y: 0, w: 10, h: 10 } }, AREA);
    expect(got?.['mixer']?.w).toBeGreaterThanOrEqual(320);
    expect(got?.['mixer']?.h).toBeGreaterThanOrEqual(200);
  });

  it('una entrada rota se ignora sin tumbar las buenas', () => {
    const got = parseWorkspace(
      {
        playlist: { open: true, x: 10, y: 10, w: 700, h: 400 },
        mixer: { open: true, x: 'ahí', y: null, w: 600 },
        inventada: { open: true, x: 0, y: 0, w: 500, h: 300 },
      },
      AREA,
    );
    expect(Object.keys(got ?? {})).toEqual(['playlist']);
  });

  it('sin nada aprovechable no se restaura nada', () => {
    expect(parseWorkspace(null, AREA)).toBeNull();
    expect(parseWorkspace('{}', AREA)).toBeNull();
    expect(parseWorkspace({}, AREA)).toBeNull();
    // Solo paneles, sin una sola ventana: no merece pisar el escritorio.
    expect(parseWorkspace({ browser: { open: true } }, AREA)).toBeNull();
  });
});
