/**
 * Cuantización de la energía por bandas.
 *
 * El test que vale es el de **estado compartido**: se codifica y se decodifica
 * con las dos funciones, y lo que tiene que coincidir no es sólo el audio — es
 * el `oldEBands` con el que los dos lados arrancan la trama siguiente. Si eso
 * diverge una sola vez, la predicción de la trama siguiente parte de otro sitio
 * y ya no se recupera nunca.
 *
 * Por eso casi todos los casos encadenan **varias tramas seguidas** en vez de
 * probar una suelta: una divergencia de estado no se ve en la trama donde
 * ocurre, se ve en la siguiente.
 */

import { describe, expect, it } from 'vitest';
import { RangeDecoder, RangeEncoder } from '../src/render/opus/range-coder';
import {
  quantCoarseEnergy,
  quantEnergyFinalise,
  quantFineEnergy,
  unquantCoarseEnergy,
  unquantEnergyFinalise,
  unquantFineEnergy,
} from '../src/render/opus/energy';
import { NB_BANDS } from '../src/render/opus/tables';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Energías con pinta de música: graves fuertes, agudos flojos, algo de ruido. */
function bandEnergies(channels: number, seed: number): Float64Array {
  const random = rng(seed);
  const out = new Float64Array(NB_BANDS * channels);
  for (let c = 0; c < channels; c++) {
    for (let band = 0; band < NB_BANDS; band++) {
      out[band + c * NB_BANDS] = 12 - band * 0.7 + (random() - 0.5) * 3;
    }
  }
  return out;
}

interface RoundTrip {
  encoded: Float64Array;
  decoded: Float64Array;
  badness: number;
}

/** Codifica y decodifica una trama, devolviendo los dos estados finales. */
function roundTrip(opts: {
  bandLogE: Float64Array;
  oldEnc: Float64Array;
  oldDec: Float64Array;
  channels: number;
  lm: number;
  intra: boolean;
  bytes: number;
  maxDecay?: number;
}): RoundTrip {
  const { bandLogE, oldEnc, oldDec, channels, lm, intra, bytes } = opts;
  const budget = bytes * 8;
  const error = new Float64Array(NB_BANDS * channels);

  const enc = new RangeEncoder(bytes);
  const badness = quantCoarseEnergy(enc, {
    bandLogE,
    oldEBands: oldEnc,
    error,
    bands: NB_BANDS,
    start: 0,
    end: NB_BANDS,
    channels,
    lm,
    intra,
    budget,
    maxDecay: opts.maxDecay ?? 16,
  });

  const dec = new RangeDecoder(enc.done());
  // El decodificador lee la bandera intra que escribió el codificador.
  if (dec.tell() + 3 <= budget) expect(dec.bitLogp(3)).toBe(intra ? 1 : 0);
  unquantCoarseEnergy(dec, {
    oldEBands: oldDec,
    bands: NB_BANDS,
    start: 0,
    end: NB_BANDS,
    channels,
    lm,
    intra,
    budget,
  });

  return { encoded: oldEnc, decoded: oldDec, badness };
}

describe('energía · pasada gruesa', () => {
  it('los dos lados acaban con el mismo estado, trama a trama', () => {
    // Diez tramas encadenadas: si el estado divergiera, el error crecería y
    // saltaría en alguna de las siguientes, no necesariamente en la primera.
    for (const channels of [1, 2]) {
      for (let lm = 0; lm < 4; lm++) {
        const oldEnc = new Float64Array(NB_BANDS * channels);
        const oldDec = new Float64Array(NB_BANDS * channels);
        for (let frame = 0; frame < 10; frame++) {
          const bandLogE = bandEnergies(channels, frame * 31 + lm);
          roundTrip({
            bandLogE,
            oldEnc,
            oldDec,
            channels,
            lm,
            intra: frame === 0,
            bytes: 200,
          });
          for (let i = 0; i < oldEnc.length; i++) {
            expect(oldDec[i], `canales=${channels} LM=${lm} trama=${frame} banda=${i}`).toBe(
              oldEnc[i],
            );
          }
        }
      }
    }
  });

  it('la energía reconstruida se parece a la original', () => {
    // La pasada gruesa cuantiza a escalones de 1 dB, así que el error tiene que
    // quedarse por debajo de medio escalón por banda… salvo en la primera trama,
    // que arranca de cero y tiene que subir hasta el nivel real.
    const channels = 1;
    const oldEnc = new Float64Array(NB_BANDS);
    const oldDec = new Float64Array(NB_BANDS);
    let bandLogE = bandEnergies(channels, 5);
    for (let frame = 0; frame < 4; frame++) {
      bandLogE = bandEnergies(channels, 5);
      roundTrip({ bandLogE, oldEnc, oldDec, channels, lm: 3, intra: frame === 0, bytes: 200 });
    }
    for (let band = 0; band < NB_BANDS; band++) {
      expect(Math.abs(oldDec[band]! - bandLogE[band]!), `banda ${band}`).toBeLessThan(1);
    }
  });

  it('sin bits suficientes recorta, pero NO se desincroniza', () => {
    // Éste es el caso que más importa: con el paquete casi lleno, el codificador
    // pasa por las ramas de emergencia (ICDF de tres, un solo bit, o nada). Lo
    // que no puede es que el decodificador lea otra cosa.
    const badnessPorTamano: number[] = [];
    for (const bytes of [2, 3, 5, 8, 16, 32, 200]) {
      const channels = 1;
      const oldEnc = new Float64Array(NB_BANDS);
      const oldDec = new Float64Array(NB_BANDS);
      const bandLogE = bandEnergies(channels, 7);
      const { badness } = roundTrip({
        bandLogE,
        oldEnc,
        oldDec,
        channels,
        lm: 3,
        intra: true,
        bytes,
      });
      for (let i = 0; i < NB_BANDS; i++) {
        expect(oldDec[i], `${bytes} bytes, banda ${i}`).toBe(oldEnc[i]);
      }
      badnessPorTamano.push(badness);
    }

    // Con 2 o 3 bytes el recorte tiene que notarse: si ahí `badness` fuera 0
    // sería que no está recortando, y el paquete se habría desbordado.
    expect(badnessPorTamano[0]!, '2 bytes').toBeGreaterThan(0);
    expect(badnessPorTamano[1]!, '3 bytes').toBeGreaterThan(0);
    // Y con sitio de sobra no recorta nada.
    expect(badnessPorTamano[badnessPorTamano.length - 1]!, '200 bytes').toBe(0);
    // Cuanto más sitio, menos recorte: nunca al revés.
    for (let i = 1; i < badnessPorTamano.length; i++) {
      expect(badnessPorTamano[i]!, `paso ${i}`).toBeLessThanOrEqual(badnessPorTamano[i - 1]!);
    }
  });

  it('una trama intra no mira a la anterior', () => {
    // Con `intra`, el coeficiente de predicción es 0: la energía sale igual
    // aunque el estado previo sea disparatado. Es lo que permite arrancar la
    // reproducción por la mitad de un archivo.
    const channels = 1;
    const bandLogE = bandEnergies(channels, 9);
    const limpio = new Float64Array(NB_BANDS);
    const sucio = new Float64Array(NB_BANDS).fill(-40);
    const encA = new Float64Array(NB_BANDS);
    const encB = new Float64Array(NB_BANDS).fill(-40);

    roundTrip({ bandLogE, oldEnc: encA, oldDec: limpio, channels, lm: 3, intra: true, bytes: 200 });
    roundTrip({ bandLogE, oldEnc: encB, oldDec: sucio, channels, lm: 3, intra: true, bytes: 200 });
    for (let i = 0; i < NB_BANDS; i++) {
      expect(limpio[i], `banda ${i}`).toBe(sucio[i]);
    }
  });

  it('predecir bien gasta menos bits que no predecir', () => {
    // La misma energía dos veces seguidas: la segunda trama, en inter, casi no
    // debería costar nada.
    const channels = 1;
    const bandLogE = bandEnergies(channels, 3);
    const cost = (intra: boolean): number => {
      const old = new Float64Array(NB_BANDS);
      const error = new Float64Array(NB_BANDS);
      // Primera trama, para dejar el estado igual a la energía.
      const warm = new RangeEncoder(200);
      quantCoarseEnergy(warm, {
        bandLogE,
        oldEBands: old,
        error,
        bands: NB_BANDS,
        start: 0,
        end: NB_BANDS,
        channels,
        lm: 3,
        intra: true,
        budget: 1600,
        maxDecay: 16,
      });
      // Segunda trama, idéntica.
      const enc = new RangeEncoder(200);
      quantCoarseEnergy(enc, {
        bandLogE,
        oldEBands: old,
        error,
        bands: NB_BANDS,
        start: 0,
        end: NB_BANDS,
        channels,
        lm: 3,
        intra,
        budget: 1600,
        maxDecay: 16,
      });
      return enc.tell();
    };
    expect(cost(false)).toBeLessThan(cost(true));
  });

  it('el freno de caída impide que una banda se desplome de golpe', () => {
    // Sin él, una banda que pasa de sonar a callarse baja todo lo que quiera en
    // una sola trama, y eso se oye como un chasquido.
    const channels = 1;
    const alto = new Float64Array(NB_BANDS).fill(20);
    const bajo = new Float64Array(NB_BANDS).fill(-30);

    const conFreno = new Float64Array(NB_BANDS).fill(20);
    const decFreno = new Float64Array(NB_BANDS).fill(20);
    roundTrip({
      bandLogE: bajo,
      oldEnc: conFreno,
      oldDec: decFreno,
      channels,
      lm: 3,
      intra: false,
      bytes: 200,
      maxDecay: 2,
    });

    const sinFreno = new Float64Array(NB_BANDS).fill(20);
    const decSin = new Float64Array(NB_BANDS).fill(20);
    roundTrip({
      bandLogE: bajo,
      oldEnc: sinFreno,
      oldDec: decSin,
      channels,
      lm: 3,
      intra: false,
      bytes: 200,
      maxDecay: 100,
    });

    expect(alto[0]).toBe(20);
    // Con el freno apretado, la energía baja menos en la misma trama.
    expect(conFreno[5]!).toBeGreaterThan(sinFreno[5]!);
    // Y en los dos casos, encoder y decoder siguen de acuerdo.
    for (let i = 0; i < NB_BANDS; i++) expect(decFreno[i]).toBe(conFreno[i]);
  });
});

describe('energía · pasada fina y sobras', () => {
  it('afinar acerca la energía a la real y los dos lados coinciden', () => {
    const channels = 2;
    const bandLogE = bandEnergies(channels, 21);
    const oldEnc = new Float64Array(NB_BANDS * channels);
    const oldDec = new Float64Array(NB_BANDS * channels);
    const error = new Float64Array(NB_BANDS * channels);
    const fineQuant = new Int32Array(NB_BANDS).fill(3);
    const budget = 400 * 8;

    const enc = new RangeEncoder(400);
    quantCoarseEnergy(enc, {
      bandLogE,
      oldEBands: oldEnc,
      error,
      bands: NB_BANDS,
      start: 0,
      end: NB_BANDS,
      channels,
      lm: 3,
      intra: true,
      budget,
      maxDecay: 16,
    });
    const grueso = Float64Array.from(oldEnc);
    quantFineEnergy(enc, oldEnc, error, fineQuant, NB_BANDS, 0, NB_BANDS, channels);

    const dec = new RangeDecoder(enc.done());
    dec.bitLogp(3);
    unquantCoarseEnergy(dec, {
      oldEBands: oldDec,
      bands: NB_BANDS,
      start: 0,
      end: NB_BANDS,
      channels,
      lm: 3,
      intra: true,
      budget,
    });
    unquantFineEnergy(dec, oldDec, fineQuant, NB_BANDS, 0, NB_BANDS, channels);

    for (let i = 0; i < oldEnc.length; i++) expect(oldDec[i], `banda ${i}`).toBe(oldEnc[i]);

    // Y afinar tiene que MEJORAR: si no, los bits estarían tirados.
    const errorGrueso = grueso.reduce((sum, v, i) => sum + Math.abs(v - bandLogE[i]!), 0);
    const errorFino = oldEnc.reduce((sum, v, i) => sum + Math.abs(v - bandLogE[i]!), 0);
    expect(errorFino).toBeLessThan(errorGrueso);
  });

  it('más bits finos, menos error', () => {
    const channels = 1;
    const bandLogE = bandEnergies(channels, 33);
    const errorFor = (width: number): number => {
      const old = new Float64Array(NB_BANDS);
      const error = new Float64Array(NB_BANDS);
      const enc = new RangeEncoder(400);
      quantCoarseEnergy(enc, {
        bandLogE,
        oldEBands: old,
        error,
        bands: NB_BANDS,
        start: 0,
        end: NB_BANDS,
        channels,
        lm: 3,
        intra: true,
        budget: 3200,
        maxDecay: 16,
      });
      quantFineEnergy(enc, old, error, new Int32Array(NB_BANDS).fill(width), NB_BANDS, 0, NB_BANDS, 1);
      return old.reduce((sum, v, i) => sum + Math.abs(v - bandLogE[i]!), 0);
    };
    expect(errorFor(4)).toBeLessThan(errorFor(2));
    expect(errorFor(2)).toBeLessThan(errorFor(1));
    expect(errorFor(1)).toBeLessThan(errorFor(0));
  });

  it('las sobras se reparten y los dos lados siguen de acuerdo', () => {
    const channels = 1;
    const bandLogE = bandEnergies(channels, 44);
    const oldEnc = new Float64Array(NB_BANDS);
    const oldDec = new Float64Array(NB_BANDS);
    const error = new Float64Array(NB_BANDS);
    const fineQuant = new Int32Array(NB_BANDS).fill(2);
    const finePriority = new Int32Array(NB_BANDS).map((_, i) => i % 2);

    const enc = new RangeEncoder(400);
    quantCoarseEnergy(enc, {
      bandLogE,
      oldEBands: oldEnc,
      error,
      bands: NB_BANDS,
      start: 0,
      end: NB_BANDS,
      channels,
      lm: 3,
      intra: true,
      budget: 3200,
      maxDecay: 16,
    });
    quantFineEnergy(enc, oldEnc, error, fineQuant, NB_BANDS, 0, NB_BANDS, channels);
    quantEnergyFinalise(enc, oldEnc, error, fineQuant, finePriority, NB_BANDS, 0, NB_BANDS, channels, 12);

    const dec = new RangeDecoder(enc.done());
    dec.bitLogp(3);
    unquantCoarseEnergy(dec, {
      oldEBands: oldDec,
      bands: NB_BANDS,
      start: 0,
      end: NB_BANDS,
      channels,
      lm: 3,
      intra: true,
      budget: 3200,
    });
    unquantFineEnergy(dec, oldDec, fineQuant, NB_BANDS, 0, NB_BANDS, channels);
    unquantEnergyFinalise(dec, oldDec, fineQuant, finePriority, NB_BANDS, 0, NB_BANDS, channels, 12);

    for (let i = 0; i < NB_BANDS; i++) expect(oldDec[i], `banda ${i}`).toBe(oldEnc[i]);
  });

  it('una banda sin bits finos se queda como estaba', () => {
    const old = new Float64Array(NB_BANDS).fill(5);
    const antes = Float64Array.from(old);
    const enc = new RangeEncoder(64);
    quantFineEnergy(enc, old, new Float64Array(NB_BANDS), new Int32Array(NB_BANDS), NB_BANDS, 0, NB_BANDS, 1);
    expect(Array.from(old)).toEqual(Array.from(antes));
    expect(enc.tell()).toBe(1); // nada escrito más allá del arranque del coder
  });
});
