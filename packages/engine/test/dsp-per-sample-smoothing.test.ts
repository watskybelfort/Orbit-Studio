/**
 * Los llamantes POR MUESTRA de los filtros: SynthVoice (voices.ts),
 * PrismaVoice (prisma-voice.ts) y AutofilterUnit (effects.ts).
 *
 * Los tres calculan el corte muestra a muestra desde algo que ya es continuo
 * (un ADSR de filtro, un LFO, un seguidor de envolvente) y se lo pasan al SVF.
 * El `tau = 5 ms` de filters.ts, en cambio, está pensado para el OTRO llamante:
 * el kernel, que empuja `setParams()` una vez por bloque y deja una escalera
 * que hay que rellenar o se oye como zipper. Apilados, el one-pole de 5 ms caía
 * encima de un ADSR cuyo ataque por defecto también son 5 ms y le comía el
 * punch al pluck.
 *
 * Este archivo cubre las TRES cosas que hay en juego, y conviene no
 * confundirlas nunca más:
 *
 *  1) La GUARDA de umbral del 0,2 % (`lastCutoff`) ahorra CPU cuando el corte
 *     está quieto —el preset por defecto del autofiltro, el sustain de una
 *     voz— y no hace ni pretende hacer nada más. Está MEDIDO aquí abajo que
 *     durante un ataque de 5 ms dispara en casi todas las muestras: nunca fue
 *     candidata a arreglar el retraso, y por eso sigue en su sitio.
 *  2) El modo `'per-sample'` del filtro (`CoefSource` en filters.ts) es lo que
 *     sí quita el retraso: el llamante por muestra ya entrega una curva
 *     continua, no un escalón, y aquí se comprueba que el ataque vuelve a ser
 *     exactamente el de la referencia sin suavizar.
 *  3) Que el zipper NO vuelva por el camino que sí lo tenía. Un filtro
 *     `'per-sample'` deja de amortiguar a su llamante, así que el llamante se
 *     hace cargo de los parámetros que SÍ le llegan por bloque: AutofilterUnit
 *     desliza `cutoff`/`resonance` él mismo (`cutoffLive`/`resLive`). Ese
 *     deslizamiento es carga estructural, no adorno, y el control de abajo mide
 *     cuánta basura mete quitarlo.
 */
import { describe, expect, it } from 'vitest';
import { SVF } from '../src/dsp/filters';
import { ADSR } from '../src/dsp/env';
import { SynthVoice } from '../src/dsp/voices';
import { createEffect } from '../src/dsp/effects';

function countSvfSetCalls(run: () => void): number {
  const original = SVF.prototype.set;
  let calls = 0;
  SVF.prototype.set = function (this: SVF, ...args: Parameters<typeof original>) {
    calls++;
    return original.apply(this, args);
  };
  try {
    run();
  } finally {
    SVF.prototype.set = original;
  }
  return calls;
}

/** Energía RMS por encima de `hz` (cuatro pasa-altos one-pole en cascada). */
function hfRms(x: Float32Array, hz: number, sr: number, skip: number): number {
  const a = Math.exp((-2 * Math.PI * hz) / sr);
  const y = Float32Array.from(x);
  for (let s = 0; s < 4; s++) {
    let prev = 0;
    let acc = 0;
    for (let i = 0; i < y.length; i++) {
      const inp = y[i]!;
      acc = a * (acc + inp - prev);
      prev = inp;
      y[i] = acc;
    }
  }
  let e = 0;
  for (let i = skip; i < y.length; i++) e += y[i]! * y[i]!;
  return Math.sqrt(e / Math.max(1, y.length - skip));
}

describe('SynthVoice: la guarda del 0,2 % ahorra CPU, y solo eso', () => {
  it('durante el release/sustain (corte casi fijo) se llama a set() muchas menos veces que muestras hay', () => {
    const sr = 44100;
    const voice = new SynthVoice(0, 60, 0, 1, {}, sr);
    const outL = new Float32Array(sr);
    const outR = new Float32Array(sr);
    const calls = countSvfSetCalls(() => {
      voice.render(outL, outR, 0, sr, 1, 1); // 1 s completo: ataque, decay, sustain largo
    });
    // Sin guarda serían exactamente `sr` llamadas (una por muestra). Con
    // guarda, una vez pasado el ataque (5 ms) y el decay (0.3*1.4=0.42 s) el
    // corte prácticamente no se mueve durante el resto del segundo.
    expect(calls).toBeLessThan(sr * 0.3);
    let allFinite = true;
    for (let i = 0; i < sr; i++) if (!Number.isFinite(outL[i]) || !Number.isFinite(outR[i])) allFinite = false;
    expect(allFinite).toBe(true);
  });

  it('el ataque rápido (5 ms por defecto) NO se beneficia de la guarda: dispara casi en cada muestra igual', () => {
    const sr = 44100;
    const voice = new SynthVoice(0, 60, 0, 1, {}, sr);
    const outL = new Float32Array(300);
    const outR = new Float32Array(300);
    const attackSamples = Math.round(0.005 * sr); // ~221 muestras
    const calls = countSvfSetCalls(() => {
      voice.render(outL, outR, 0, attackSamples, 1, 1);
    });
    // La medida que descartó el camino fácil: la guarda no reduce las llamadas
    // durante el ataque porque `fc` se mueve más de 0,2 % en casi cada muestra.
    // Si esto alguna vez baja mucho, la guarda empezó a alterar el ataque
    // (bueno o malo, pero hay que mirarlo).
    expect(calls).toBeGreaterThan(attackSamples * 0.9);
  });
});

describe("SynthVoice: el modo 'per-sample' es lo que devuelve el ataque", () => {
  it('el corte alcanza el 90 % del brillo en el mismo tiempo que la referencia sin suavizar', () => {
    // Con las clases REALES de filters.ts/env.ts, no una copia aparte. Tres
    // maneras de seguir un corte continuo:
    //   IDEAL       — sin suavizado ninguno (referencia de "cero retraso"),
    //                 forzando g/k al objetivo a mano.
    //   POR-BLOQUE  — un SVF normal al que se le llama por muestra: lo que
    //                 hacía el motor antes de esta tarea.
    //   POR-MUESTRA — `new SVF('per-sample')`, lo que hace ahora.
    // Medido a 44,1 kHz: ideal 151 muestras (3,42 ms), por-bloque 281 (6,37
    // ms), por-muestra 151 — el mismo número que el ideal, exacto, porque el
    // one-pole extra desaparece en vez de acelerarse.
    const sr = 44100;
    const cutoff = 4000;
    const envAmount = 0.4;
    const resonance = 0.2;
    const toneInc = (2 * Math.PI * 9000) / sr;
    const N = 1000;

    function run(mode: 'ideal' | 'porBloque' | 'porMuestra'): number[] {
      const filtEnv = new ADSR();
      filtEnv.set(0.005, 0.3 * 1.4, 0.2, 0.25, sr);
      filtEnv.on();
      const svf = mode === 'porMuestra' ? new SVF('per-sample') : new SVF();
      let lastCutoff = -1;
      let phase = 0;
      let peak = 0;
      const peakDecay = Math.exp(-1 / (0.003 * sr));
      const env: number[] = [];
      for (let i = 0; i < N; i++) {
        const fc = cutoff * Math.pow(2, envAmount * 4 * filtEnv.tick());
        if (mode === 'ideal') {
          svf.set(fc, resonance, sr);
          const raw = svf as unknown as { g: number; k: number; gTarget: number; kTarget: number };
          raw.g = raw.gTarget;
          raw.k = raw.kTarget;
        } else if (fc > lastCutoff * 1.002 || fc < lastCutoff * 0.998) {
          // La guarda del 0,2 %, igual que en el motor de verdad.
          lastCutoff = fc;
          svf.set(fc, resonance, sr);
        }
        phase += toneInc;
        const y = svf.tick(Math.sin(phase), 0);
        const a = Math.abs(y);
        peak = a > peak ? a : peak * peakDecay;
        env.push(peak);
      }
      return env;
    }

    const ideal = run('ideal');
    const objetivo = ideal[ideal.length - 1]! * 0.9;
    const t90 = (env: number[]) => env.findIndex((v) => v >= objetivo);

    const t90ideal = t90(ideal);
    const t90porBloque = t90(run('porBloque'));
    const t90porMuestra = t90(run('porMuestra'));

    expect(t90ideal).toBeGreaterThan(0);
    // El de antes: un one-pole de 5 ms encima de un ataque de 5 ms.
    expect(t90porBloque).toBeGreaterThan(t90ideal * 1.5);
    // El de ahora: el mismo instante que el ideal, muestra a muestra.
    expect(t90porMuestra).toBe(t90ideal);
  });

  it('la voz de verdad suena más brillante en los primeros 4 ms de un pluck', () => {
    // El A/B se hace sustituyendo el SVF privado por uno por-bloque: misma
    // voz, mismos osciladores, mismas envolventes, mismo `render()` — lo único
    // distinto es el modo del filtro. Reimplementar el bucle aparte mediría
    // otra cosa, y la gracia es medir ESTA voz.
    const sr = 44100;
    const patch = {
      wave: 0, cutoff: 400, resonance: 0.75, envAmount: 0.9,
      attack: 0.005, decay: 0.6, sustain: 0.5, release: 0.4,
      unison: 3, detune: 0.15, octave: 0,
    };
    const brillo = (porBloque: boolean): number => {
      const voice = new SynthVoice(0, 48, 0, 1, patch, sr);
      if (porBloque) (voice as unknown as { svfL: SVF }).svfL = new SVF();
      const n = Math.round(0.004 * sr);
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      voice.render(l, r, 0, n, 1, 1);
      return hfRms(l, 3000, sr, 0);
    };
    const antes = brillo(true);
    const ahora = brillo(false);
    // Medido: ~+11 dB de energía por encima de 3 kHz en la ventana del ataque.
    // El umbral se deja en 6 dB (el doble de amplitud) para que sea la
    // DIRECCIÓN lo que se fija y no el decimal.
    expect(20 * Math.log10(ahora / antes)).toBeGreaterThan(6);
  });
});

describe('AutofilterUnit: la guarda con el preset por defecto', () => {
  it('con lfoAmount=envAmount=0 el corte no se mueve: set() se llama una sola vez por canal', () => {
    const sr = 44100;
    const fx = createEffect('autofilter', sr);
    fx.setParams({}); // todo por defecto: lfoAmount=0, envAmount=0 -> fc constante
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const calls = countSvfSetCalls(() => {
      for (let bl = 0; bl < 50; bl++) {
        for (let i = 0; i < 128; i++) { l[i] = Math.sin(i * 0.2) * 0.5; r[i] = Math.sin(i * 0.21) * 0.5; }
        fx.process(l, r, 128, null, null);
      }
    });
    // Sin guarda serían 50*128*2 = 12800 llamadas (svfL + svfR cada muestra).
    // Con guarda, una sola vez por canal. Y sigue siendo 2 después de meter la
    // copia viva de `cutoff`: con el objetivo quieto, `cutoffLive === cutoff`
    // EXACTO desde el primer setParams, así que el one-pole no la despega.
    expect(calls).toBe(2);
  });

  it('con modulación de LFO activa el corte SÍ se mueve y la guarda sigue disparando', () => {
    const sr = 44100;
    const fx = createEffect('autofilter', sr);
    fx.setParams({ lfoAmount: 1, lfoRate: 2, envAmount: 0 });
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const calls = countSvfSetCalls(() => {
      for (let bl = 0; bl < 50; bl++) {
        for (let i = 0; i < 128; i++) { l[i] = Math.sin(i * 0.2) * 0.5; r[i] = Math.sin(i * 0.21) * 0.5; }
        fx.process(l, r, 128, null, null);
      }
    });
    expect(calls).toBeGreaterThan(2);
  });
});

describe('AutofilterUnit: el zipper no vuelve por el camino que sí lo tenía', () => {
  const SR = 48000;
  const BLOCK = 128;

  /** Barre `cutoff` un valor por BLOQUE, igual que la automatización real. */
  function barrido(anularCopiaViva: boolean): Float32Array {
    const fx = createEffect('autofilter', SR);
    const bloques = 24;
    const out = new Float32Array(BLOCK * bloques);
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    let idx = 0;
    for (let b = 0; b < bloques; b++) {
      const cutoff = 250 * Math.pow(9000 / 250, b / bloques);
      fx.setParams({ type: 0, cutoff, resonance: 0.6, lfoRate: 0, lfoAmount: 0, envAmount: 0 });
      // El control: con el coeficiente del deslizamiento a 0, `cutoffLive`
      // salta al objetivo y el escalón del bloque llega crudo al filtro.
      if (anularCopiaViva) (fx as unknown as { baseCoef: number }).baseCoef = 0;
      for (let i = 0; i < BLOCK; i++) {
        const x = Math.sin((2 * Math.PI * 300 * idx) / SR) * 0.5;
        l[i] = x;
        r[i] = x;
        idx++;
      }
      fx.process(l, r, BLOCK, null, null);
      out.set(l, b * BLOCK);
    }
    return out;
  }

  it('automatizar el corte por bloque no mete basura de banda alta; quitar la copia viva sí', () => {
    // Con una entrada de 300 Hz por un pasa-bajos, por encima de 6 kHz no
    // debería haber NADA: lo que aparezca son los chasquidos del escalón.
    // Medido: -113,5 dB con la copia viva y -95,2 dB sin ella, casi 20 dB de
    // basura que se oye como zipper. (Los valores absolutos son bajos porque
    // el SVF es TPT: sus estados siguen significando lo mismo después de mover
    // g/k, a diferencia de un biquad de forma directa, donde el mismo salto es
    // mucho más violento. Eso no vuelve inofensivo el escalón — lo vuelve
    // fácil de pasar por alto.)
    const bueno = hfRms(barrido(false), 6000, SR, BLOCK);
    const control = hfRms(barrido(true), 6000, SR, BLOCK);
    expect(20 * Math.log10(control / bueno)).toBeGreaterThan(10);
  });

  it('automatizar la resonancia con el corte quieto llega al filtro', () => {
    // La guarda miraba SOLO el corte: con `fc` constante nunca volvía a llamar
    // a `set()` y la resonancia automatizada no llegaba nunca. Ahora entra en
    // la guarda por derecho propio.
    const sr = 48000;
    const nivel = (resonance: number): number => {
      const fx = createEffect('autofilter', sr);
      fx.setParams({ type: 2, cutoff: 1000, resonance: 0.05, lfoRate: 0, lfoAmount: 0, envAmount: 0 });
      const l = new Float32Array(128);
      const r = new Float32Array(128);
      let idx = 0;
      let pico = 0;
      // 40 bloques: los primeros con la resonancia baja, y a partir del 8º se
      // automatiza la de verdad. Se mide solo la última mitad, ya asentada.
      for (let b = 0; b < 40; b++) {
        if (b === 8) fx.setParams({ type: 2, cutoff: 1000, resonance, lfoRate: 0, lfoAmount: 0, envAmount: 0 });
        for (let i = 0; i < 128; i++) {
          const x = Math.sin((2 * Math.PI * 1000 * idx) / sr) * 0.5;
          l[i] = x;
          r[i] = x;
          idx++;
        }
        fx.process(l, r, 128, null, null);
        if (b >= 30) for (let i = 0; i < 128; i++) pico = Math.max(pico, Math.abs(l[i]!));
      }
      return pico;
    };
    // Un pasa-banda a su propia frecuencia central: con Q alto tiene que salir
    // bastante más fuerte que con Q bajo.
    expect(nivel(0.95)).toBeGreaterThan(nivel(0.05) * 2);
  });

  it('process() no aloca (regla dura 2)', () => {
    const sr = 48000;
    const fx = createEffect('autofilter', sr);
    fx.setParams({ type: 0, cutoff: 800, resonance: 0.7, lfoRate: 3.5, lfoAmount: 0.9, envAmount: 0.5 });
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let i = 0; i < 128; i++) { l[i] = Math.sin(i * 0.2) * 0.5; r[i] = Math.sin(i * 0.21) * 0.5; }
    fx.process(l, r, 128, null, null); // bloque de calentamiento fuera de la cuenta

    const Real = globalThis.Float32Array;
    let allocations = 0;
    class Counting extends Real {
      constructor(...args: ConstructorParameters<typeof Real>) {
        super(...args);
        allocations++;
      }
    }
    (globalThis as { Float32Array: unknown }).Float32Array = Counting;
    try {
      for (let b = 0; b < 32; b++) {
        fx.setParams({ type: 0, cutoff: 800 + b * 10, resonance: 0.7, lfoRate: 3.5, lfoAmount: 0.9, envAmount: 0.5 });
        fx.process(l, r, 128, null, null);
      }
    } finally {
      (globalThis as { Float32Array: unknown }).Float32Array = Real;
    }
    expect(allocations).toBe(0);
  });
});
