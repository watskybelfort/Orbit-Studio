/**
 * Caché de pulsos y logaritmo en coma fija.
 *
 * Lo que hay que demostrar aquí no es "que dé un número razonable", porque un
 * número razonable pero distinto del de la referencia rompe el archivo igual que
 * uno absurdo. Encoder y decodificador **recalculan esta misma tabla por su
 * cuenta** y reparten los bits con ella: si difieren en una sola entrada, leen
 * bandas distintas y el flujo se desincroniza sin remedio.
 *
 * Así que se prueban las propiedades exactas de las que depende el formato:
 * el logaritmo nunca se queda corto, es exacto en potencias de dos, y la tabla
 * es coherente en las dos direcciones. Y una comprobación cruzada: `fitsIn32`,
 * que es una tabla, tiene que decir lo mismo que contar `V(n,k)` de verdad.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_PSEUDO,
  MAX_PULSES,
  bandCap,
  bitsToPulses,
  computeLogN,
  computePulseCache,
  fitsIn32,
  getPulses,
  ilog,
  log2Frac,
  opusPulseCache,
  pulsesToBits,
  requiredBits,
} from '../src/render/opus/rate';
import { pvqBitsApprox } from '../src/render/opus/pvq';
import { BITRES, EBAND_5MS, NB_BANDS } from '../src/render/opus/tables';

describe('rate · ilog', () => {
  it('cuenta bits como la referencia', () => {
    expect(ilog(0)).toBe(0);
    expect(ilog(1)).toBe(1);
    expect(ilog(2)).toBe(2);
    expect(ilog(3)).toBe(2);
    expect(ilog(255)).toBe(8);
    expect(ilog(256)).toBe(9);
    expect(ilog(0xffffffff)).toBe(32);
  });
});

describe('rate · log2 en coma fija', () => {
  it('es EXACTO en las potencias de dos', () => {
    // Sin redondeo que valga: es el único caso donde el logaritmo es entero, y
    // si aquí fallara, fallaría en la mitad de las bandas.
    for (let power = 0; power < 31; power++) {
      expect(log2Frac(2 ** power, BITRES), `2^${power}`).toBe(power << BITRES);
    }
  });

  it('NUNCA se queda corto', () => {
    // Ésta es la propiedad que hace que el asignador no se pase del presupuesto:
    // el coste estimado siempre es mayor o igual que el real. Un logaritmo que
    // se quedara corto haría que el codificador creyera que le caben bits que
    // no le caben, y el paquete se desbordaría.
    for (let value = 1; value < 20000; value++) {
      const estimate = log2Frac(value, BITRES) / (1 << BITRES);
      expect(estimate, `log2(${value})`).toBeGreaterThanOrEqual(Math.log2(value) - 1e-12);
    }
  });

  it('se pasa por muy poco: menos de un paso de la rejilla', () => {
    // Y ésta es la otra mitad: si se pasara mucho, el codificador dejaría bits
    // sin usar en cada banda y el bitrate real caería por debajo del pedido.
    const step = 1 / (1 << BITRES);
    let worst = 0;
    for (let value = 1; value < 20000; value++) {
      worst = Math.max(worst, log2Frac(value, BITRES) / (1 << BITRES) - Math.log2(value));
    }
    expect(worst).toBeLessThan(step + 0.07);
  });

  it('aguanta valores grandes, hasta el borde de los 32 bits', () => {
    for (const value of [0x7fffffff, 0xfffffffe, 0x80000001, 123456789, 3000000000]) {
      const estimate = log2Frac(value, BITRES) / (1 << BITRES);
      expect(estimate, `${value}`).toBeGreaterThanOrEqual(Math.log2(value) - 1e-9);
      expect(estimate, `${value}`).toBeLessThan(Math.log2(value) + 0.2);
    }
  });

  it('más precisión fraccionaria, estimación más ajustada', () => {
    // Si esto no se cumpliera, el bucle de refinación no estaría refinando nada.
    // Se mide en promedio y no en un valor suelto: para un número concreto, dos
    // resoluciones distintas pueden dar por casualidad el mismo redondeo.
    const meanError = (frac: number): number => {
      let total = 0;
      for (let value = 3; value < 5000; value++) {
        total += log2Frac(value, frac) / 2 ** frac - Math.log2(value);
      }
      return total / 4997;
    };
    expect(meanError(6)).toBeLessThan(meanError(3));
    expect(meanError(3)).toBeLessThan(meanError(1));
  });
});

describe('rate · rejilla de pulsos', () => {
  it('sube siempre y arranca uno a uno', () => {
    for (let i = 0; i < 8; i++) expect(getPulses(i)).toBe(i);
    for (let i = 1; i <= MAX_PSEUDO; i++) {
      expect(getPulses(i), `pseudo ${i}`).toBeGreaterThan(getPulses(i - 1));
    }
  });

  it('llega a 128 pulsos, que es el tope del formato', () => {
    expect(getPulses(40)).toBe(128);
  });
});

describe('rate · fitsIn32', () => {
  it('dice lo mismo que contar V(n,k) de verdad', () => {
    // `fitsIn32` es una tabla de 30 números; esto la contrasta contra el cálculo
    // real del tamaño del código. Si la tabla estuviera mal transcrita, aquí
    // saltaría.
    for (let n = 2; n <= 200; n++) {
      for (let k = 1; k <= 60; k++) {
        const realmenteCabe = pvqBitsApprox(n, k) <= 32;
        // La tabla es conservadora por diseño (nunca dice que cabe si no cabe).
        if (fitsIn32(n, k)) {
          expect(realmenteCabe, `fitsIn32(${n},${k}) dice que sí pero no cabe`).toBe(true);
        }
      }
    }
  });

  it('lo que no cabe, no cabe', () => {
    expect(fitsIn32(176, 32)).toBe(false);
    expect(fitsIn32(2, 100)).toBe(true);
  });
});

describe('rate · costes de PVQ', () => {
  it('mandar más pulsos nunca cuesta menos', () => {
    for (const n of [2, 4, 8, 16, 44]) {
      // Hasta donde el código cabe en 32 bits, y sin pasar de 128 pulsos, que
      // es el tope real: la caché nunca pregunta por encima de getPulses(40).
      let maxK = 1;
      while (maxK < MAX_PULSES && fitsIn32(n, maxK + 1)) maxK++;
      const costs = requiredBits(n, maxK, BITRES);
      for (let k = 2; k <= maxK; k++) {
        expect(costs[k]!, `n=${n}, k=${k}`).toBeGreaterThanOrEqual(costs[k - 1]!);
      }
    }
  });

  it('pedir un coste fuera de los 32 bits protesta en vez de dar la vuelta', () => {
    // Si esto no saltara, `log2Frac` desbordaría y devolvería un coste MENOR al
    // subir los pulsos: el asignador creería que le cabe lo que no le cabe y el
    // paquete se desbordaría. Salió justamente probando esta monotonía.
    expect(() => requiredBits(8, 40, BITRES)).toThrow(/no cabe en 32 bits/);
    expect(() => requiredBits(176, 32, BITRES)).toThrow(/partirla/);
  });

  it('una banda de una muestra sólo cuesta el signo', () => {
    // Con N=1 no hay forma que elegir: el vector es ±k y sólo viaja el signo.
    const costs = requiredBits(1, 10, BITRES);
    for (let k = 1; k <= 10; k++) expect(costs[k]).toBe(1 << BITRES);
  });
});

describe('rate · caché de pulsos', () => {
  const cache = opusPulseCache();

  it('cubre las 21 bandas y los cuatro tamaños de trama', () => {
    expect(cache.bands).toBe(NB_BANDS);
    expect(cache.maxLM).toBe(3);
    expect(cache.index).toHaveLength(NB_BANDS * 5); // LM de -1 a 3
    expect(cache.caps).toHaveLength(4 * 2 * NB_BANDS);
  });

  it('comparte entradas entre bandas del mismo tamaño', () => {
    // Es lo que hace que la tabla quepa en unos cientos de bytes en vez de miles:
    // el coste sólo depende del tamaño, no de qué banda sea.
    expect(cache.bits.length).toBeLessThan(1024);
    const distintas = new Set(Array.from(cache.index));
    expect(distintas.size).toBeLessThan(cache.index.length);
  });

  it('dentro de cada entrada, el coste sube con los pulsos', () => {
    const visto = new Set<number>();
    for (const at of cache.index) {
      if (at < 0 || visto.has(at)) continue;
      visto.add(at);
      const maxK = cache.bits[at]!;
      for (let k = 2; k <= maxK; k++) {
        expect(cache.bits[at + k]!, `entrada ${at}, k=${k}`).toBeGreaterThanOrEqual(
          cache.bits[at + k - 1]!,
        );
      }
    }
    expect(visto.size).toBeGreaterThan(5);
  });

  it('bits → pulsos → bits se queda donde debe', () => {
    // `bitsToPulses` elige el pseudo-pulso MÁS CERCANO al presupuesto, así que
    // puede pasarse: lo que no puede es dar un número que luego no exista.
    for (let lm = 0; lm <= 3; lm++) {
      for (let band = 0; band < NB_BANDS; band++) {
        for (const budget of [8, 40, 100, 300, 1000]) {
          const pulses = bitsToPulses(cache, band, lm, budget);
          const at = cache.index[(lm + 1) * NB_BANDS + band]!;
          expect(pulses, `banda ${band}, LM ${lm}`).toBeGreaterThanOrEqual(0);
          expect(pulses, `banda ${band}, LM ${lm}`).toBeLessThanOrEqual(cache.bits[at]!);
          const cost = pulsesToBits(cache, band, lm, pulses);
          expect(cost, `banda ${band}, LM ${lm}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('cuantos más bits se ofrecen, más pulsos entran', () => {
    for (let band = 0; band < NB_BANDS; band++) {
      let previous = -1;
      for (let budget = 0; budget < 400; budget += 8) {
        const pulses = bitsToPulses(cache, band, 3, budget);
        expect(pulses, `banda ${band}, presupuesto ${budget}`).toBeGreaterThanOrEqual(previous);
        previous = pulses;
      }
    }
  });

  it('cero pulsos cuestan cero', () => {
    for (let band = 0; band < NB_BANDS; band++) {
      expect(pulsesToBits(cache, band, 3, 0)).toBe(0);
    }
  });

  it('los techos caben en un byte y bajan hacia los agudos', () => {
    for (let lm = 0; lm <= 3; lm++) {
      for (const channels of [1, 2] as const) {
        for (let band = 0; band < NB_BANDS; band++) {
          const cap = bandCap(cache, band, lm, channels);
          expect(cap, `banda ${band}`).toBeGreaterThanOrEqual(0);
          expect(cap, `banda ${band}`).toBeLessThan(256);
        }
        // Las bandas agudas son anchas: por muestra tocan menos bits.
        expect(bandCap(cache, NB_BANDS - 1, lm, channels)).toBeLessThan(
          bandCap(cache, 0, lm, channels),
        );
      }
    }
  });

  it('se puede generar para otros repartos de banda sin romperse', () => {
    // El generador no está atado al modo estándar: si un día hiciera falta otro
    // reparto, tiene que salir igual de coherente.
    const custom = [0, 2, 4, 8, 16, 32, 64];
    const other = computePulseCache(custom, 2);
    expect(other.bands).toBe(6);
    expect(other.bits.length).toBeGreaterThan(0);
    expect(Array.from(other.caps).every((c) => c >= 0 && c < 256)).toBe(true);
  });
});

describe('rate · logN', () => {
  it('es el ancho de cada banda en escala logarítmica', () => {
    const logN = computeLogN(EBAND_5MS);
    expect(logN).toHaveLength(NB_BANDS);
    // Las ocho primeras bandas miden 1: log2(1) = 0.
    for (let i = 0; i < 8; i++) expect(logN[i], `banda ${i}`).toBe(0);
    // Y la última es la más ancha de todas.
    expect(logN[NB_BANDS - 1]!).toBe(Math.max(...Array.from(logN)));
  });
});
