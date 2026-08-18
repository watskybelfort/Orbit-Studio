/**
 * Efectos v1: Orbit Convolver (reverb por convolución con IR sintética) y
 * Orbit Vinyl (lo-fi de disco). Lo que se vigila aquí es lo que rompería el
 * motor: que la convolución particionada dé EXACTAMENTE la convolución lineal,
 * que la IR esté normalizada por energía y que nada de esto use Math.random
 * (dos instancias iguales tienen que dar el mismo audio muestra a muestra).
 */

import { describe, expect, it } from 'vitest';
import { EFFECT_LABELS, EFFECT_PARAMS, defaultEffectParams } from '@orbit/core';
import { createEffect, type EffectUnit } from '../src/dsp/effects';
import {
  CONV_BLOCK,
  PartitionedConvolver,
  buildSyntheticIr,
} from '../src/dsp/convolver';
import { Noise } from '../src/dsp/osc';

const SR = 48000;

/** Renderiza `samples` muestras por bloques de 128, como hace el kernel. */
function render(
  unit: EffectUnit,
  samples: number,
  src: (i: number) => [number, number],
): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(samples);
  const r = new Float32Array(samples);
  const bl = new Float32Array(CONV_BLOCK);
  const br = new Float32Array(CONV_BLOCK);
  for (let off = 0; off < samples; off += CONV_BLOCK) {
    const n = Math.min(CONV_BLOCK, samples - off);
    for (let i = 0; i < n; i++) {
      const [a, b] = src(off + i);
      bl[i] = a;
      br[i] = b;
    }
    unit.process(bl, br, n, null, null);
    l.set(bl.subarray(0, n), off);
    r.set(br.subarray(0, n), off);
  }
  return { l, r };
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

function peak(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]!));
  return m;
}

function hasNaN(x: Float32Array): boolean {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i]!)) return true;
  return false;
}

function convolverUnit(params: Record<string, number> = {}): EffectUnit {
  const u = createEffect('convolver', SR);
  u.setParams({ ...defaultEffectParams('convolver'), ...params });
  return u;
}

function vinylUnit(params: Record<string, number> = {}): EffectUnit {
  const u = createEffect('vinyl', SR);
  u.setParams({ ...defaultEffectParams('vinyl'), ...params });
  return u;
}

function distortionUnit(params: Record<string, number> = {}): EffectUnit {
  const u = createEffect('distortion', SR);
  u.setParams({ ...defaultEffectParams('distortion'), ...params });
  return u;
}

/** Salida ya asentada para una entrada CONSTANTE v (el tone-lowpass tiene ganancia 1 en DC). */
function settledOut(mode: number, drive: number, v: number): number {
  const u = distortionUnit({ mode, drive });
  const { l } = render(u, 2048, () => [v, v]);
  return l[l.length - 1]!;
}

// ── Registro de parámetros ───────────────────────────────────────────────────

describe('registro', () => {
  it('los dos efectos nuevos tienen perillas y etiqueta', () => {
    expect(EFFECT_LABELS.convolver).toBe('Orbit Convolver');
    expect(EFFECT_LABELS.vinyl).toBe('Orbit Vinyl');
    expect(EFFECT_PARAMS.convolver.map((s) => s.key)).toEqual([
      'size',
      'decay',
      'damp',
      'predelay',
      'width',
    ]);
    expect(EFFECT_PARAMS.vinyl.map((s) => s.key)).toEqual([
      'crackle',
      'noise',
      'wow',
      'flutter',
      'tone',
    ]);
  });
});

// ── Convolución particionada ─────────────────────────────────────────────────

describe('convolución particionada', () => {
  // Longitudes que ejercitan las tres etapas: solo la de 128, las dos primeras
  // y las tres con varias particiones en la última (que es la que reparte su
  // trabajo entre sub-bloques).
  it.each([600, 3000, 9000, 40000])(
    'da la misma convolución lineal que el bucle directo (IR de %i)',
    (irLen: number) => {
      const ir = new Float32Array(irLen);
      const n1 = new Noise(0x1234567);
      let energy = 0;
      for (let i = 0; i < irLen; i++) {
        ir[i] = n1.tick() * Math.exp((-4 * i) / irLen);
        energy += ir[i]! * ir[i]!;
      }
      const g = 1 / Math.sqrt(energy);
      for (let i = 0; i < irLen; i++) ir[i] = ir[i]! * g;

      const blocks = Math.ceil((irLen * 1.4) / CONV_BLOCK) + 40;
      const total = blocks * CONV_BLOCK;
      const x = new Float32Array(total);
      const n2 = new Noise(0x7654321);
      for (let i = 0; i < total; i++) x[i] = n2.tick();

      const conv = new PartitionedConvolver();
      conv.setIr(ir, irLen);
      const got = new Float32Array(total);
      const inBuf = new Float32Array(CONV_BLOCK);
      const outBuf = new Float32Array(CONV_BLOCK);
      for (let b = 0; b < blocks; b++) {
        inBuf.set(x.subarray(b * CONV_BLOCK, (b + 1) * CONV_BLOCK));
        conv.processBlock(inBuf, outBuf);
        got.set(outBuf, b * CONV_BLOCK);
      }

      // Referencia: convolución directa, sin FFT ni particiones.
      let worst = 0;
      for (let t = 0; t < total; t += 97) {
        let acc = 0;
        const kMax = Math.min(irLen - 1, t);
        for (let k = 0; k <= kMax; k++) acc += ir[k]! * x[t - k]!;
        worst = Math.max(worst, Math.abs(acc - got[t]!));
      }
      expect(worst).toBeLessThan(1e-3);
      expect(rms(got)).toBeGreaterThan(0.05);
    },
  );
});

// ── IR sintética ─────────────────────────────────────────────────────────────

describe('IR sintética', () => {
  it('queda normalizada por energía en los dos canales', () => {
    for (const decay of [0.3, 1.2, 3]) {
      const ir = buildSyntheticIr(SR, 0.6, decay, 0.45);
      let el = 0;
      let er = 0;
      for (let i = 0; i < ir.l.length; i++) el += ir.l[i]! * ir.l[i]!;
      for (let i = 0; i < ir.r.length; i++) er += ir.r[i]! * ir.r[i]!;
      expect(el).toBeCloseTo(1, 3);
      expect(er).toBeCloseTo(1, 3);
      // Normalizada por energía, NO por pico: el pico queda muy por debajo de 1.
      expect(peak(ir.l)).toBeLessThan(0.5);
      expect(ir.l.length).toBe(Math.round(decay * SR));
    }
  });

  it('los canales están descorrelacionados y la cola decae', () => {
    const ir = buildSyntheticIr(SR, 0.6, 1, 0.45);
    let dot = 0;
    for (let i = 0; i < ir.l.length; i++) dot += ir.l[i]! * ir.r[i]!;
    // Energía 1 por canal: la correlación cruzada de dos ruidos distintos
    // tiene que quedar cerca de cero.
    expect(Math.abs(dot)).toBeLessThan(0.2);
    const early = rms(ir.l, 0, SR * 0.1);
    const late = rms(ir.l, SR * 0.8, SR);
    expect(late).toBeLessThan(early * 0.3);
    expect(late).toBeGreaterThan(0);
  });

  it('damp cierra los agudos de la cola', () => {
    const abierta = buildSyntheticIr(SR, 0.6, 1, 0);
    const cerrada = buildSyntheticIr(SR, 0.6, 1, 1);
    // Diferencia de primer orden ≈ energía de agudos; con la misma energía
    // total, la IR amortiguada tiene que traer bastante menos.
    const brillo = (x: Float32Array): number => {
      let s = 0;
      for (let i = 1; i < x.length; i++) {
        const d = x[i]! - x[i - 1]!;
        s += d * d;
      }
      return s;
    };
    expect(brillo(cerrada.l)).toBeLessThan(brillo(abierta.l) * 0.5);
  });
});

// ── Orbit Convolver ──────────────────────────────────────────────────────────

describe('Orbit Convolver', () => {
  it('alarga la cola de un impulso', () => {
    const u = convolverUnit({ decay: 0.5, predelay: 0 });
    const samples = SR;
    const out = render(u, samples, (i) => (i === 0 ? [1, 1] : [0, 0]));
    const pronto = rms(out.l, Math.floor(SR * 0.05), Math.floor(SR * 0.15));
    const tarde = rms(out.l, Math.floor(SR * 0.45), Math.floor(SR * 0.55));
    // La entrada dura 1 muestra; a 100 ms sigue sonando.
    expect(pronto).toBeGreaterThan(1e-5);
    // Y la cola decae (RT60 = 0.5 s).
    expect(tarde).toBeGreaterThan(0);
    expect(tarde).toBeLessThan(pronto * 0.4);
    expect(hasNaN(out.l)).toBe(false);
  });

  it('el predelay retrasa la entrada del wet', () => {
    const seco = convolverUnit({ decay: 0.4, predelay: 0 });
    const conPre = convolverUnit({ decay: 0.4, predelay: 0.1 });
    const imp = (i: number): [number, number] => (i === 0 ? [1, 1] : [0, 0]);
    const a = render(seco, SR, imp);
    const b = render(conPre, SR, imp);
    // A 50 ms el wet con 100 ms de predelay todavía no ha llegado.
    const ventana = Math.floor(SR * 0.05);
    expect(rms(b.l, 0, ventana)).toBeLessThan(rms(a.l, 0, ventana) * 0.05);
    expect(rms(b.l, Math.floor(SR * 0.12), Math.floor(SR * 0.2))).toBeGreaterThan(1e-5);
  });

  it('es determinista entre dos instancias', () => {
    const a = convolverUnit();
    const b = convolverUnit();
    const src = (i: number): [number, number] => {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
      return [s, s * 0.8];
    };
    const ra = render(a, CONV_BLOCK * 60, src);
    const rb = render(b, CONV_BLOCK * 60, src);
    expect(ra.l).toEqual(rb.l);
    expect(ra.r).toEqual(rb.r);
    expect(rms(ra.l)).toBeGreaterThan(0);
  });

  it('con parámetros por defecto no destroza el nivel ni saca NaN', () => {
    const u = convolverUnit();
    const n = new Noise(0x2b1a9);
    const total = CONV_BLOCK * 200;
    const dry = new Float32Array(total);
    for (let i = 0; i < total; i++) dry[i] = n.tick() * 0.3;
    const out = render(u, total, (i) => [dry[i]!, dry[i]!]);
    expect(hasNaN(out.l)).toBe(false);
    expect(hasNaN(out.r)).toBe(false);
    // IR normalizada por energía: con entrada de banda ancha el wet sale al
    // nivel del dry, ni se desvanece ni se dispara.
    const ratio = rms(out.l, CONV_BLOCK * 20) / rms(dry, CONV_BLOCK * 20);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
    expect(peak(out.l)).toBeLessThan(4);
  });

  it('width a 0 colapsa el wet a mono', () => {
    const u = convolverUnit({ width: 0 });
    const n = new Noise(0x5f2c);
    const total = CONV_BLOCK * 60;
    const out = render(u, total, () => {
      const s = n.tick() * 0.3;
      return [s, s];
    });
    let dif = 0;
    for (let i = 0; i < total; i++) dif = Math.max(dif, Math.abs(out.l[i]! - out.r[i]!));
    expect(dif).toBeLessThan(1e-6);
  });
});

// ── Orbit Vinyl ──────────────────────────────────────────────────────────────

describe('Orbit Vinyl', () => {
  it('añade ruido audible con noise > 0 y silencio con noise = 0', () => {
    const conRuido = vinylUnit({ noise: 1, crackle: 0, wow: 0, flutter: 0 });
    const sinRuido = vinylUnit({ noise: 0, crackle: 0, wow: 0, flutter: 0 });
    const silencio = (): [number, number] => [0, 0];
    const a = render(conRuido, SR, silencio);
    const b = render(sinRuido, SR, silencio);
    expect(rms(a.l)).toBeGreaterThan(1e-3);
    expect(rms(a.r)).toBeGreaterThan(1e-3);
    // Ruido de superficie, no un muro: sigue siendo un fondo.
    expect(rms(a.l)).toBeLessThan(0.2);
    // Sin señal y sin ruido, la salida es silencio exacto.
    expect(peak(b.l)).toBe(0);
    // L y R son ruidos distintos (semillas distintas).
    let dif = 0;
    for (let i = 0; i < a.l.length; i++) dif = Math.max(dif, Math.abs(a.l[i]! - a.r[i]!));
    expect(dif).toBeGreaterThan(1e-4);
  });

  it('los chasquidos son dispersos, no un ruido continuo', () => {
    const fuerte = vinylUnit({ crackle: 1, noise: 0, wow: 0, flutter: 0 });
    const suave = vinylUnit({ crackle: 0.2, noise: 0, wow: 0, flutter: 0 });
    const a = render(fuerte, SR, () => [0, 0]);
    const b = render(suave, SR, () => [0, 0]);
    const p = peak(a.l);
    expect(p).toBeGreaterThan(0.01);
    // Factor de cresta alto = impulsos sueltos, no una alfombra de ruido.
    expect(p / rms(a.l)).toBeGreaterThan(5);
    // Y la perilla manda: menos crackle, menos chasquidos.
    expect(rms(b.l)).toBeGreaterThan(0);
    expect(rms(b.l)).toBeLessThan(rms(a.l) * 0.5);
  });

  it('wow/flutter mueven el tono de la señal', () => {
    const seno = (i: number): [number, number] => {
      const s = Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5;
      return [s, s];
    };
    const quieto = vinylUnit({ crackle: 0, noise: 0, wow: 0, flutter: 0 });
    const derivando = vinylUnit({ crackle: 0, noise: 0, wow: 1, flutter: 1 });
    const a = render(quieto, SR, seno);
    const b = render(derivando, SR, seno);
    let dif = 0;
    for (let i = SR / 2; i < SR; i++) dif = Math.max(dif, Math.abs(a.l[i]! - b.l[i]!));
    // Un desplazamiento de varios ms a 1 kHz cambia la fase por completo.
    expect(dif).toBeGreaterThan(0.2);
  });

  it('es determinista entre dos instancias', () => {
    const a = vinylUnit();
    const b = vinylUnit();
    const src = (i: number): [number, number] => {
      const s = Math.sin((2 * Math.PI * 330 * i) / SR) * 0.4;
      return [s, -s];
    };
    const ra = render(a, CONV_BLOCK * 200, src);
    const rb = render(b, CONV_BLOCK * 200, src);
    expect(ra.l).toEqual(rb.l);
    expect(ra.r).toEqual(rb.r);
  });

  it('con parámetros neutros deja pasar la señal sin NaN ni subidón', () => {
    const u = vinylUnit({ crackle: 0, noise: 0, wow: 0, flutter: 0, tone: 18000 });
    const total = CONV_BLOCK * 200;
    const src = (i: number): [number, number] => {
      const s = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.5;
      return [s, s];
    };
    const out = render(u, total, src);
    expect(hasNaN(out.l)).toBe(false);
    const dry = new Float32Array(total);
    for (let i = 0; i < total; i++) dry[i] = src(i)[0];
    const ratio = rms(out.l, 1000) / rms(dry, 1000);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
    expect(peak(out.l)).toBeLessThan(0.7);
  });
});

// ── Orbit Drive: foldback ─────────────────────────────────────────────────────

describe('distorsión foldback (mode Fold)', () => {
  it('es simétrica: shape(-x) = -shape(x)', () => {
    // El foldback es una función impar; el bug del % con signo rompía justo el
    // semiciclo negativo, así que comprobamos varios puntos, incluidos los que
    // se pliegan más de una vez (|v| > 1).
    for (const v of [0.3, 0.6, 0.9, 1.5, 3]) {
      const pos = settledOut(2, 1, v);
      const neg = settledOut(2, 1, -v);
      expect(neg).toBeCloseTo(-pos, 4);
    }
  });

  it('mantiene la salida en rango, sin el disparo del semiciclo negativo', () => {
    // Con el bug, una entrada de -0,9 (drive 0,4) salía a +1,9 (≈4× fuera de
    // rango); plegada de verdad, la salida no pasa de |shape|·output·0,5 = 0,5.
    const u = distortionUnit({ mode: 2, drive: 0.4 });
    const { l, r } = render(u, 4096, (i) => {
      const x = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.95; // barre casi todo [-1, 1]
      return [x, x];
    });
    expect(hasNaN(l)).toBe(false);
    expect(peak(l)).toBeLessThanOrEqual(1);
    expect(peak(r)).toBeLessThanOrEqual(1);
  });
});
