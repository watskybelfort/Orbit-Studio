/**
 * Codificador Laplace de la energía.
 *
 * La prueba central es la de siempre en un codificador entrópico —lo que entra
 * sale— pero con un giro que aquí importa mucho: `laplaceEncode` puede recortar
 * el valor cuando la cola se agota, y **lo que tiene que volver es el valor
 * recortado**, no el original. Si el test comparase contra el original y el
 * código devolviera el recortado, parecería un fallo del codificador cuando en
 * realidad es el contrato.
 *
 * Ese recorte es exactamente el sitio donde encoder y decoder pueden acabar con
 * energías distintas si alguien no se queda con el valor devuelto, así que tiene
 * su propio test.
 */

import { describe, expect, it } from 'vitest';
import { RangeDecoder, RangeEncoder } from '../src/render/opus/range-coder';
import { LAPLACE_MINP, LAPLACE_NMIN, laplaceDecode, laplaceEncode } from '../src/render/opus/laplace';
import { E_PROB_MODEL } from '../src/render/opus/tables';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Los parámetros tal y como salen del modelo real: `fs << 7`, `decay << 6`. */
function modelParams(lm: number, intra: number, band: number): [number, number] {
  const model = E_PROB_MODEL[lm]![intra]!;
  return [model[2 * band]! << 7, model[2 * band + 1]! << 6];
}

describe('laplace · ida y vuelta', () => {
  it('los residuos pequeños vuelven exactos con el modelo real', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const intra of [0, 1]) {
        const values: number[] = [];
        const enc = new RangeEncoder(4096);
        for (let band = 0; band < 21; band++) {
          for (const value of [0, 1, -1, 2, -2, 3, -5, 7]) {
            const [fs, decay] = modelParams(lm, intra, band);
            values.push(laplaceEncode(enc, value, fs, decay));
          }
        }
        const dec = new RangeDecoder(enc.done());
        let at = 0;
        for (let band = 0; band < 21; band++) {
          for (let i = 0; i < 8; i++) {
            const [fs, decay] = modelParams(lm, intra, band);
            expect(laplaceDecode(dec, fs, decay), `LM=${lm} intra=${intra} banda=${band}`).toBe(
              values[at++],
            );
          }
        }
      }
    }
  });

  it('una ráfaga larga y aleatoria vuelve exacta', () => {
    const random = rng(11);
    const plan: { value: number; fs: number; decay: number }[] = [];
    const enc = new RangeEncoder(65536);
    for (let i = 0; i < 3000; i++) {
      const lm = Math.floor(random() * 4);
      const intra = random() < 0.5 ? 0 : 1;
      const band = Math.floor(random() * 21);
      const [fs, decay] = modelParams(lm, intra, band);
      // Residuos con forma de Laplace: casi siempre pequeños, a veces grandes.
      const magnitude = Math.floor(-Math.log(1 - random()) * 2);
      // Ojo con el −0: `-0` no es `0` para una comparación estricta.
      const value = magnitude === 0 ? 0 : random() < 0.5 ? magnitude : -magnitude;
      plan.push({ value: laplaceEncode(enc, value, fs, decay), fs, decay });
    }
    expect(enc.busted).toBe(false);
    const dec = new RangeDecoder(enc.done());
    plan.forEach(({ value, fs, decay }, i) => {
      expect(laplaceDecode(dec, fs, decay), `residuo ${i}`).toBe(value);
    });
  });

  it('aguanta residuos absurdamente grandes recortándolos, no reventando', () => {
    // Un valor así no puede salir de audio real, pero si saliera, el
    // codificador tiene que devolver algo codificable en vez de romperse.
    for (const value of [100, -100, 1000, -1000, 32767, -32767]) {
      const [fs, decay] = modelParams(3, 0, 0);
      const enc = new RangeEncoder(256);
      const written = laplaceEncode(enc, value, fs, decay);
      const dec = new RangeDecoder(enc.done());
      expect(laplaceDecode(dec, fs, decay), `valor ${value}`).toBe(written);
      // El recorte conserva el signo: subir de energía no puede convertirse en
      // bajar de energía.
      expect(Math.sign(written), `signo de ${value}`).toBe(Math.sign(value));
      expect(Math.abs(written)).toBeLessThanOrEqual(Math.abs(value));
    }
  });

  it('lo que devuelve es lo que se escribió, no lo que se pidió', () => {
    // El contrato del módulo, en un test. Si esto se ignorara, el decodificador
    // reconstruiría otra energía y todas las bandas siguientes irían torcidas.
    const [fs, decay] = modelParams(0, 0, 0);
    const enc = new RangeEncoder(256);
    const written = laplaceEncode(enc, 5000, fs, decay);
    expect(written).not.toBe(5000);
    const dec = new RangeDecoder(enc.done());
    expect(laplaceDecode(dec, fs, decay)).toBe(written);
  });
});

describe('laplace · el modelo hace su trabajo', () => {
  it('el cero es lo más barato… en casi todas las bandas', () => {
    // Y el "casi" no es un fallo: es el modelo. En la banda más grave a 20 ms,
    // `fs0` (probabilidad del cero) vale 5376 mientras que la del ±1 vale 7214,
    // o sea que un residuo de ±1 es MÁS probable que repetir energía exacta.
    // Tiene sentido: en la banda de 0-200 Hz de una trama larga, la energía casi
    // nunca cae justo en el mismo escalón de 1 dB que la trama anterior.
    //
    // Si esto se diera por sentado y se "arreglara", se estaría rompiendo el
    // modelo para que cuadre con la intuición.
    const cost = (lm: number, band: number, value: number): number => {
      const [fs, decay] = modelParams(lm, 0, band);
      const enc = new RangeEncoder(2048);
      for (let i = 0; i < 50; i++) laplaceEncode(enc, value, fs, decay);
      return enc.tell();
    };
    const zeroFreq = (lm: number, band: number): number => modelParams(lm, 0, band)[0];
    const oneFreq = (lm: number, band: number): number => {
      const [fs, decay] = modelParams(lm, 0, band);
      return ((32768 - 32 - fs) * (16384 - decay)) >> 15;
    };

    let conCero = 0;
    for (let lm = 0; lm < 4; lm++) {
      for (let band = 0; band < 21; band++) {
        if (zeroFreq(lm, band) > oneFreq(lm, band)) {
          expect(cost(lm, band, 0), `LM=${lm} banda=${band}`).toBeLessThan(cost(lm, band, 1));
          conCero++;
        }
      }
    }
    // La mayoría de bandas sí prefieren el cero: si esto bajara mucho, el modelo
    // habría dejado de ser el de CELT.
    expect(conCero).toBeGreaterThan(60);

    // El caso curioso, fijado explícitamente para que no se "corrija" solo.
    expect(zeroFreq(3, 0)).toBeLessThan(oneFreq(3, 0));
    expect(cost(3, 0, 1)).toBeLessThan(cost(3, 0, 0));
  });

  it('a partir de ±1, más magnitud nunca cuesta menos', () => {
    // "Nunca menos" y no "siempre más", y la diferencia es el diseño: pasado el
    // tramo que decae, TODOS los valores comparten la probabilidad mínima y
    // cuestan exactamente lo mismo. Esa meseta es justo lo que garantiza que
    // cualquier residuo se pueda codificar por raro que sea.
    for (let lm = 0; lm < 4; lm++) {
      for (const band of [0, 5, 12, 20]) {
        const [fs, decay] = modelParams(lm, 0, band);
        let previous = 0;
        for (const value of [1, 2, 3, 5, 9]) {
          const enc = new RangeEncoder(2048);
          for (let i = 0; i < 30; i++) laplaceEncode(enc, value, fs, decay);
          const now = enc.tell();
          expect(now, `LM=${lm} banda=${band} valor=${value}`).toBeGreaterThanOrEqual(previous);
          previous = now;
        }
      }
    }
  });

  it('la meseta de la cola existe: valores lejanos cuestan lo mismo', () => {
    // Y aquí se comprueba de frente, porque es la propiedad que sostiene el
    // recorte: si la cola no fuera plana, los residuos grandes crecerían en
    // coste sin límite y no habría dónde meterlos.
    const [fs, decay] = modelParams(0, 0, 20);
    const cost = (value: number): number => {
      const enc = new RangeEncoder(2048);
      for (let i = 0; i < 30; i++) laplaceEncode(enc, value, fs, decay);
      return enc.tell();
    };
    expect(cost(20)).toBe(cost(30));
    expect(cost(30)).toBe(cost(40));
  });

  it('predecir bien sale más barato que no predecir', () => {
    // Con el modelo inter, 21 bandas sin cambios caben en muy pocos bits; con el
    // intra, las mismas 21 bandas cuestan bastante más. Ahí está, medido, por
    // qué las tramas intra son las caras.
    const cost = (intra: number): number => {
      const enc = new RangeEncoder(1024);
      for (let band = 0; band < 21; band++) {
        const [fs, decay] = modelParams(3, intra, band);
        laplaceEncode(enc, 0, fs, decay);
      }
      return enc.tell();
    };
    expect(cost(0)).toBeLessThan(cost(1));
  });

  it('las constantes del modelo son las de la referencia', () => {
    expect(LAPLACE_MINP).toBe(1);
    expect(LAPLACE_NMIN).toBe(16);
  });
});
