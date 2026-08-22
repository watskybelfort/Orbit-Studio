/**
 * PVQ del encoder Opus.
 *
 * El test que importa es el de biyección, y se hace **agotando**: para tamaños
 * pequeños se generan TODOS los vectores válidos, se numeran, y se comprueba que
 * los números salen exactamente una vez y cubren `0 … V(n,k)-1` sin huecos.
 *
 * No es una comprobación cosmética. Si el orden tuviera un solo hueco o una sola
 * repetición, el decodificador reconstruiría un vector distinto del que se
 * mandó y la banda entera saldría con otra forma. Y con muestreo aleatorio eso
 * se puede no ver nunca: agotar es lo único que lo cierra.
 */

import { describe, expect, it } from 'vitest';
import {
  PVQ_MAX_BITS,
  pvqBits,
  pvqBitsApprox,
  pvqNeedsSplit,
  pvqDeindex,
  pvqIndex,
  pvqNormalize,
  pvqSearch,
  pvqSize,
} from '../src/render/opus/pvq';

/** Todos los vectores de `n` dimensiones con exactamente `k` pulsos. */
function allVectors(n: number, k: number): number[][] {
  if (n === 0) return k === 0 ? [[]] : [];
  const out: number[][] = [];
  for (let magnitude = 0; magnitude <= k; magnitude++) {
    const values = magnitude === 0 ? [0] : [magnitude, -magnitude];
    for (const value of values) {
      for (const tail of allVectors(n - 1, k - magnitude)) out.push([value, ...tail]);
    }
  }
  return out;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

describe('pvq · contar', () => {
  it('los casos que se pueden contar a mano', () => {
    expect(pvqSize(1, 0)).toBe(1); // sólo el vector cero
    expect(pvqSize(1, 1)).toBe(2); // +1, -1
    expect(pvqSize(1, 5)).toBe(2); // +5, -5
    expect(pvqSize(2, 1)).toBe(4); // (±1,0), (0,±1)
    expect(pvqSize(2, 2)).toBe(8); // (±2,0), (0,±2), (±1,±1)
    expect(pvqSize(3, 1)).toBe(6);
    expect(pvqSize(4, 0)).toBe(1);
    expect(pvqSize(0, 3)).toBe(0); // sin dimensiones no hay dónde poner pulsos
  });

  it('coincide con contarlos de verdad', () => {
    for (let n = 1; n <= 6; n++) {
      for (let k = 0; k <= 7; k++) {
        expect(pvqSize(n, k), `V(${n},${k})`).toBe(allVectors(n, k).length);
      }
    }
  });

  it('crece con las dimensiones, y con los pulsos salvo en una dimensión', () => {
    for (let n = 1; n <= 20; n++) {
      for (let k = 1; k <= 20; k++) {
        expect(pvqSize(n + 1, k)).toBeGreaterThan(pvqSize(n, k));
        if (n === 1) {
          // En una sola dimensión sólo caben +k y -k, den igual los pulsos que
          // sean: V(1,k) = 2 siempre. Es el borde que rompe la intuición.
          expect(pvqSize(1, k)).toBe(2);
        } else {
          expect(pvqSize(n, k + 1)).toBeGreaterThan(pvqSize(n, k));
        }
      }
    }
  });

  it('cuenta exacto mientras la palabra quepa, y avisa cuando no', () => {
    // Una banda ancha con pocos pulsos: exacto y sin drama.
    expect(pvqSize(176, 8)).toBe(Math.round(pvqSize(176, 8)));
    expect(pvqBits(176, 8)).toBeLessThan(53);
    // La misma banda con 32 pulsos son ~10^46 vectores: 153 bits para UNA
    // palabra. No cabe en un double y mucho menos en el uint32 del formato.
    expect(() => pvqSize(176, 32)).toThrow(/no cabe exacto/);
  });

  it('sabe qué bandas hay que partir sin llegar a desbordar', () => {
    // Ésta es la razón de que CELT parta bandas. Se calcula en logaritmos justo
    // para poder preguntarlo donde el conteo exacto ya no llega.
    expect(pvqNeedsSplit(176, 32)).toBe(true);
    expect(pvqBitsApprox(176, 32)).toBeGreaterThan(150);
    expect(pvqNeedsSplit(16, 4)).toBe(false);
    expect(pvqNeedsSplit(8, 2)).toBe(false);
    expect(PVQ_MAX_BITS).toBe(32);
    // Donde las dos formas de contar valen, tienen que coincidir.
    for (const [n, k] of [[16, 8], [44, 6], [8, 20], [176, 8]] as const) {
      expect(Math.abs(pvqBitsApprox(n, k) - pvqBits(n, k)), `n=${n} k=${k}`).toBeLessThan(1e-9);
    }
  });

  it('rechaza lo que no existe', () => {
    expect(() => pvqSize(-1, 3)).toThrow(/no existe/);
    expect(() => pvqSize(3, -1)).toThrow(/no existe/);
  });
});

describe('pvq · biyección índice ↔ vector', () => {
  it('numera cada vector exactamente una vez, sin huecos', () => {
    for (let n = 1; n <= 5; n++) {
      for (let k = 1; k <= 6; k++) {
        const vectors = allVectors(n, k);
        const seen = new Set<number>();
        for (const y of vectors) {
          const index = pvqIndex(y);
          expect(index, `V(${n},${k}) índice fuera de rango`).toBeGreaterThanOrEqual(0);
          expect(index, `V(${n},${k}) índice fuera de rango`).toBeLessThan(pvqSize(n, k));
          expect(seen.has(index), `V(${n},${k}) índice repetido: ${index}`).toBe(false);
          seen.add(index);
        }
        // Sin huecos: tantos índices distintos como vectores hay.
        expect(seen.size, `V(${n},${k}) huecos`).toBe(vectors.length);
      }
    }
  });

  it('desindexar deshace indexar, para todos los vectores', () => {
    for (let n = 1; n <= 5; n++) {
      for (let k = 1; k <= 6; k++) {
        for (const y of allVectors(n, k)) {
          expect(pvqDeindex(n, k, pvqIndex(y)), `n=${n} k=${k}`).toEqual(y);
        }
      }
    }
  });

  it('indexar deshace desindexar, recorriendo todos los índices', () => {
    for (let n = 1; n <= 5; n++) {
      for (let k = 1; k <= 6; k++) {
        const total = pvqSize(n, k);
        for (let index = 0; index < total; index++) {
          const y = pvqDeindex(n, k, index);
          expect(y.reduce((sum, v) => sum + Math.abs(v), 0), `suma n=${n} k=${k}`).toBe(k);
          expect(pvqIndex(y), `n=${n} k=${k} índice ${index}`).toBe(index);
        }
      }
    }
  });

  it('funciona en bandas grandes, por muestreo', () => {
    // Agotar aquí es imposible (son millones), pero la ida y vuelta sigue valiendo.
    const random = rng(9);
    for (const [n, k] of [
      [16, 8],
      [24, 12],
      [44, 6],
      [8, 30],
    ] as const) {
      const total = pvqSize(n, k);
      for (let trial = 0; trial < 200; trial++) {
        const index = Math.floor((random() + 0.5) * total) % total;
        const y = pvqDeindex(n, k, index);
        expect(y.reduce((sum, v) => sum + Math.abs(v), 0)).toBe(k);
        expect(pvqIndex(y), `n=${n} k=${k}`).toBe(index);
      }
    }
  });

  it('rechaza un índice fuera de rango en vez de devolver basura', () => {
    expect(() => pvqDeindex(4, 3, pvqSize(4, 3))).toThrow(/se sale/);
    expect(() => pvqDeindex(4, 3, -1)).toThrow(/se sale/);
  });
});

describe('pvq · búsqueda de pulsos', () => {
  it('coloca exactamente los pulsos que se piden', () => {
    const random = rng(3);
    for (const n of [4, 8, 16, 32]) {
      for (const k of [1, 2, 5, 16, 40]) {
        const x = Array.from({ length: n }, () => random());
        const y = pvqSearch(x, k);
        expect(y).toHaveLength(n);
        expect(y.reduce((sum, v) => sum + Math.abs(v), 0), `n=${n} k=${k}`).toBe(k);
      }
    }
  });

  it('respeta el signo de la señal', () => {
    const x = [0.9, -0.3, 0.1, -0.8];
    const y = pvqSearch(x, 10);
    y.forEach((v, i) => {
      if (v !== 0) expect(Math.sign(v), `muestra ${i}`).toBe(Math.sign(x[i]!));
    });
  });

  it('pone los pulsos donde está la energía', () => {
    const x = [0.05, 0.98, 0.05, 0.02];
    const y = pvqSearch(x, 8);
    expect(Math.abs(y[1]!)).toBeGreaterThan(Math.abs(y[0]!));
    expect(Math.abs(y[1]!)).toBeGreaterThan(Math.abs(y[2]!));
    expect(Math.abs(y[1]!)).toBeGreaterThan(Math.abs(y[3]!));
  });

  it('con más pulsos se parece más a la señal', () => {
    // No es una perogrullada: una búsqueda voraz mal hecha puede empeorar al
    // subir K. Se mide en coseno, que es lo que PVQ optimiza.
    const random = rng(4);
    const x = Array.from({ length: 24 }, () => random());
    const norm = Math.sqrt(x.reduce((sum, v) => sum + v * v, 0));
    const unit = x.map((v) => v / norm);
    const cosine = (k: number): number => {
      const shape = pvqNormalize(pvqSearch(unit, k));
      return unit.reduce((sum, v, i) => sum + v * shape[i]!, 0);
    };
    let previous = cosine(2);
    for (const k of [4, 8, 16, 32, 64, 128]) {
      const now = cosine(k);
      expect(now, `k=${k}`).toBeGreaterThan(previous - 1e-9);
      previous = now;
    }
    // Con 128 pulsos en 24 muestras la forma tiene que estar ya muy pegada.
    expect(previous).toBeGreaterThan(0.995);
  });

  it('lo que sale se puede numerar: búsqueda y códice encajan', () => {
    // La prueba de que las dos mitades hablan el mismo idioma.
    const random = rng(5);
    for (const [n, k] of [
      [8, 6],
      [12, 10],
      [16, 4],
    ] as const) {
      for (let trial = 0; trial < 50; trial++) {
        const x = Array.from({ length: n }, () => random());
        const y = pvqSearch(x, k);
        const index = pvqIndex(y);
        expect(index).toBeLessThan(pvqSize(n, k));
        expect(pvqDeindex(n, k, index)).toEqual(y);
      }
    }
  });

  it('el caso degenerado: sin pulsos, vector cero', () => {
    expect(pvqSearch([0.5, -0.5, 0.1], 0)).toEqual([0, 0, 0]);
    expect(pvqSearch([], 5)).toEqual([]);
    expect(pvqNormalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('no devuelve ceros negativos', () => {
    // `0 * -1` da -0 en JavaScript, y -0 no es 0 para Object.is ni para una
    // comparación estructural. Con un vector lleno de huecos eso se cuela solo.
    const y = pvqSearch([-0.9, -0.001, -0.8, -0.0005], 2);
    for (const v of y) expect(Object.is(v, -0), `hay un -0 en ${JSON.stringify(y)}`).toBe(false);
  });

  it('una señal plana en silencio sigue repartiendo pulsos', () => {
    // Es la garantía que da PVQ: la banda nunca se queda muda por falta de bits.
    const y = pvqSearch([0, 0, 0, 0], 4);
    expect(y.reduce((sum, v) => sum + Math.abs(v), 0)).toBe(4);
  });
});

describe('pvq · normalizar', () => {
  it('deja norma 1', () => {
    const random = rng(6);
    for (const n of [4, 16, 48]) {
      const x = Array.from({ length: n }, () => random());
      const shape = pvqNormalize(pvqSearch(x, 12));
      const norm = Math.sqrt(shape.reduce((sum, v) => sum + v * v, 0));
      expect(Math.abs(norm - 1), `n=${n}`).toBeLessThan(1e-12);
    }
  });
});
