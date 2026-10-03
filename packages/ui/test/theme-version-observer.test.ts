/**
 * El `MutationObserver` de `theme/useThemeVersion.ts` y su ciclo de vida.
 *
 * Es el caso «un alta cuya baja no es de nadie» con una particularidad: lo que
 * se fuga no es el `Set` de suscriptores (que sí se limpia), es el observador
 * que el `subscribe` posee — y un módulo de suscriptores compartido no lo
 * habría evitado. Se comprueba sin React y sin jsdom: se exporta la misma
 * función que le pasa `useSyncExternalStore`, y el observador es de mentira
 * (igual que `window`/`navigator` en otros tests del repo).
 *
 * Lo que se prueba:
 *
 *  1. El observador se crea con la primera alta y se desconecta con la baja del
 *     ÚLTIMO suscriptor — no antes —, y se crea de nuevo si vuelve a haber.
 *  2. El contador (`themeListenerCount`) dice la verdad en cada paso.
 *  3. La emisión es sobre una copia: un suscriptor que da de baja a otro dentro
 *     de su propio callback no le roba a ese otro ESTE aviso.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

/** `MutationObserver` de mentira: guarda la instancia y su callback. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly callback: () => void;
  disconnected = false;
  observed: unknown = null;

  constructor(callback: () => void) {
    this.callback = callback;
    FakeObserver.instances.push(this);
  }

  observe(target: unknown): void {
    this.observed = target;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

async function freshTheme() {
  vi.resetModules();
  FakeObserver.instances = [];
  vi.stubGlobal('MutationObserver', FakeObserver);
  vi.stubGlobal('document', { documentElement: { 'data-theme': 'dark' } });
  return import('../src/theme/useThemeVersion');
}

/** Un cambio de tema de verdad: el observador recibe la mutación. */
function mutar(): void {
  const activo = FakeObserver.instances.filter((o) => !o.disconnected);
  expect(activo).toHaveLength(1);
  activo[0]!.callback();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('el observador del tema se desconecta con la baja del último suscriptor', () => {
  it('una alta lo crea, dos bajas parciales no lo tocan y la última lo desconecta', async () => {
    const { onThemeVersionChange, themeListenerCount } = await freshTheme();

    const bajaA = onThemeVersionChange(() => {});
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0]!.observed).toBeDefined();
    expect(themeListenerCount()).toBe(1);

    const bajaB = onThemeVersionChange(() => {});
    // La segunda alta no crea un segundo observador.
    expect(FakeObserver.instances).toHaveLength(1);
    expect(themeListenerCount()).toBe(2);

    bajaA();
    expect(themeListenerCount()).toBe(1);
    // Sigue un suscriptor: el observador sigue vivo. Desconectarlo aquí haría
    // sordo al que queda.
    expect(FakeObserver.instances[0]!.disconnected).toBe(false);

    bajaB();
    expect(themeListenerCount()).toBe(0);
    // Y este era el bug: sin esta desconexión, el observador quedaba mirando
    // <html> para siempre aunque no quedara nadie escuchando.
    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
  });

  it('con el último suscriptor fuera, la próxima alta crea un observador nuevo', async () => {
    const { onThemeVersionChange, themeListenerCount } = await freshTheme();

    const baja = onThemeVersionChange(() => {});
    baja();
    const otraBaja = onThemeVersionChange(() => {});

    expect(FakeObserver.instances).toHaveLength(2);
    expect(FakeObserver.instances[1]!.disconnected).toBe(false);
    expect(themeListenerCount()).toBe(1);
    // El de antes sigue desconectado, no se reanuda.
    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
    otraBaja();
  });

  it('cada cambio de tema avisa, y sobre una copia del Set', async () => {
    const { onThemeVersionChange } = await freshTheme();
    const avisos: string[] = [];

    let bajaB: () => void = () => undefined;
    // A va PRIMERO en el Set (y da de baja a B en su propio callback): con la
    // iteración sobre el Set vivo, el iterador se salta a B borrado y no
    // recibiría este aviso.
    const bajaA = onThemeVersionChange(() => {
      avisos.push('a');
      bajaB();
    });
    bajaB = onThemeVersionChange(() => avisos.push('b'));

    mutar();
    expect(avisos).toEqual(['a', 'b']);

    // La baja de B sí vale para el SIGUIENTE aviso.
    avisos.length = 0;
    mutar();
    expect(avisos).toEqual(['a']);
    bajaA();
  });
});
