/**
 * El VBR por trama: mover el presupuesto, no gastar menos.
 *
 * Cuatro cosas, y las dos últimas son las que de verdad hay que probar:
 *
 * 1. **El plan hace lo que dice**: una trama tapada por lo que acaba de sonar
 *    recibe menos, una trama de silencio digital recibe el mínimo, y una señal
 *    estacionaria sale con el reparto plano de siempre.
 * 2. **La suma no crece.** Es lo que separa esto de subir el bitrate por la
 *    puerta de atrás: el archivo mide lo mismo que en plano —clavado— mientras
 *    el techo por trama no se meta, y cuando se mete es porque hay tanto
 *    silencio que lo liberado no cabe, así que sale MÁS pequeño. Nunca más
 *    grande. Si esta prueba se cae, todas las medidas del banco contra libopus
 *    dejan de significar algo, porque ya no serían al mismo bitrate.
 * 3. **Los topes se respetan** aunque la señal sea rara: nada por debajo del
 *    suelo ni por encima del techo, y nunca menos del mínimo del formato.
 * 4. **Que cambiar el tamaño de la trama NO descoloca el paquete.** Ésta es la
 *    de verdad. Un paquete de Opus no lleva su longitud dentro, así que las
 *    condiciones de «esto cabe» que deciden qué símbolos se transmiten se
 *    calculan sobre la longitud del paquete — y si el codificador y el
 *    decodificador no la vieran igual, cada trama tendría un presupuesto
 *    distinto en cada lado y el archivo se leería corrido sin que saltara ningún
 *    error. Se comprueba releyendo cada paquete con el `RangeDecoder`,
 *    recorriendo la cabecera entera en el orden del formato.
 */

import { describe, expect, it } from 'vitest';
import { encodeOpusPackets } from '../src/render/opus/encoder';
import { NB_BANDS } from '../src/render/opus/tables';
import { SUELO, TECHO, vbrDemandas, vbrPlan } from '../src/render/opus/vbr';
import { crearEstadoLector, leerCabeceraCelt } from '../../../tools/qa/opus-celt-header';

const SR = 48000;
const N = 960;

/** Tono constante: nada que repartir. */
function estacionaria(tramas: number, channels: number): Float64Array {
  const n = tramas * N;
  const out = new Float64Array(n * channels);
  for (let i = 0; i < n; i++) {
    const v = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

/**
 * Golpes con silencio DIGITAL en medio: lo que sale de un DAW cuando hay
 * compases vacíos.
 */
function golpes(tramas: number, channels: number): Float64Array {
  const n = tramas * N;
  const out = new Float64Array(n * channels);
  for (let t = 0; t < tramas; t++) {
    // Un golpe cada cuatro tramas; las otras tres, cero absoluto.
    if (t % 4 !== 0) continue;
    for (let i = 0; i < N; i++) {
      const env = Math.exp(-i / (SR * 0.004));
      const v = 0.6 * Math.sin((2 * Math.PI * 90 * i) / SR) * env;
      for (let c = 0; c < channels; c++) out[(t * N + i) * channels + c] = v;
    }
  }
  return out;
}

/** Un golpe seguido de una cola larga que decae: sombra sin silencio digital. */
function cola(tramas: number, channels: number): Float64Array {
  const n = tramas * N;
  const out = new Float64Array(n * channels);
  for (let i = 0; i < n; i++) {
    const v = 0.6 * Math.sin((2 * Math.PI * 180 * i) / SR) * Math.exp(-i / (SR * 0.08));
    for (let c = 0; c < channels; c++) out[i * channels + c] = v;
  }
  return out;
}

describe('lo que pide cada trama', () => {
  it('una señal estacionaria pide lo mismo en todas', () => {
    const d = vbrDemandas(estacionaria(20, 1), N, 1);
    expect(d).toHaveLength(20);
    for (const t of d) {
      expect(t.muda).toBe(false);
      expect(t.sombra).toBeLessThan(0.5);
      expect(t.peso).toBeCloseTo(1, 2);
    }
  });

  it('una cola que decae va cayendo en sombra', () => {
    const d = vbrDemandas(cola(20, 1), N, 1);
    // La primera no está en sombra —es la que pone el listón— y a partir de ahí
    // la señal baja más deprisa de lo que baja el enmascarador.
    expect(d[0]!.sombra).toBe(0);
    expect(d[5]!.sombra).toBeGreaterThan(d[1]!.sombra);
    expect(d[19]!.sombra).toBeGreaterThan(d[5]!.sombra);
    expect(d[19]!.peso).toBeLessThan(d[0]!.peso);
  });

  it('el silencio digital se marca trama a trama', () => {
    const d = vbrDemandas(golpes(12, 1), N, 1);
    for (let t = 0; t < 12; t++) expect(d[t]!.muda).toBe(t % 4 !== 0);
  });
});

describe('el plan', () => {
  const casos = [
    { nombre: 'estacionaria', hacer: estacionaria },
    { nombre: 'golpes', hacer: golpes },
    { nombre: 'cola', hacer: cola },
  ];

  it('nunca suma más que el reparto plano', () => {
    for (const caso of casos) {
      for (const channels of [1, 2]) {
        for (const base of [40, 79, 159, 239, 319]) {
          const tramas = 30;
          const plan = vbrPlan(caso.hacer(tramas, channels), N, channels, base, 2);
          let suma = 0;
          for (const v of plan) suma += v;
          expect(suma, `${caso.nombre} ${channels}ch base=${base}`).toBeLessThanOrEqual(
            base * tramas,
          );
        }
      }
    }
  });

  it('y suma EXACTAMENTE lo mismo mientras el techo no se meta', () => {
    // Sin tramas mudas no hay presupuesto que sobre, así que el reparto es una
    // permutación del plano y la suma tiene que caer clavada. Es la propiedad
    // que hace que la comparación con libopus siga siendo al mismo bitrate.
    for (const caso of [casos[0]!, casos[2]!]) {
      for (const channels of [1, 2]) {
        for (const base of [40, 79, 159, 239, 319]) {
          const tramas = 30;
          const plan = vbrPlan(caso.hacer(tramas, channels), N, channels, base, 2);
          let suma = 0;
          for (const v of plan) suma += v;
          expect(suma, `${caso.nombre} ${channels}ch base=${base}`).toBe(base * tramas);
        }
      }
    }
  });

  it('con muchos compases vacíos el archivo ADEMÁS encoge', () => {
    // Tres de cada cuatro tramas mudas liberan tanto que las que quedan chocan
    // con el techo. Lo que sobra no se gasta: el archivo sale más pequeño, que
    // es lo correcto —nadie quiere pagar por silencio— pero es un resultado
    // distinto de repartir, y conviene que esté escrito.
    const plan = vbrPlan(golpes(20, 1), N, 1, 159, 2);
    let suma = 0;
    for (const v of plan) suma += v;
    expect(suma).toBeLessThan(159 * 20);
    for (let t = 0; t < 20; t += 4) expect(plan[t]!).toBe(Math.ceil(TECHO * 159));
  });

  it('respeta el suelo, el techo y el mínimo del formato', () => {
    for (const caso of casos) {
      const base = 159;
      const pcm = caso.hacer(30, 2);
      const plan = vbrPlan(pcm, N, 2, base, 2);
      const demandas = vbrDemandas(pcm, N, 2);
      for (let i = 0; i < plan.length; i++) {
        if (demandas[i]!.muda) {
          expect(plan[i]).toBe(2);
        } else {
          expect(plan[i]).toBeGreaterThanOrEqual(Math.floor(SUELO * base));
          expect(plan[i]).toBeLessThanOrEqual(Math.ceil(TECHO * base));
        }
      }
    }
  });

  it('en estacionario reparte plano', () => {
    const plan = vbrPlan(estacionaria(30, 1), N, 1, 159, 2);
    for (const v of plan) expect(Math.abs(v - 159)).toBeLessThanOrEqual(1);
  });

  it('la cola recibe menos que el golpe, y el golpe más que en plano', () => {
    const plan = vbrPlan(cola(30, 1), N, 1, 159, 2);
    expect(plan[0]!).toBeGreaterThan(159);
    expect(plan[29]!).toBeLessThan(plan[0]!);
  });

  it('los compases vacíos liberan su presupuesto para los golpes', () => {
    const plan = vbrPlan(golpes(20, 1), N, 1, 159, 2);
    for (let t = 0; t < 20; t++) {
      if (t % 4 === 0) expect(plan[t]!).toBeGreaterThan(159);
      else expect(plan[t]!).toBe(2);
    }
  });
});

describe('cambiar el tamaño de la trama no descoloca el paquete', () => {
  /**
   * Codifica y relee TODAS las tramas con el lector de rango, arrastrando el
   * estado como lo arrastra un decodificador.
   *
   * Si los dos lados no vieran el mismo `totalBits`, las condiciones de «esto
   * cabe» darían distinto y lo leído aquí saldría corrido: `codedBands` fuera de
   * rango, la inclinación fuera de su alfabeto o la intensidad por encima de las
   * bandas codificadas.
   */
  function releer(
    pcm: Float64Array,
    channels: number,
    bitrate: number,
    vbr: 'adaptive' | 'off',
  ): { bytes: number; cabecera: ReturnType<typeof leerCabeceraCelt> }[] {
    const paquetes = encodeOpusPackets(pcm, { channels, bitrate, frameSize: N, vbr });
    const lector = crearEstadoLector(channels);
    return paquetes.map((p) => ({
      bytes: p.data.length,
      cabecera: leerCabeceraCelt(p.data.subarray(1), lector, 3, channels),
    }));
  }

  it('con VBR las tramas miden distinto y todas se leen coherentes', () => {
    for (const channels of [1, 2]) {
      for (const bitrate of [64000, 128000]) {
        const leidas = releer(golpes(24, channels), channels, bitrate, 'adaptive');
        const tamaños = new Set(leidas.map((l) => l.bytes));
        expect(tamaños.size, `${channels}ch ${bitrate}`).toBeGreaterThan(1);
        for (const { cabecera } of leidas) {
          if (cabecera.silencio) continue;
          expect(cabecera.codedBands).toBeGreaterThan(0);
          expect(cabecera.codedBands).toBeLessThanOrEqual(NB_BANDS);
          expect(cabecera.inclinacion).toBeGreaterThanOrEqual(0);
          expect(cabecera.inclinacion).toBeLessThanOrEqual(10);
          expect(cabecera.intensity).toBeLessThanOrEqual(cabecera.codedBands);
        }
      }
    }
  });

  it('los compases vacíos salen marcados como silencio y ocupan 3 bytes', () => {
    const leidas = releer(golpes(24, 1), 1, 64000, 'adaptive');
    for (let t = 0; t < 24; t++) {
      if (t % 4 === 0) continue;
      // 2 de trama CELT más el byte TOC de Opus.
      expect(leidas[t]!.bytes).toBe(3);
      expect(leidas[t]!.cabecera.silencio).toBe(true);
    }
  });

  it("con vbr='off' todas las tramas miden igual", () => {
    const leidas = releer(golpes(24, 2), 2, 96000, 'off');
    expect(new Set(leidas.map((l) => l.bytes)).size).toBe(1);
  });

  it('el archivo entero mide lo mismo con VBR y sin él', () => {
    for (const channels of [1, 2]) {
      for (const bitrate of [32000, 64000, 128000]) {
        const pcm = cola(30, channels);
        const suma = (vbr: 'adaptive' | 'off'): number =>
          encodeOpusPackets(pcm, { channels, bitrate, frameSize: N, vbr }).reduce(
            (s, p) => s + p.data.length,
            0,
          );
        expect(suma('adaptive'), `${channels}ch ${bitrate}`).toBe(suma('off'));
      }
    }
  });
});
