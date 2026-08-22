/**
 * Cuantización PVQ de banda, con la rotación de dispersión.
 *
 * Lo que se prueba, por orden de importancia:
 *
 * 1. **Codificar y decodificar dan la misma forma**, exacta. Es la condición de
 *    siempre: si los dos lados reconstruyeran distinto, el estéreo y las
 *    particiones siguientes partirían de datos diferentes.
 * 2. **La rotación es reversible.** Se aplica antes de cuantizar y se deshace
 *    después; si no fuera exactamente invertible, metería una distorsión que
 *    nadie ha pedido.
 * 3. **La rotación hace lo que dice**: reparte la energía en vez de dejarla
 *    concentrada en dos picos. Esto es lo que separa "el códec es correcto" de
 *    "el códec no suena a lata".
 */

import { describe, expect, it } from 'vitest';
import { RangeDecoder, RangeEncoder } from '../src/render/opus/range-coder';
import {
  SPREAD_AGGRESSIVE,
  SPREAD_LIGHT,
  SPREAD_NONE,
  SPREAD_NORMAL,
  algQuant,
  algUnquant,
  expRotation,
  extractCollapseMask,
  renormaliseVector,
} from '../src/render/opus/vq';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

/** Un vector de norma 1, como el que sale de normalizar una banda. */
function unitBand(n: number, seed: number): Float64Array {
  const random = rng(seed);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = random();
  renormaliseVector(out, 0, n, 1);
  return out;
}

describe('vq · codificar y decodificar dan lo mismo', () => {
  it('la forma reconstruida coincide byte a byte en los dos lados', () => {
    for (const spread of [SPREAD_NONE, SPREAD_LIGHT, SPREAD_NORMAL, SPREAD_AGGRESSIVE]) {
      for (const [n, k, blocks] of [
        [4, 2, 1],
        [8, 5, 1],
        [16, 3, 1],
        [16, 12, 2],
        [32, 7, 4],
        [44, 6, 1],
        [64, 5, 8],
      ] as const) {
        const original = unitBand(n, n * 7 + k);
        const encoded = Float64Array.from(original);
        const enc = new RangeEncoder(512);
        const maskEnc = algQuant(encoded, 0, n, k, spread, blocks, enc, 1);

        const decoded = new Float64Array(n);
        const dec = new RangeDecoder(enc.done());
        const maskDec = algUnquant(decoded, 0, n, k, spread, blocks, dec, 1);

        expect(maskDec, `máscara n=${n} k=${k} spread=${spread}`).toBe(maskEnc);
        for (let i = 0; i < n; i++) {
          expect(decoded[i], `n=${n} k=${k} spread=${spread} muestra ${i}`).toBeCloseTo(
            encoded[i]!,
            12,
          );
        }
      }
    }
  });

  it('la forma reconstruida tiene norma 1', () => {
    for (const [n, k] of [
      [8, 4],
      [16, 10],
      [32, 3],
    ] as const) {
      const x = unitBand(n, n + k);
      const enc = new RangeEncoder(512);
      algQuant(x, 0, n, k, SPREAD_NORMAL, 1, enc, 1);
      let energy = 0;
      for (let i = 0; i < n; i++) energy += x[i]! * x[i]!;
      expect(Math.sqrt(energy), `n=${n} k=${k}`).toBeCloseTo(1, 9);
    }
  });

  it('con más pulsos, la forma se parece más a la original', () => {
    // Si esto no se cumpliera, gastar bits en la forma no serviría de nada.
    // Se queda en n=16, k<=12: por encima, la palabra de código ya no cabe en
    // 32 bits y el formato obliga a partir la banda.
    const n = 16;
    const original = unitBand(n, 99);
    let previous = -1;
    for (const k of [1, 2, 4, 8, 12]) {
      const x = Float64Array.from(original);
      const enc = new RangeEncoder(512);
      algQuant(x, 0, n, k, SPREAD_NONE, 1, enc, 1);
      let dot = 0;
      for (let i = 0; i < n; i++) dot += original[i]! * x[i]!;
      expect(dot, `k=${k}`).toBeGreaterThan(previous - 1e-9);
      previous = dot;
    }
    // Con 12 pulsos en 16 dimensiones el coseno llega a ~0,93: la forma ya se
    // parece mucho, y para acercarse más el formato obliga a partir la banda.
    expect(previous).toBeGreaterThan(0.9);
  });

  it('pedir una banda que no cabe en 32 bits apunta a la solución', () => {
    // No es un fallo del cuantizador: es que quien llama tenía que haber
    // partido la banda. Una banda de 44 con 20 pulsos son 153 bits de palabra.
    const x = unitBand(44, 5);
    const enc = new RangeEncoder(512);
    expect(() => algQuant(x, 0, 44, 20, SPREAD_NONE, 1, enc, 1)).toThrow(/partirla antes/);
  });
});

describe('vq · la rotación de dispersión', () => {
  it('es exactamente reversible', () => {
    // Se aplica antes de cuantizar y se deshace después: si perdiera algo por el
    // camino, sería distorsión que nadie ha pedido.
    for (const spread of [SPREAD_LIGHT, SPREAD_NORMAL, SPREAD_AGGRESSIVE]) {
      for (const [n, k, blocks] of [
        [16, 2, 1],
        [32, 4, 2],
        [64, 3, 4],
        [128, 8, 8],
      ] as const) {
        const original = unitBand(n, n + spread);
        const x = Float64Array.from(original);
        expRotation(x, 0, n, 1, blocks, k, spread);
        expRotation(x, 0, n, -1, blocks, k, spread);
        for (let i = 0; i < n; i++) {
          expect(x[i], `n=${n} spread=${spread} muestra ${i}`).toBeCloseTo(original[i]!, 12);
        }
      }
    }
  });

  it('conserva la energía', () => {
    // Una rotación es ortogonal: gira el vector pero no lo alarga.
    const n = 64;
    const x = unitBand(n, 31);
    expRotation(x, 0, n, 1, 1, 4, SPREAD_NORMAL);
    let energy = 0;
    for (let i = 0; i < n; i++) energy += x[i]! * x[i]!;
    expect(Math.sqrt(energy)).toBeCloseTo(1, 9);
  });

  it('no rota cuando hay pulsos de sobra', () => {
    // Con 2K >= N ya no hay concentración que repartir, y la rotación sólo
    // costaría cálculo.
    const n = 16;
    const original = unitBand(n, 41);
    const x = Float64Array.from(original);
    expRotation(x, 0, n, 1, 1, 8, SPREAD_NORMAL);
    for (let i = 0; i < n; i++) expect(x[i]).toBe(original[i]);
  });

  it('SPREAD_NONE no toca nada', () => {
    const n = 32;
    const original = unitBand(n, 43);
    const x = Float64Array.from(original);
    expRotation(x, 0, n, 1, 1, 2, SPREAD_NONE);
    for (let i = 0; i < n; i++) expect(x[i]).toBe(original[i]);
  });

  it('reparte la energía en vez de dejarla en dos picos', () => {
    // ÉSTE es el test que justifica que la rotación exista. Con pocos pulsos
    // para muchas muestras, el PVQ deja casi todo a cero: eso suena a tono
    // metálico. Se mide cuántas muestras salen distintas de cero después de
    // cuantizar, con y sin rotación.
    const n = 64;
    const k = 4;
    const noCeros = (spread: number): number => {
      const x = unitBand(n, 77);
      const enc = new RangeEncoder(512);
      algQuant(x, 0, n, k, spread, 1, enc, 1);
      return x.reduce((count, v) => count + (Math.abs(v) > 1e-9 ? 1 : 0), 0);
    };
    const sinRotar = noCeros(SPREAD_NONE);
    const rotado = noCeros(SPREAD_NORMAL);
    // Sin rotar, 4 pulsos tocan como mucho 4 muestras de 64.
    expect(sinRotar).toBeLessThanOrEqual(k);
    // Rotando, el detalle se reparte por casi toda la banda.
    expect(rotado).toBeGreaterThan(sinRotar * 4);
  });

  it('cuanto más agresiva la dispersión, más se reparte', () => {
    const n = 64;
    const k = 3;
    const noCeros = (spread: number): number => {
      const x = unitBand(n, 83);
      const enc = new RangeEncoder(512);
      algQuant(x, 0, n, k, spread, 1, enc, 1);
      return x.reduce((count, v) => count + (Math.abs(v) > 1e-9 ? 1 : 0), 0);
    };
    expect(noCeros(SPREAD_NORMAL)).toBeGreaterThanOrEqual(noCeros(SPREAD_LIGHT));
    expect(noCeros(SPREAD_AGGRESSIVE)).toBeGreaterThanOrEqual(noCeros(SPREAD_NORMAL));
  });
});

describe('vq · máscara de colapso', () => {
  it('un solo bloque siempre marca ocupado', () => {
    expect(extractCollapseMask(Int32Array.from([0, 0, 0, 0]), 4, 1)).toBe(1);
  });

  it('marca los sub-bloques que recibieron pulsos', () => {
    // Con n=8 y 4 bloques, cada bloque son 2 muestras: [0,1] [2,3] [4,5] [6,7].
    // Aquí tienen pulso el bloque 0 y el 3 → 0b1001.
    const iy = Int32Array.from([1, 0, 0, 0, 0, 0, -2, 0]);
    expect(extractCollapseMask(iy, 8, 4)).toBe(0b1001);
  });

  it('un sub-bloque sin un solo pulso queda a cero', () => {
    // Es lo que le dice al decodificador dónde meter ruido para que un
    // transitorio no suene con huecos.
    const n = 32;
    const x = unitBand(n, 55);
    const enc = new RangeEncoder(512);
    const mask = algQuant(x, 0, n, 2, SPREAD_NONE, 8, enc, 1);
    // Con 2 pulsos y 8 sub-bloques, la mayoría tienen que quedarse vacíos.
    let ocupados = 0;
    for (let i = 0; i < 8; i++) if (mask & (1 << i)) ocupados++;
    expect(ocupados).toBeLessThanOrEqual(2);
    expect(ocupados).toBeGreaterThan(0);
  });
});

describe('vq · casos límite', () => {
  it('una banda en silencio no produce NaN', () => {
    // Un vector todo a cero rompería la proyección: se sustituye por un impulso.
    const x = new Float64Array(16);
    const enc = new RangeEncoder(256);
    algQuant(x, 0, 16, 10, SPREAD_NORMAL, 1, enc, 1);
    for (const value of x) expect(Number.isFinite(value)).toBe(true);
  });

  it('protesta si le piden lo imposible', () => {
    const x = new Float64Array(4);
    const enc = new RangeEncoder(64);
    expect(() => algQuant(x, 0, 4, 0, SPREAD_NONE, 1, enc, 1)).toThrow(/al menos un pulso/);
    expect(() => algQuant(x, 0, 1, 2, SPREAD_NONE, 1, enc, 1)).toThrow(/dos dimensiones/);
  });

  it('renormalizar deja la ganancia pedida', () => {
    for (const gain of [1, 0.5, 2]) {
      const x = unitBand(16, 61);
      renormaliseVector(x, 0, 16, gain);
      let energy = 0;
      for (let i = 0; i < 16; i++) energy += x[i]! * x[i]!;
      expect(Math.sqrt(energy), `ganancia ${gain}`).toBeCloseTo(gain, 9);
    }
  });
});
