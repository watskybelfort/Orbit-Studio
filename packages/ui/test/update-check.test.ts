import { afterEach, describe, expect, it, vi } from 'vitest';
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

/**
 * `initUpdateCheck` de punta a punta con un `window.orbit` de mentira: el bug
 * real (auditoría de la v3.5) era que `updateLastCheckedAt` solo se grababa
 * en el camino de ÉXITO, después del primer `if (!latest) return`. Con la
 * consulta fallando —sin red, rate-limit, JSON raro: todo cae a `null` por
 * diseño en `fetchLatestRelease`— el throttle nunca avanzaba y la app volvía
 * a golpear la API de GitHub en cada arranque, no una vez cada 24h.
 *
 * `vi.resetModules()` + `import()` dinámico por test: `useUpdateCheck` es un
 * store de módulo (singleton), y sin resetear cada test heredaría el
 * `available`/`release` que dejó el anterior.
 */
describe('initUpdateCheck — el throttle se graba TAMBIÉN si falla la consulta', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** `window.orbit` mínimo que necesita `initUpdateCheck`: info + settings + update.check inyectable. */
  function fakeOrbit(
    check: () => Promise<{ version: string; url: string } | null>,
    priorSettings: Record<string, unknown> = {},
  ) {
    const settings: Record<string, unknown> = { ...priorSettings };
    const setCalls: Record<string, unknown>[] = [];
    const orbit = {
      app: { info: () => Promise.resolve({ version: '3.4.0', electron: '', chrome: '', node: '' }) },
      settings: {
        get: () => Promise.resolve({ ...settings }),
        set: (patch: Record<string, unknown>) => {
          setCalls.push(patch);
          Object.assign(settings, patch);
          return Promise.resolve({ ...settings });
        },
      },
      update: { check },
    };
    return { orbit, setCalls };
  }

  it('sin red (update.check() rechaza): igual graba updateLastCheckedAt, sin cartel', async () => {
    vi.resetModules();
    const { orbit, setCalls } = fakeOrbit(() => Promise.reject(new Error('sin red')));
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/update-check');
    await mod.initUpdateCheck();

    const patch = setCalls.find((p) => 'updateLastCheckedAt' in p);
    expect(patch, 'tiene que haber grabado el throttle pese al fallo').toBeTruthy();
    expect(typeof patch!['updateLastCheckedAt']).toBe('number');
    // Sin red no hay release que guardar: esa clave no se toca.
    expect(patch).not.toHaveProperty('updateLatestKnown');
    expect(mod.useUpdateCheck.getState().available).toBe(false);
  });

  it('update.check() resuelve null (404/JSON raro): mismo throttle grabado', async () => {
    vi.resetModules();
    const { orbit, setCalls } = fakeOrbit(() => Promise.resolve(null));
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/update-check');
    await mod.initUpdateCheck();

    expect(setCalls.find((p) => 'updateLastCheckedAt' in p)).toBeTruthy();
    expect(mod.useUpdateCheck.getState().available).toBe(false);
  });

  it('con red: graba el throttle Y la última release conocida, y enseña el cartel', async () => {
    vi.resetModules();
    const release = {
      version: '99.0.0',
      url: 'https://github.com/watskybelfort/Orbit-Studio/releases/tag/v99.0.0',
    };
    const { orbit, setCalls } = fakeOrbit(() => Promise.resolve(release));
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/update-check');
    await mod.initUpdateCheck();

    const patch = setCalls.find((p) => 'updateLastCheckedAt' in p);
    expect(patch).toBeTruthy();
    expect(patch!['updateLatestKnown']).toEqual(release);
    expect(mod.useUpdateCheck.getState().available).toBe(true);
    expect(mod.useUpdateCheck.getState().release).toEqual(release);
  });

  it('todavía dentro del intervalo: ni siquiera llama a update.check() (y no reescribe el throttle)', async () => {
    vi.resetModules();
    const checkFn = vi.fn(() => Promise.resolve(null));
    const { orbit, setCalls } = fakeOrbit(checkFn, { updateLastCheckedAt: Date.now() - 1000 });
    vi.stubGlobal('window', { orbit });

    const mod = await import('../src/state/update-check');
    await mod.initUpdateCheck();

    expect(checkFn).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });
});
