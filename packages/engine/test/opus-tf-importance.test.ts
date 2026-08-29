/**
 * Recuperar el acorde: los pesos `importance[]` del Viterbi de `tfAnalysis` y
 * el apagado por tonalidad del detector de transitorios.
 *
 * El diagnóstico ya estaba hecho antes de esta pieza (`vbr.ts`, `transient.ts`):
 * el detector dispara falsos positivos en un acorde sostenido porque sus
 * parciales armónicos baten entre sí y la energía de 2,5 ms fluctúa de verdad.
 * Este archivo prueba las DOS piezas que se midieron para recuperarlo —el
 * banco entero está en `tools/qa/opus-tf-recover-ab.ts`—, cada una por
 * separado y sin bitstream:
 *
 * 1. `bandImportance` / el peso en `tfAnalysis`: que una banda que sobresale
 *    pese más que una plana, y que sin pasar `importance` el resultado sea
 *    IDÉNTICO al de antes (peso 1 en todas partes).
 * 2. El apagado por tonalidad de `transientAnalysis`: que sólo rebaje un
 *    disparo DÉBIL con periodicidad fuerte, nunca uno claro ni uno sin
 *    periodicidad, y que sin activarlo el detector decida exactamente igual.
 *
 * Y al final, la comprobación de bitstream: con el peso por importancia activo
 * —que es el valor por defecto desde esta pieza—, la cabecera de una trama de
 * acorde en estéreo a 128k se sigue leyendo con el `RangeDecoder` igual que un
 * decodificador de verdad, muchas tramas seguidas y sin desincronizarse.
 */

import { describe, expect, it } from 'vitest';
import { encodeOpusPackets } from '../src/render/opus/encoder';
import { NB_BANDS, TF_SELECT_TABLE } from '../src/render/opus/tables';
import { OPUS_EBANDS } from '../src/render/opus/rate';
import { tfAnalysis, transientAnalysis, type TonalGate } from '../src/render/opus/transient';
import { crearEstadoLector, leerCabeceraCelt } from '../../../tools/qa/opus-celt-header';

const SR = 48000;
const N = 960;
const LM = 3;
const M = 1 << LM;

describe('bandImportance / el peso en tfAnalysis', () => {
  /** Bandas normalizadas de una trama de bloques cortos, ya intercaladas. */
  function bandas(valor: (banda: number, bin: number, sub: number) => number): Float64Array {
    const x = new Float64Array(N);
    for (let i = 0; i < NB_BANDS; i++) {
      for (let k = OPUS_EBANDS[i]!; k < OPUS_EBANDS[i + 1]!; k++) {
        for (let b = 0; b < M; b++) x[k * M + b] = valor(i, k, b);
      }
    }
    return x;
  }

  it('sin `importance`, el resultado es idéntico al de antes (peso 1 implícito)', () => {
    const x = bandas((i, k) => (k === OPUS_EBANDS[i]! ? 1 : 0));
    const sinPasar = tfAnalysis(x, OPUS_EBANDS, NB_BANDS, 1, LM, N, 0, 0.3);
    const pesoUno = tfAnalysis(
      x,
      OPUS_EBANDS,
      NB_BANDS,
      1,
      LM,
      N,
      0,
      0.3,
      new Float64Array(NB_BANDS).fill(1),
    );
    expect(Array.from(sinPasar.tfRes)).toEqual(Array.from(pesoUno.tfRes));
    expect(sinPasar.tfSelect).toBe(pesoUno.tfSelect);
  });

  it('una banda con mucho peso arrastra el Viterbi hacia SU preferencia, no la de sus vecinas', () => {
    // Ruido en todas las bandas salvo una: un tono puro fijo en un solo bin,
    // que es justo el caso de un parcial armónico aislado.
    const r = ruido(5);
    const bandaTonal = 10;
    const x = bandas((i, k) => (i === bandaTonal ? (k === OPUS_EBANDS[i]! ? 1 : 0) : r()));

    const plano = tfAnalysis(x, OPUS_EBANDS, NB_BANDS, 1, LM, N, 0, 0.5);
    // Sin peso, la banda tonal se deja llevar por el Viterbi de sus vecinas
    // (el ruido prefiere resolución temporal, isTransient=1): comprobamos que
    // AL PESARLA queda del lado de la frecuencia con más margen que sin pesar.
    const importance = new Float64Array(NB_BANDS).fill(1);
    importance[bandaTonal] = 16; // el máximo de `bandImportance`
    const pesado = tfAnalysis(x, OPUS_EBANDS, NB_BANDS, 1, LM, N, 0, 0.5, importance);

    const fila = TF_SELECT_TABLE[LM]!;
    const resuelve = (r: typeof plano) => fila[4 + 2 * r.tfSelect + r.tfRes[bandaTonal]!]!;
    // Cuanto MÁS ALTO el valor de la tabla, más resolución de FRECUENCIA se
    // conserva (0 es la resolución temporal completa de un bloque corto). Con
    // la banda pesada, no puede quedar peor que sin pesar.
    expect(resuelve(pesado)).toBeGreaterThanOrEqual(resuelve(plano));
  });
});

describe('el apagado por tonalidad del detector', () => {
  const LEN = N + 120; // OVERLAP = 120

  function buffer(muestra: (i: number) => number): Float64Array {
    const out = new Float64Array(LEN);
    for (let i = 0; i < LEN; i++) out[i] = muestra(i);
    return out;
  }

  it('sin pasar `tonal`, el detector decide exactamente igual que antes', () => {
    const golpe = LEN >> 1;
    const r = ruido(1);
    const x = buffer((i) => (i < golpe ? 0 : r() * Math.exp(-(i - golpe) / 72)));
    const sinGate = transientAnalysis(x, LEN, 1);
    const gateInactivo: TonalGate = { gain1: 0.9, activo: false };
    const conGateApagado = transientAnalysis(x, LEN, 1, gateInactivo);
    expect(conGateApagado.isTransient).toBe(sinGate.isTransient);
    expect(conGateApagado.metric).toBeCloseTo(sinGate.metric, 10);
  });

  it('rebaja un disparo DÉBIL si la trama tiene periodicidad fuerte', () => {
    // Un tono sostenido con un salto de fase pequeño: dispara flojo (por
    // encima del umbral pero lejos de un click de verdad) y es justo el caso
    // de un acorde sostenido cuyos parciales baten entre sí.
    const x = buffer((i) => {
      const t = i / SR;
      const fase = i < LEN / 2 ? 0 : 0.15;
      return 0.5 * Math.sin(2 * Math.PI * 440 * t + fase);
    });
    const base = transientAnalysis(x, LEN, 1);
    // Este caso tiene que disparar y ser DÉBIL para que la prueba diga algo.
    expect(base.isTransient).toBe(true);
    expect(base.metric).toBeLessThan(600);

    const tonalFuerte: TonalGate = { gain1: 0.5, activo: true };
    const conGate = transientAnalysis(x, LEN, 1, tonalFuerte);
    expect(conGate.isTransient).toBe(false);
    // La métrica no se toca: sólo se reinterpreta si CUENTA como transitorio.
    expect(conGate.metric).toBe(base.metric);
  });

  it('nunca rebaja un disparo CLARO, aunque la trama sea muy periódica', () => {
    // Golpe seco de verdad: la métrica se va muy por encima del umbral débil.
    const golpe = LEN >> 1;
    const r = ruido(23);
    const x = buffer((i) => (i < golpe ? 0 : r() * Math.exp(-(i - golpe) / 20)));
    const base = transientAnalysis(x, LEN, 1);
    expect(base.isTransient).toBe(true);
    expect(base.metric).toBeGreaterThanOrEqual(600);

    const tonalFuerte: TonalGate = { gain1: 0.9, activo: true };
    const conGate = transientAnalysis(x, LEN, 1, tonalFuerte);
    expect(conGate.isTransient).toBe(true);
  });

  it('no rebaja un disparo débil si la periodicidad NO es fuerte', () => {
    const x = buffer((i) => {
      const t = i / SR;
      const fase = i < LEN / 2 ? 0 : 0.15;
      return 0.5 * Math.sin(2 * Math.PI * 440 * t + fase);
    });
    const base = transientAnalysis(x, LEN, 1);
    expect(base.isTransient).toBe(true);

    const sinPeriodo: TonalGate = { gain1: 0.1, activo: true };
    const conGate = transientAnalysis(x, LEN, 1, sinPeriodo);
    expect(conGate.isTransient).toBe(true);
  });
});

describe('el bitstream sigue sincronizado con el peso por importancia activo', () => {
  it('un acorde en estéreo a 128k se relee entero con el RangeDecoder, muchas tramas seguidas', () => {
    // El mismo acorde de cinco parciales armónicos que usa el banco
    // (`opus-bench.ts`): es la señal que retrocedía antes de esta pieza.
    const seconds = 1.5;
    const n = Math.floor(SR * seconds);
    const mono = new Float64Array(n);
    const parciales = [220, 277.18, 329.63, 440, 554.37];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
      let v = 0;
      for (let k = 0; k < parciales.length; k++) {
        v += Math.sin(2 * Math.PI * parciales[k]! * t) * (0.3 / (k + 1));
      }
      mono[i] = v * env;
    }
    const channels = 2;
    const pcm = new Float64Array(n * channels);
    for (let i = 0; i < n; i++) {
      pcm[i * channels] = mono[i]!;
      pcm[i * channels + 1] = (mono[Math.max(0, i - 13)] ?? 0) * 0.8;
    }

    // Sin pasar `tfWeight`: usa el valor por defecto, `'importancia-larga'`.
    const paquetes = encodeOpusPackets(pcm, { channels, bitrate: 128000, frameSize: N });
    expect(paquetes.length).toBeGreaterThan(50);

    const lector = crearEstadoLector(channels);
    for (const paquete of paquetes) {
      // Si el bit de transitorio, `tf_res` o `tf_select` se hubiera decidido
      // FUERA de la rama que lo escribe, esto no tira un error bonito: lee un
      // número de bandas o un reparto sin sentido, o revienta el
      // `RangeDecoder` al quedarse sin bits donde no tocaba. Que las 76
      // tramas se lean limpias, con `codedBands` siempre dentro de rango, es
      // la prueba de que los dos lados siguen viendo la misma cabecera.
      const cabecera = leerCabeceraCelt(paquete.data.subarray(1), lector, LM, channels);
      if (cabecera.silencio) continue;
      expect(cabecera.tfSelect === 0 || cabecera.tfSelect === 1).toBe(true);
      expect(cabecera.codedBands).toBeGreaterThan(0);
      expect(cabecera.codedBands).toBeLessThanOrEqual(NB_BANDS);
    }
  });
});

/** PRNG determinista: el mismo test tiene que dar el mismo número siempre. */
function ruido(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return (s >>> 8) / 8388608 - 1;
  };
}
