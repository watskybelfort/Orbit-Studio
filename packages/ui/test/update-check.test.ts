import { describe, expect, it } from 'vitest';
import { decideBanner, dueToRecheck, UPDATE_CHECK_INTERVAL_MS } from '../src/state/update-check';

describe('decideBanner — versión local vs remota', () => {
  it('sin ninguna release conocida, no hay cartel', () => {
    expect(decideBanner('3.4.0', null, null)).toBeNull();
  });

  it('la remota más nueva que la local: sí hay cartel', () => {
    const release = { version: '3.5.0', url: 'https://github.com/x/y/releases/tag/v3.5.0' };
    expect(decideBanner('3.4.0', release, null)).toEqual(release);
  });

  it('la instalada YA es la última: no hay cartel', () => {
    const release = { version: '3.4.0', url: 'https://github.com/x/y/releases/tag/v3.4.0' };
    expect(decideBanner('3.4.0', release, null)).toBeNull();
  });

  it('la remota es más VIEJA que la local (build de dev por delante): no hay cartel', () => {
    const release = { version: '3.3.0', url: 'https://github.com/x/y/releases/tag/v3.3.0' };
    expect(decideBanner('3.4.0', release, null)).toBeNull();
  });

  it('esa versión ya se descartó: no vuelve a salir', () => {
    const release = { version: '3.5.0', url: 'https://github.com/x/y/releases/tag/v3.5.0' };
    expect(decideBanner('3.4.0', release, '3.5.0')).toBeNull();
  });

  it('se descartó una versión distinta: la nueva SÍ se enseña', () => {
    const release = { version: '3.6.0', url: 'https://github.com/x/y/releases/tag/v3.6.0' };
    expect(decideBanner('3.4.0', release, '3.5.0')).toEqual(release);
  });

  it('forzando una versión remota mayor (v3.4.0 → v99.0.0): el cartel sale', () => {
    // Esta es la prueba a mano que pide la tarea: se "fuerza" una remota
    // claramente mayor sin tocar la red, inyectando directamente el objeto
    // que en producción vendría de `window.orbit.update.check()`.
    const forced = { version: '99.0.0', url: 'https://github.com/watskybelfort/Orbit-Studio/releases/tag/v99.0.0' };
    expect(decideBanner('3.4.0', forced, null)).toEqual(forced);
  });
});

describe('dueToRecheck — throttle del lado del renderer', () => {
  it('sin fecha previa, toca mirar', () => {
    expect(dueToRecheck(undefined, Date.now())).toBe(true);
  });

  it('dentro del intervalo, no toca', () => {
    const now = 10_000_000;
    expect(dueToRecheck(now - 1000, now, UPDATE_CHECK_INTERVAL_MS)).toBe(false);
  });

  it('pasado el intervalo, vuelve a tocar', () => {
    const now = 10_000_000;
    expect(dueToRecheck(now - UPDATE_CHECK_INTERVAL_MS - 1, now, UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });
});
