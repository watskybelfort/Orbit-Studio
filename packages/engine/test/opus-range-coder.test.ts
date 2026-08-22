/**
 * Range coder de Opus. Lo que se prueba es lo único que importa de un coder
 * aritmético: que lo que entra sale, EXACTO, en secuencias largas y mezcladas.
 *
 * Un solo símbolo mal codificado no se nota en el símbolo — se nota en todo lo
 * que viene detrás, porque el decodificador va en lockstep. Por eso los tests
 * son de ráfaga: miles de símbolos con modelos distintos entremezclados, y
 * comparación uno a uno.
 */

import { describe, expect, it } from 'vitest';
import { RangeDecoder, RangeEncoder } from '../src/render/opus/range-coder';

/** PRNG determinista: un fallo tiene que poder repetirse. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ICDF de ejemplo (como las de la spec: baja hasta 0, escala 2^ftb). */
const ICDF_4 = [128, 64, 16, 0];
const FTB_4 = 8;

describe('range coder · símbolos con intervalo', () => {
  it('una ráfaga de símbolos vuelve igual', () => {
    const random = rng(1);
    const symbols: { fl: number; fh: number; ft: number }[] = [];
    const enc = new RangeEncoder(4096);
    for (let i = 0; i < 2000; i++) {
      const ft = 2 + Math.floor(random() * 60);
      const fl = Math.floor(random() * ft);
      const fh = fl + 1 + Math.floor(random() * (ft - fl));
      symbols.push({ fl, fh, ft });
      enc.encode(fl, fh, ft);
    }
    const dec = new RangeDecoder(enc.done());
    for (const { fl, fh, ft } of symbols) {
      const s = dec.decode(ft);
      expect(s).toBeGreaterThanOrEqual(fl);
      expect(s).toBeLessThan(fh);
      dec.update(fl, fh, ft);
    }
  });

  it('el símbolo decodificado cae SIEMPRE dentro de su intervalo', () => {
    const enc = new RangeEncoder(64);
    enc.encode(3, 4, 10);
    enc.encode(0, 1, 2);
    enc.encode(9, 10, 10);
    const dec = new RangeDecoder(enc.done());
    expect(dec.decode(10)).toBe(3);
    dec.update(3, 4, 10);
    expect(dec.decode(2)).toBe(0);
    dec.update(0, 1, 2);
    expect(dec.decode(10)).toBe(9);
  });
});

describe('range coder · bits con probabilidad', () => {
  it('una ráfaga de bits con logp variado vuelve igual', () => {
    const random = rng(2);
    const bits: { bit: number; logp: number }[] = [];
    const enc = new RangeEncoder(4096);
    for (let i = 0; i < 3000; i++) {
      const logp = 1 + Math.floor(random() * 14);
      const bit = random() < 1 / 2 ** Math.min(logp, 4) ? 1 : 0;
      bits.push({ bit, logp });
      enc.bitLogp(bit, logp);
    }
    const dec = new RangeDecoder(enc.done());
    for (const { bit, logp } of bits) {
      expect(dec.bitLogp(logp)).toBe(bit);
    }
  });

  it('un bit improbable cuesta poco cuando no sale', () => {
    // 500 ceros con logp 15 (la bandera de silencio de CELT) tienen que caber
    // en muy pocos bytes: si costaran un bit cada uno, el modelo no serviría.
    const enc = new RangeEncoder(256);
    for (let i = 0; i < 500; i++) enc.bitLogp(0, 15);
    expect(enc.tell()).toBeLessThan(60);
  });
});

describe('range coder · tablas ICDF', () => {
  it('una ráfaga de símbolos ICDF vuelve igual', () => {
    const random = rng(3);
    const symbols: number[] = [];
    const enc = new RangeEncoder(4096);
    for (let i = 0; i < 2000; i++) {
      const s = Math.floor(random() * (ICDF_4.length - 1));
      symbols.push(s);
      enc.icdf(s, ICDF_4, FTB_4);
    }
    const dec = new RangeDecoder(enc.done());
    for (const s of symbols) expect(dec.icdf(ICDF_4, FTB_4)).toBe(s);
  });

  it('el símbolo más probable ocupa menos que el menos probable', () => {
    const barato = new RangeEncoder(512);
    for (let i = 0; i < 100; i++) barato.icdf(0, ICDF_4, FTB_4);
    const caro = new RangeEncoder(512);
    for (let i = 0; i < 100; i++) caro.icdf(2, ICDF_4, FTB_4);
    expect(barato.tell()).toBeLessThan(caro.tell());
  });
});

describe('range coder · bits crudos y enteros', () => {
  it('los bits crudos vuelven igual (van por el otro extremo del paquete)', () => {
    const random = rng(4);
    const values: { value: number; count: number }[] = [];
    const enc = new RangeEncoder(4096);
    for (let i = 0; i < 1000; i++) {
      const count = 1 + Math.floor(random() * 16);
      const value = Math.floor(random() * 2 ** count);
      values.push({ value, count });
      enc.bits(value, count);
    }
    const dec = new RangeDecoder(enc.done());
    for (const { value, count } of values) expect(dec.bits(count)).toBe(value);
  });

  it('los enteros uniformes vuelven igual, grandes y pequeños', () => {
    const random = rng(5);
    const values: { value: number; ft: number }[] = [];
    const enc = new RangeEncoder(8192);
    for (let i = 0; i < 800; i++) {
      const ft = 2 + Math.floor(random() * 100000);
      const value = Math.floor(random() * ft);
      values.push({ value, ft });
      enc.uint(value, ft);
    }
    const dec = new RangeDecoder(enc.done());
    for (const { value, ft } of values) expect(dec.uint(ft)).toBe(value);
  });

  it('mezclar los dos flujos no los descoloca', () => {
    // Éste es EL caso que rompe una implementación ingenua: símbolos por
    // delante y bits crudos por detrás, alternados, en el mismo paquete.
    const random = rng(6);
    type Op =
      | { kind: 'sym'; s: number }
      | { kind: 'bit'; bit: number; logp: number }
      | { kind: 'raw'; value: number; count: number };
    const ops: Op[] = [];
    const enc = new RangeEncoder(8192);
    for (let i = 0; i < 1500; i++) {
      const pick = random();
      if (pick < 0.4) {
        const s = Math.floor(random() * 3);
        ops.push({ kind: 'sym', s });
        enc.icdf(s, ICDF_4, FTB_4);
      } else if (pick < 0.7) {
        const logp = 1 + Math.floor(random() * 8);
        const bit = random() < 0.5 ? 1 : 0;
        ops.push({ kind: 'bit', bit, logp });
        enc.bitLogp(bit, logp);
      } else {
        const count = 1 + Math.floor(random() * 12);
        const value = Math.floor(random() * 2 ** count);
        ops.push({ kind: 'raw', value, count });
        enc.bits(value, count);
      }
    }
    const dec = new RangeDecoder(enc.done());
    for (const op of ops) {
      if (op.kind === 'sym') expect(dec.icdf(ICDF_4, FTB_4)).toBe(op.s);
      else if (op.kind === 'bit') expect(dec.bitLogp(op.logp)).toBe(op.bit);
      else expect(dec.bits(op.count)).toBe(op.value);
    }
  });
});

describe('range coder · cuentas de bits', () => {
  it('el paquete mide lo que se pidió: el hueco va a ceros', () => {
    const enc = new RangeEncoder(64);
    enc.bitLogp(1, 2);
    const out = enc.done();
    // No se compacta a propósito: el decodificador cuenta los bits crudos
    // desde el FINAL, así que mover ese extremo lo desincronizaría.
    expect(out).toHaveLength(64);
  });

  it('encoder y decoder cuentan lo mismo, símbolo a símbolo', () => {
    const random = rng(7);
    const enc = new RangeEncoder(4096);
    const encTells: number[] = [];
    const plan: number[] = [];
    for (let i = 0; i < 300; i++) {
      const s = Math.floor(random() * 3);
      plan.push(s);
      enc.icdf(s, ICDF_4, FTB_4);
      encTells.push(enc.tellFrac());
    }
    const dec = new RangeDecoder(enc.done());
    plan.forEach((s, i) => {
      expect(dec.icdf(ICDF_4, FTB_4)).toBe(s);
      // Esto es lo que permite que el asignador de bits de CELT funcione: los
      // dos lados saben lo mismo sobre cuánto se lleva gastado.
      expect(dec.tellFrac()).toBe(encTells[i]);
    });
  });

  it('tell crece de forma monótona', () => {
    const enc = new RangeEncoder(1024);
    let last = enc.tell();
    for (let i = 0; i < 200; i++) {
      enc.icdf(i % 3, ICDF_4, FTB_4);
      const now = enc.tell();
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it('pedirle más de lo que cabe se marca, no revienta', () => {
    const enc = new RangeEncoder(4);
    for (let i = 0; i < 200; i++) enc.bits(0xffff, 16);
    expect(() => enc.done()).not.toThrow();
    expect(enc.busted).toBe(true);
  });
});

describe('range coder · machaque', () => {
  it('25 paquetes de 2000 operaciones mezcladas vuelven exactos', () => {
    /*
     * Esto no es redundante con los tests de arriba: el bug real que tuvo esta
     * implementación —la condición del acarreo comparaba con 0x100 en vez de
     * con 0xFF— aguantaba 1.299 símbolos antes de aparecer. Los caminos raros
     * de un coder aritmético solo salen por volumen, así que aquí se le pasan
     * cien mil operaciones con todos los modelos entremezclados.
     */
    const ICDF = [200, 150, 90, 40, 12, 0];
    type Op =
      | { k: 'e'; fl: number; fh: number; ft: number }
      | { k: 'b'; bit: number; logp: number }
      | { k: 'i'; s: number }
      | { k: 'r'; v: number; n: number }
      | { k: 'u'; v: number; ft: number };

    for (let seed = 1; seed <= 25; seed++) {
      const random = rng(seed);
      const ops: Op[] = [];
      const enc = new RangeEncoder(16384);
      for (let i = 0; i < 2000; i++) {
        const p = random();
        if (p < 0.25) {
          const ft = 2 + Math.floor(random() * 200);
          const fl = Math.floor(random() * ft);
          const fh = fl + 1 + Math.floor(random() * (ft - fl));
          ops.push({ k: 'e', fl, fh, ft });
          enc.encode(fl, fh, ft);
        } else if (p < 0.5) {
          const logp = 1 + Math.floor(random() * 15);
          const bit = random() < 0.5 ? 1 : 0;
          ops.push({ k: 'b', bit, logp });
          enc.bitLogp(bit, logp);
        } else if (p < 0.7) {
          const s = Math.floor(random() * (ICDF.length - 1));
          ops.push({ k: 'i', s });
          enc.icdf(s, ICDF, 8);
        } else if (p < 0.9) {
          const n = 1 + Math.floor(random() * 20);
          const v = Math.floor(random() * 2 ** n);
          ops.push({ k: 'r', v, n });
          enc.bits(v, n);
        } else {
          const ft = 2 + Math.floor(random() * 1000000);
          const v = Math.floor(random() * ft);
          ops.push({ k: 'u', v, ft });
          enc.uint(v, ft);
        }
      }
      expect(enc.busted).toBe(false);
      const dec = new RangeDecoder(enc.done());
      for (const op of ops) {
        if (op.k === 'e') {
          const s = dec.decode(op.ft);
          expect(s).toBeGreaterThanOrEqual(op.fl);
          expect(s).toBeLessThan(op.fh);
          dec.update(op.fl, op.fh, op.ft);
        } else if (op.k === 'b') expect(dec.bitLogp(op.logp)).toBe(op.bit);
        else if (op.k === 'i') expect(dec.icdf(ICDF, 8)).toBe(op.s);
        else if (op.k === 'r') expect(dec.bits(op.n)).toBe(op.v);
        else expect(dec.uint(op.ft)).toBe(op.v);
      }
    }
  });
});
