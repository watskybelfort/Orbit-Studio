/**
 * Asignador de bits de CELT.
 *
 * Sólo hay un test que de verdad importa aquí, y es que **el codificador y el
 * decodificador lleguen al mismo reparto, bit a bit**. Casi nada de lo que
 * decide el asignador viaja en el paquete: se recalcula en los dos lados. Si
 * difieren en una sola banda, el decodificador lee un número de pulsos distinto
 * del que se escribió y todo lo que viene detrás sale corrido.
 *
 * Todo lo demás —que reparta bien, que priorice graves, que salte agudos— es
 * secundario en comparación: un reparto "peor" pero idéntico en los dos lados
 * produce un archivo que suena; uno "mejor" pero distinto produce ruido.
 */

import { describe, expect, it } from 'vitest';
import { computeAllocation, type AllocationResult } from '../src/render/opus/allocation';
import { RangeDecoder, RangeEncoder } from '../src/render/opus/range-coder';
import { OPUS_EBANDS, initCaps, opusPulseCache } from '../src/render/opus/rate';
import { BITRES, NB_BANDS } from '../src/render/opus/tables';

const cache = opusPulseCache();

/** Techos de banda tal y como los pasa el códec. */
function caps(lm: number, channels: number): Int32Array {
  return initCaps(cache, OPUS_EBANDS, lm, channels);
}

interface Scenario {
  total: number;
  channels: number;
  lm: number;
  allocTrim?: number;
  offsets?: Int32Array;
  intensity?: number;
  dualStereo?: number;
  prev?: number;
  end?: number;
}

/** Corre el asignador por los dos lados y devuelve ambos resultados. */
function bothSides(scenario: Scenario): { enc: AllocationResult; dec: AllocationResult } {
  const {
    total,
    channels,
    lm,
    allocTrim = 5,
    offsets = new Int32Array(NB_BANDS),
    intensity = NB_BANDS,
    dualStereo = 0,
    prev = NB_BANDS,
    end = NB_BANDS,
  } = scenario;
  const input = {
    ebands: OPUS_EBANDS,
    start: 0,
    end,
    offsets,
    cap: caps(lm, channels),
    allocTrim,
    total,
    channels,
    lm,
    intensity,
    dualStereo,
    prev,
  };

  const encoder = new RangeEncoder(2048);
  const enc = computeAllocation(input, { encode: true, enc: encoder });
  const decoder = new RangeDecoder(encoder.done());
  const dec = computeAllocation(input, { encode: false, dec: decoder });
  return { enc, dec };
}

function expectSameAllocation(a: AllocationResult, b: AllocationResult, label: string): void {
  expect(b.codedBands, `${label}: bandas codificadas`).toBe(a.codedBands);
  expect(b.intensity, `${label}: intensidad`).toBe(a.intensity);
  expect(b.dualStereo, `${label}: estéreo dual`).toBe(a.dualStereo);
  expect(b.balance, `${label}: balance`).toBe(a.balance);
  expect(Array.from(b.pulses), `${label}: pulsos`).toEqual(Array.from(a.pulses));
  expect(Array.from(b.ebits), `${label}: bits finos`).toEqual(Array.from(a.ebits));
  expect(Array.from(b.finePriority), `${label}: prioridad`).toEqual(Array.from(a.finePriority));
}

describe('asignación · los dos lados llegan al mismo sitio', () => {
  it('mono, en todo el rango de bitrates y tamaños de trama', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const bytes of [8, 16, 32, 64, 96, 128, 200, 400, 800]) {
        const { enc, dec } = bothSides({ total: bytes * 8 * (1 << BITRES), channels: 1, lm });
        expectSameAllocation(enc, dec, `mono LM=${lm} ${bytes}B`);
      }
    }
  });

  it('estéreo, que es donde hay parámetros que sí viajan', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const bytes of [16, 32, 64, 128, 250, 500]) {
        for (const intensity of [0, 5, 12, NB_BANDS]) {
          const { enc, dec } = bothSides({
            total: bytes * 8 * (1 << BITRES),
            channels: 2,
            lm,
            intensity,
          });
          expectSameAllocation(enc, dec, `estéreo LM=${lm} ${bytes}B int=${intensity}`);
        }
      }
    }
  });

  it('con la inclinación en todos sus valores', () => {
    // `allocTrim` va de 0 a 10 y mueve el reparto entre graves y agudos.
    for (let trim = 0; trim <= 10; trim++) {
      const { enc, dec } = bothSides({ total: 64 * 8 * 8, channels: 2, lm: 3, allocTrim: trim });
      expectSameAllocation(enc, dec, `trim=${trim}`);
    }
  });

  it('con bits pedidos a mano en bandas sueltas (dynalloc)', () => {
    for (const band of [0, 3, 10, 18]) {
      const offsets = new Int32Array(NB_BANDS);
      offsets[band] = 200;
      const { enc, dec } = bothSides({ total: 64 * 8 * 8, channels: 1, lm: 3, offsets });
      expectSameAllocation(enc, dec, `dynalloc en ${band}`);
    }
  });

  it('con la histéresis del salto en marcha', () => {
    // `prev` cambia el umbral de salto: es la única entrada que viene de la
    // trama anterior, y si los dos lados no la tuvieran igual, divergirían.
    for (const prev of [0, 5, 12, NB_BANDS]) {
      const { enc, dec } = bothSides({ total: 40 * 8 * 8, channels: 1, lm: 3, prev });
      expectSameAllocation(enc, dec, `prev=${prev}`);
    }
  });

  it('con presupuestos absurdos por arriba y por abajo', () => {
    for (const total of [0, 1, 8, 40, 100000]) {
      for (const channels of [1, 2]) {
        const { enc, dec } = bothSides({ total, channels, lm: 3 });
        expectSameAllocation(enc, dec, `total=${total} canales=${channels}`);
      }
    }
  });

  it('con la banda final recortada', () => {
    for (const end of [5, 10, 17, NB_BANDS]) {
      const { enc, dec } = bothSides({ total: 64 * 8 * 8, channels: 2, lm: 3, end });
      expectSameAllocation(enc, dec, `end=${end}`);
    }
  });
});

describe('asignación · el reparto tiene sentido', () => {
  it('nunca reparte más de lo que hay', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const bytes of [16, 64, 200]) {
        for (const channels of [1, 2]) {
          const total = bytes * 8 * (1 << BITRES);
          const { enc } = bothSides({ total, channels, lm });
          let spent = 0;
          for (let band = 0; band < NB_BANDS; band++) {
            spent += enc.pulses[band]! + ((channels * enc.ebits[band]!) << BITRES);
          }
          expect(spent, `LM=${lm} ${bytes}B ${channels}ch`).toBeLessThanOrEqual(total);
        }
      }
    }
  });

  it('con más presupuesto, más bandas codificadas', () => {
    let previous = 0;
    for (const bytes of [4, 8, 16, 32, 64, 128, 400]) {
      const { enc } = bothSides({ total: bytes * 8 * 8, channels: 1, lm: 3 });
      expect(enc.codedBands, `${bytes}B`).toBeGreaterThanOrEqual(previous);
      previous = enc.codedBands;
    }
    expect(previous).toBe(NB_BANDS);
  });

  it('a bitrate bajo se saltan las bandas agudas, no las graves', () => {
    // Es la decisión correcta psicoacústicamente, y se comprueba porque un
    // asignador que saltara al revés seguiría siendo "coherente" pero sonaría
    // fatal.
    const { enc } = bothSides({ total: 6 * 8 * 8, channels: 1, lm: 3 });
    expect(enc.codedBands).toBeLessThan(NB_BANDS);
    expect(enc.pulses[0]!).toBeGreaterThanOrEqual(enc.pulses[NB_BANDS - 1]!);
  });

  it('la inclinación mueve los bits entre graves y agudos', () => {
    const agudos = bothSides({ total: 64 * 8 * 8, channels: 1, lm: 3, allocTrim: 10 }).enc;
    const graves = bothSides({ total: 64 * 8 * 8, channels: 1, lm: 3, allocTrim: 0 }).enc;
    const suma = (r: AllocationResult, from: number, to: number): number => {
      let out = 0;
      for (let i = from; i < to; i++) out += r.pulses[i]!;
      return out;
    };
    // Trim alto empuja hacia los graves; trim bajo, hacia los agudos.
    expect(suma(graves, 15, NB_BANDS)).toBeGreaterThan(suma(agudos, 15, NB_BANDS));
  });

  it('pedir bits a mano en una banda le da más que a sus vecinas', () => {
    const offsets = new Int32Array(NB_BANDS);
    offsets[12] = 400;
    const con = bothSides({ total: 48 * 8 * 8, channels: 1, lm: 3, offsets }).enc;
    const sin = bothSides({ total: 48 * 8 * 8, channels: 1, lm: 3 }).enc;
    expect(con.pulses[12]!).toBeGreaterThan(sin.pulses[12]!);
  });

  it('los bits finos no pasan del tope', () => {
    for (const bytes of [16, 64, 200, 800]) {
      const { enc } = bothSides({ total: bytes * 8 * 8, channels: 2, lm: 3 });
      for (let band = 0; band < NB_BANDS; band++) {
        expect(enc.ebits[band]!, `banda ${band}`).toBeGreaterThanOrEqual(0);
        expect(enc.ebits[band]!, `banda ${band}`).toBeLessThanOrEqual(8);
      }
    }
  });

  it('nada sale negativo', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const total of [0, 64, 640, 6400, 64000]) {
        for (const channels of [1, 2]) {
          const { enc } = bothSides({ total, channels, lm });
          for (let band = 0; band < NB_BANDS; band++) {
            expect(enc.pulses[band]!, `pulsos LM=${lm} total=${total}`).toBeGreaterThanOrEqual(0);
            expect(enc.ebits[band]!, `finos LM=${lm} total=${total}`).toBeGreaterThanOrEqual(0);
          }
          expect(enc.codedBands).toBeGreaterThan(0);
        }
      }
    }
  });
});
