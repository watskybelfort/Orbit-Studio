/**
 * Revisión del suavizado por-muestra de SynthVoice (voices.ts:162-174) y de
 * AutofilterUnit (effects.ts:590-611): ambos llamaban `SVF.set()` una vez por
 * MUESTRA con un target ya continuo (filtEnv/envFollower+LFO), cuando el
 * `tau=5ms` de filters.ts asume llamadas por BLOQUE. La guarda de umbral
 * (0.2%, igual que prisma-voice.ts:987/285) es la mitigación que ya existía
 * en el repo mediante `lastCutoff` — este archivo comprueba las DOS cosas que
 * de verdad hace y la UNA que NO hace:
 *
 *  1) SÍ elimina las llamadas a `set()` (y el `Math.exp`/`Math.tan` de
 *     `commit()`) cuando el corte está quieto — el caso por defecto de
 *     AutofilterUnit (lfoAmount=envAmount=0) y la cola/sustain de SynthVoice.
 *  2) SÍ dobla como red de regresión: la salida sigue siendo finita y con la
 *     forma esperada.
 *  3) NO recupera el punch del ataque rápido: medido con las clases reales
 *     (no una reimplementación aparte), durante los 5 ms de ataque lineal
 *     por defecto el corte se mueve más de 0.2% en casi todas las muestras,
 *     así que la guarda dispara casi con la misma frecuencia que sin ella y
 *     el one-pole de 5 ms de filters.ts sigue apilado sobre el ADSR. Esto se
 *     deja documentado (no es un bug nuevo, es el límite de esta mitigación)
 *     porque el pedido explícito de la tarea era medir el ataque, no suponer
 *     que la guarda alcanza.
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

describe('SynthVoice: la guarda evita recomputar smoothCoef cuando el corte está quieto', () => {
  it('durante el release/sustain (envAmount por defecto, corte casi fijo), se llama a set() muchas menos veces que muestras hay', () => {
    const sr = 44100;
    const voice = new SynthVoice(0, 60, 0, 1, {}, sr);
    const outL = new Float32Array(sr);
    const outR = new Float32Array(sr);
    const calls = countSvfSetCalls(() => {
      voice.render(outL, outR, 0, sr, 1, 1); // 1 s completo: ataque, decay, sustain largo
    });
    // Sin guarda serían exactamente `sr` llamadas (una por muestra). Con
    // guarda, una vez pasado el ataque (5 ms) y el decay (0.3*1.4=0.42 s) el
    // corte prácticamente no se mueve durante el resto del segundo: la
    // mayoría de las ~44100 muestras deberían saltarse la llamada.
    expect(calls).toBeLessThan(sr * 0.3);
    // Y la voz sigue sonando (no rompimos el filtro).
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
    // Documentando el hallazgo: la guarda de 0.2% no reduce las llamadas
    // durante el ataque porque `fc` se mueve más que eso en casi cada
    // muestra. Si esto alguna vez baja mucho, quiere decir que la guarda
    // empezó a alterar el ataque (bueno o malo, pero hay que mirarlo).
    expect(calls).toBeGreaterThan(attackSamples * 0.9);
  });

  it('el one-pole extra sigue ahí: el corte tarda sensiblemente más que el ataque nominal en asentarse', () => {
    // Reproduce el mecanismo con las clases reales de filters.ts/env.ts (no
    // una copia aparte), comparando tres estrategias de trackear un corte
    // continuo: IDEAL (sin suavizado, referencia de "cero lag"), ACTUAL
    // (set() cada muestra, el comportamiento pre-guarda) y CON-GUARDA (la
    // guarda de 0.2% que se aplicó en esta tarea). Medido: el ataque nominal
    // de 5 ms tarda ~6.8 ms en asentarse al 90% tanto con como sin guarda —
    // la guarda no cambia el resultado durante un ataque rápido (ver el
    // comentario del archivo).
    const sr = 44100;
    const cutoff = 4000;
    const envAmount = 0.4;
    const resonance = 0.2;
    const fcAt = (fe: number) => cutoff * Math.pow(2, envAmount * 4 * fe);
    const toneHz = 9000;
    const toneInc = (2 * Math.PI * toneHz) / sr;
    const N = 1000;

    function run(mode: 'ideal' | 'perSample' | 'guarded'): number[] {
      const filtEnv = new ADSR();
      filtEnv.set(0.005, 0.3 * 1.4, 0.2, 0.25, sr);
      filtEnv.on();
      const svf = new SVF();
      let lastCutoff = -1;
      let phase = 0;
      let peak = 0;
      const peakDecay = Math.exp(-1 / (0.003 * sr));
      const env: number[] = [];
      for (let i = 0; i < N; i++) {
        const fe = filtEnv.tick();
        const fc = fcAt(fe);
        if (mode === 'perSample') {
          svf.set(fc, resonance, sr);
        } else if (mode === 'guarded') {
          if (fc > lastCutoff * 1.002 || fc < lastCutoff * 0.998) {
            lastCutoff = fc;
            svf.set(fc, resonance, sr);
          }
        } else {
          svf.set(fc, resonance, sr);
          (svf as unknown as { g: number; gTarget: number }).g = (svf as unknown as { gTarget: number }).gTarget;
          (svf as unknown as { k: number; kTarget: number }).k = (svf as unknown as { kTarget: number }).kTarget;
        }
        phase += toneInc;
        const y = svf.tick(Math.sin(phase), 0);
        const a = Math.abs(y);
        peak = a > peak ? a : peak * peakDecay;
        env.push(peak);
      }
      return env;
    }

    function timeTo90(env: number[], final: number): number {
      const target = final * 0.9;
      return env.findIndex((v) => v >= target);
    }

    const ideal = run('ideal');
    const perSample = run('perSample');
    const guarded = run('guarded');
    const final = ideal[ideal.length - 1]!;

    const t90ideal = timeTo90(ideal, final);
    const t90perSample = timeTo90(perSample, final);
    const t90guarded = timeTo90(guarded, final);

    // El ideal (sin one-pole extra) asienta bastante antes que con el
    // suavizado de filters.ts encima, con o sin guarda.
    expect(t90perSample).toBeGreaterThan(t90ideal * 1.5);
    // La guarda no lo arregla: el tiempo con guarda es esencialmente el
    // mismo que sin ella (dentro de una muestra) durante un ataque rápido.
    expect(Math.abs(t90guarded - t90perSample)).toBeLessThanOrEqual(1);
  });
});

describe('AutofilterUnit: la guarda evita recomputar smoothCoef con el preset por defecto', () => {
  it('con lfoAmount=envAmount=0 (por defecto), el corte no se mueve: set() se llama una sola vez por canal en todo el bloque', () => {
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
    // Con guarda, una sola vez por canal (la primera, cuando `primed` aún no
    // estaba armado) y nunca más porque `fc` es idéntico sample a sample.
    expect(calls).toBe(2);
  });

  it('con modulación de LFO activa, el corte SÍ se mueve y la guarda sigue disparando cuando corresponde', () => {
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
    // Con el LFO moviendo el corte en 2 octavas, la mayoría de las 6400
    // muestras deberían disparar la guarda (no es el caso "quieto").
    expect(calls).toBeGreaterThan(2);
  });
});
