/**
 * El tercer hueco del patrón: el `Set` de suscriptores de `sample-peaks.ts`.
 *
 * Cada canvas se da de alta con `onPeaksReady(cb)` y se da de baja llamando a lo
 * que esa función devuelve. La baja YA es estructural —el único llamante la
 * devuelve tal cual desde un `useEffect`, y ese contrato lo cumple React al
 * desmontar—, así que aquí no hay nada que reescribir. Lo que faltaba era poder
 * VER una baja perdida: a diferencia de una caché, un `Set` de closures no tiene
 * bytes visibles que delaten el crecimiento (y lo que retiene no es la función,
 * es todo lo que capturó: el `draw` de la playlist con su proyecto y sus refs).
 *
 * Lo que se prueba:
 *
 *  1. El contador dice la verdad al alta y a la baja, y vuelve a cero.
 *  2. Una baja perdida SE VE: el número no baja, y al pasar de lo plausible
 *     salta un aviso — una vez, no uno por repintado.
 *  3. El aviso se rearma cuando el número vuelve a ser normal.
 *  4. El único suscriptor real devuelve su baja desde el `useEffect`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSource } from './read-source';

/**
 * `sample-peaks` importa `readSampleBytes`; nada de este test decodifica nada,
 * así que se corta ahí el grafo de módulos (igual que en
 * `audio-cache-policy.test.ts`).
 */
async function freshPeaks() {
  vi.resetModules();
  vi.doMock('../src/browser/sound-actions', () => ({
    readSampleBytes: async () => null,
  }));
  return import('../src/state/sample-peaks');
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../src/browser/sound-actions');
});

describe('los suscriptores de picos se pueden contar', () => {
  it('el contador sube al alta y baja a la baja, hasta cero', async () => {
    const { onPeaksReady, peaksListenerCount } = await freshPeaks();
    expect(peaksListenerCount()).toBe(0);

    const bajaA = onPeaksReady(() => {});
    const bajaB = onPeaksReady(() => {});
    expect(peaksListenerCount()).toBe(2);

    bajaA();
    expect(peaksListenerCount()).toBe(1);
    bajaB();
    // Cerrar la playlist deja el Set vacío: ese es el estado normal.
    expect(peaksListenerCount()).toBe(0);
  });

  it('el re-suscribirse de cada repintado no acumula (alta y baja emparejadas)', async () => {
    const { onPeaksReady, peaksListenerCount } = await freshPeaks();
    // Es lo que hace `useEffect(() => onPeaksReady(draw), [draw])` cada vez que
    // cambia `draw`: React llama la baja anterior antes del alta siguiente.
    let baja = onPeaksReady(() => {});
    for (let i = 0; i < 200; i++) {
      baja();
      baja = onPeaksReady(() => {});
    }
    expect(peaksListenerCount()).toBe(1);
    baja();
    expect(peaksListenerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('una baja perdida se VE, en vez de deducirse', () => {
  it('el contador no baja y salta un aviso al pasar de lo plausible', async () => {
    const { onPeaksReady, peaksListenerCount, PEAKS_LISTENERS_PLAUSIBLE } = await freshPeaks();

    // El fallo de verdad: alguien se suscribe y tira la baja a la basura.
    const fugadas = PEAKS_LISTENERS_PLAUSIBLE + 8;
    for (let i = 0; i < fugadas; i++) onPeaksReady(() => {});

    expect(peaksListenerCount()).toBe(fugadas);
    // Un aviso, no ocho: el que salta en cada alta se aprende a ignorar.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('onPeaksReady');
  });

  it('por debajo del umbral no molesta a nadie', async () => {
    const { onPeaksReady, PEAKS_LISTENERS_PLAUSIBLE } = await freshPeaks();
    for (let i = 0; i < PEAKS_LISTENERS_PLAUSIBLE; i++) onPeaksReady(() => {});
    expect(warn).not.toHaveBeenCalled();
  });

  it('el aviso se rearma cuando el número vuelve a ser normal', async () => {
    const { onPeaksReady, PEAKS_LISTENERS_PLAUSIBLE, peaksListenerCount } = await freshPeaks();
    const bajas: (() => void)[] = [];
    for (let i = 0; i <= PEAKS_LISTENERS_PLAUSIBLE; i++) bajas.push(onPeaksReady(() => {}));
    expect(warn).toHaveBeenCalledTimes(1);

    for (const baja of bajas) baja();
    expect(peaksListenerCount()).toBe(0);

    // Segunda vuelta: el aviso vuelve a poder saltar. Si se gastara la única
    // vez que saltó, la sesión siguiente se quedaría sin diagnóstico.
    for (let i = 0; i <= PEAKS_LISTENERS_PLAUSIBLE; i++) onPeaksReady(() => {});
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('el único suscriptor real devuelve su baja', () => {
  it('la playlist se da de baja desde el propio useEffect', () => {
    const file = readSource('editors/playlist/Playlist.tsx');
    // `useEffect(() => onPeaksReady(draw), [draw])`: la baja ES el retorno del
    // efecto, que es la forma que React garantiza llamar al desmontar. Si
    // alguien la cambiara por `useEffect(() => { onPeaksReady(draw); }, ...)`
    // —con llaves, tirando la baja— esto lo dice.
    expect(file).toMatch(/useEffect\(\(\) => onPeaksReady\(\w+\), \[\w+\]\)/);
  });
});
