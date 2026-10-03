/**
 * La emisión sobre una copia del `Set` de suscriptores, en los dos módulos que
 * quedaban —`state/param-touch.ts` (que emitía sobre el `Set` vivo) y
 * `browser/pack-generator.ts` (que ya copiaba y ahora además cuenta)—.
 *
 * La regla, decidida y no dejada a la implementación del `Set`: todo
 * suscriptor dado de alta en el momento de emitir recibe ESTE aviso, aunque se
 * dé de baja en mitad de la emisión; la baja vale para el siguiente. Sin la
 * copia, el iterador se salta al ya borrado y quién recibe el aviso depende de
 * en qué orden cayeron las bajas.
 *
 * Y el contador de cada uno (`peaksListenerCount()` ya existía): un `Set` de
 * closures no tiene bytes visibles que delaten su fuga, pero sí un número.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ParamRef } from '@orbit/core';

const ref: ParamRef = { kind: 'channelMix', channelId: 'canal-1', param: 'volume' };

afterEach(() => {
  vi.resetModules();
});

describe('param-touch: toques y suscriptores', () => {
  it('quien da de baja a otro dentro de su propio callback no le roba a ese otro este aviso', async () => {
    const { onParamTouch, touchParam } = await import('../src/state/param-touch');
    const avisos: string[] = [];

    let bajaB: () => void = () => undefined;
    // A va PRIMERO en el Set (orden de alta): con la iteración viva, B —borrado
    // en este mismo aviso— se lo comería.
    const bajaA = onParamTouch((r) => {
      avisos.push(`a:${r.param}`);
      bajaB();
    });
    bajaB = onParamTouch(() => avisos.push('b'));

    touchParam(ref);
    expect(avisos).toEqual(['a:volume', 'b']);

    // La baja sí cuenta para el siguiente movimiento.
    avisos.length = 0;
    touchParam({ ...ref, param: 'pan' });
    expect(avisos).toEqual(['a:pan']);
    bajaA();
  });

  it('el contador dice la verdad al alta y a la baja, hasta cero', async () => {
    const { onParamTouch, paramTouchListenerCount } = await import('../src/state/param-touch');
    expect(paramTouchListenerCount()).toBe(0);
    const bajaA = onParamTouch(() => {});
    const bajaB = onParamTouch(() => {});
    expect(paramTouchListenerCount()).toBe(2);
    bajaA();
    expect(paramTouchListenerCount()).toBe(1);
    bajaB();
    expect(paramTouchListenerCount()).toBe(0);
  });
});

describe('pack-generator: avisos de packs nuevos', () => {
  it('la emisión es sobre copia y la baja vale para el siguiente aviso', async () => {
    const { onPacksChanged, notifyPacksChanged, packsListenerCount } = await import(
      '../src/browser/pack-generator'
    );
    const avisos: string[] = [];

    let bajaB: () => void = () => undefined;
    const bajaA = onPacksChanged(() => {
      avisos.push('a');
      bajaB();
    });
    bajaB = onPacksChanged(() => avisos.push('b'));

    notifyPacksChanged();
    expect(avisos).toEqual(['a', 'b']);

    avisos.length = 0;
    notifyPacksChanged();
    expect(avisos).toEqual(['a']);
    bajaA();
    expect(packsListenerCount()).toBe(0);
  });

  it('el contador sube al alta y baja a la baja', async () => {
    const { onPacksChanged, packsListenerCount } = await import('../src/browser/pack-generator');
    expect(packsListenerCount()).toBe(0);
    const baja = onPacksChanged(() => {});
    expect(packsListenerCount()).toBe(1);
    baja();
    expect(packsListenerCount()).toBe(0);
  });
});
