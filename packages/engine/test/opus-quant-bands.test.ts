/**
 * Cuantización de todas las bandas.
 *
 * Aquí sólo hay un test que importe, y es demoledor cuando falla: se codifica
 * una trama entera y se decodifica con la **misma función**, y el espectro
 * reconstruido tiene que salir idéntico bit a bit.
 *
 * Es tan fuerte porque `quantBand` es literalmente el mismo código con
 * `encode` a `true` o a `false`. Si una sola rama leyera algo distinto de lo que
 * escribió —una partición, un ángulo, un bit de signo, la semilla del ruido de
 * relleno— los dos espectros divergerían. Y como el range coder va en lockstep,
 * una divergencia no se queda en su banda: arrasa con todo lo que viene detrás.
 *
 * Por eso se barre a conciencia: mono y estéreo, los cuatro tamaños de trama,
 * bitrates desde "casi nada" hasta "de sobra", bloques cortos y largos, y las
 * resoluciones tiempo/frecuencia en los dos sentidos.
 */

import { describe, expect, it } from 'vitest';
import { computeAllocation } from '../src/render/opus/allocation';
import { computeBandEnergies, normaliseBands } from '../src/render/opus/bands';
import { quantAllBands, type QuantContext } from '../src/render/opus/quant-bands';
import { RangeDecoder, RangeEncoder } from '../src/render/opus/range-coder';
import { OPUS_EBANDS, computeLogN, initCaps, opusPulseCache } from '../src/render/opus/rate';
import { BITRES, NB_BANDS } from '../src/render/opus/tables';
import { SPREAD_NORMAL } from '../src/render/opus/vq';

const cache = opusPulseCache();
const logN = computeLogN(OPUS_EBANDS);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}

interface Scenario {
  lm: number;
  channels: number;
  bytes: number;
  seed: number;
  shortBlocks?: boolean;
  tf?: number;
  spread?: number;
  dualStereo?: number;
  intensity?: number;
}

/**
 * Codifica una trama y la vuelve a decodificar, devolviendo los dos espectros.
 *
 * El decodificador arranca del silencio y sólo dispone del paquete: si acaba con
 * lo mismo que el codificador, es que todo lo que hacía falta viajó dentro.
 */
function roundTrip(scenario: Scenario): {
  encoded: Float64Array;
  decoded: Float64Array;
  masksEnc: Uint8Array;
  masksDec: Uint8Array;
} {
  const {
    lm,
    channels,
    bytes,
    seed,
    shortBlocks = false,
    tf = 0,
    spread = SPREAD_NORMAL,
    dualStereo = 0,
    intensity = NB_BANDS,
  } = scenario;
  const m = 1 << lm;
  const frame = m * 120;
  const totalBits = bytes * 8 * (1 << BITRES);

  // Espectro de prueba con forma de música: energía que cae hacia los agudos.
  const random = rng(seed);
  const coeffs = new Float64Array(frame * channels);
  for (let c = 0; c < channels; c++) {
    for (let i = 0; i < frame; i++) {
      coeffs[i + c * frame] = random() * Math.exp(-i / (frame / 5));
    }
  }
  const bandE = computeBandEnergies(coeffs, OPUS_EBANDS, NB_BANDS, NB_BANDS, channels, frame, m);
  const shape = normaliseBands(coeffs, bandE, OPUS_EBANDS, NB_BANDS, NB_BANDS, channels, frame, m);

  const tfRes = new Int32Array(NB_BANDS).fill(tf);
  const allocInput = {
    ebands: OPUS_EBANDS,
    start: 0,
    end: NB_BANDS,
    offsets: new Int32Array(NB_BANDS),
    cap: initCaps(cache, OPUS_EBANDS, lm, channels),
    allocTrim: 5,
    total: totalBits,
    channels,
    lm,
    intensity,
    dualStereo,
    prev: NB_BANDS,
  };

  const base: Omit<QuantContext, 'remainingBits' | 'seed' | 'spread' | 'intensity' | 'bandE'> = {
    encode: true,
    enc: null,
    dec: null,
    ebands: OPUS_EBANDS,
    bands: NB_BANDS,
    cache,
    logN,
  };

  // ── Codificar ──────────────────────────────────────────────────────────────
  const enc = new RangeEncoder(bytes);
  const allocEnc = computeAllocation(allocInput, { encode: true, enc });
  const encoded = Float64Array.from(shape);
  const masksEnc = new Uint8Array(NB_BANDS * channels);
  quantAllBands(
    { ...base, encode: true, enc, dec: null },
    {
      x: encoded,
      y: channels === 2 ? encoded.subarray(frame) : null,
      collapseMasks: masksEnc,
      bandE,
      pulses: allocEnc.pulses,
      shortBlocks,
      spread,
      dualStereo: allocEnc.dualStereo,
      intensity: allocEnc.intensity,
      tfRes,
      totalBits,
      balance: allocEnc.balance,
      lm,
      codedBands: allocEnc.codedBands,
      start: 0,
      end: NB_BANDS,
      seed: 0,
    },
  );

  // ── Decodificar ────────────────────────────────────────────────────────────
  const dec = new RangeDecoder(enc.done());
  const allocDec = computeAllocation(allocInput, { encode: false, dec });
  const decoded = new Float64Array(frame * channels);
  const masksDec = new Uint8Array(NB_BANDS * channels);
  quantAllBands(
    { ...base, encode: false, enc: null, dec },
    {
      x: decoded,
      y: channels === 2 ? decoded.subarray(frame) : null,
      collapseMasks: masksDec,
      bandE,
      pulses: allocDec.pulses,
      shortBlocks,
      spread,
      dualStereo: allocDec.dualStereo,
      intensity: allocDec.intensity,
      tfRes,
      totalBits,
      balance: allocDec.balance,
      lm,
      codedBands: allocDec.codedBands,
      start: 0,
      end: NB_BANDS,
      seed: 0,
    },
  );

  return { encoded, decoded, masksEnc, masksDec };
}

function expectSameSpectrum(label: string, scenario: Scenario): void {
  const { encoded, decoded, masksEnc, masksDec } = roundTrip(scenario);
  expect(Array.from(masksDec), `${label}: máscaras de colapso`).toEqual(Array.from(masksEnc));
  const coded = (1 << scenario.lm) * 100;
  for (let c = 0; c < scenario.channels; c++) {
    const frame = (1 << scenario.lm) * 120;
    for (let j = 0; j < coded; j++) {
      const at = j + c * frame;
      expect(decoded[at], `${label}: canal ${c}, coeficiente ${j}`).toBeCloseTo(encoded[at]!, 10);
    }
  }
}

describe('bandas · el decodificador reconstruye lo mismo', () => {
  it('mono, en todos los tamaños de trama y bitrates', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const bytes of [8, 16, 40, 80, 160, 400]) {
        expectSameSpectrum(`mono LM=${lm} ${bytes}B`, { lm, channels: 1, bytes, seed: lm * 31 + bytes });
      }
    }
  });

  it('estéreo, que además lleva ángulo y parámetros propios', () => {
    for (let lm = 0; lm < 4; lm++) {
      for (const bytes of [16, 40, 100, 250, 600]) {
        expectSameSpectrum(`estéreo LM=${lm} ${bytes}B`, {
          lm,
          channels: 2,
          bytes,
          seed: lm * 17 + bytes,
        });
      }
    }
  });

  it('con bloques cortos, que es como se codifica un transitorio', () => {
    for (let lm = 1; lm < 4; lm++) {
      for (const channels of [1, 2]) {
        expectSameSpectrum(`cortos LM=${lm} ${channels}ch`, {
          lm,
          channels,
          bytes: 120,
          seed: lm * 7 + channels,
          shortBlocks: true,
        });
      }
    }
  });

  it('cambiando la resolución tiempo/frecuencia en los dos sentidos', () => {
    // `tf` negativo divide en el tiempo (más resolución temporal) y positivo
    // recombina (más resolución en frecuencia). Las dos ramas mueven las
    // muestras de sitio con Haar y Hadamard, así que son las más fáciles de
    // desalinear.
    //
    // Ojo con la combinación que se prueba: recombinar exige tener sub-bloques
    // que juntar, y `TF_SELECT_TABLE` sólo da valores positivos en tramas de
    // bloques cortos. Un `tf` positivo con bloques largos no es un caso duro,
    // es una entrada que el formato no produce.
    for (const tf of [-2, -1]) {
      for (const shortBlocks of [false, true]) {
        expectSameSpectrum(`tf=${tf} cortos=${shortBlocks}`, {
          lm: 3,
          channels: 1,
          bytes: 120,
          seed: 500 + tf,
          shortBlocks,
          tf,
        });
      }
    }
    for (const tf of [1, 2, 3]) {
      expectSameSpectrum(`tf=${tf} cortos`, {
        lm: 3,
        channels: 1,
        bytes: 120,
        seed: 600 + tf,
        shortBlocks: true,
        tf,
      });
    }
  });

  it('recombinar más de lo que hay protesta en vez de colgarse', () => {
    // Éste salió de un cuelgue de verdad: con `blocks` a cero, el cálculo del
    // paso de la rotación no termina nunca. Un bucle infinito no te dice nada;
    // un error te dice qué entrada era imposible.
    expect(() =>
      roundTrip({ lm: 3, channels: 1, bytes: 120, seed: 1, shortBlocks: false, tf: 1 }),
    ).toThrow(/bloques cortos/);
  });

  it('con estéreo dual y con intensidad', () => {
    for (const intensity of [0, 4, 10, NB_BANDS]) {
      expectSameSpectrum(`intensidad=${intensity}`, {
        lm: 3,
        channels: 2,
        bytes: 150,
        seed: 900 + intensity,
        intensity,
      });
      expectSameSpectrum(`dual intensidad=${intensity}`, {
        lm: 3,
        channels: 2,
        bytes: 150,
        seed: 950 + intensity,
        intensity,
        dualStereo: 1,
      });
    }
  });

  it('con todos los modos de dispersión', () => {
    for (const spread of [0, 1, 2, 3]) {
      expectSameSpectrum(`spread=${spread}`, {
        lm: 3,
        channels: 2,
        bytes: 100,
        seed: 700 + spread,
        spread,
      });
    }
  });

  it('con el paquete casi vacío, que es donde entra el relleno', () => {
    // Con tan pocos bits, casi ninguna banda recibe pulsos: se rellenan con
    // ruido y con espectro plegado. Los dos lados tienen que generar
    // EXACTAMENTE el mismo ruido, porque la semilla se arrastra igual.
    for (const bytes of [3, 5, 8, 12]) {
      for (const channels of [1, 2]) {
        expectSameSpectrum(`hambre ${bytes}B ${channels}ch`, {
          lm: 3,
          channels,
          bytes,
          seed: 300 + bytes,
        });
      }
    }
  });
});

describe('bandas · el resultado tiene sentido', () => {
  it('la forma reconstruida conserva la norma por banda', () => {
    // Cada banda sale con norma ~1: si no, la energía que se transmitió por
    // separado se aplicaría sobre una forma mal escalada.
    //
    // Es "~1" y no "1 exacto" a propósito. En una banda partida, las dos
    // mitades se escalan por `mid` y `side`, que salen del COSENO ENTERO
    // (`bitexactCos`) dividido por 32768. Sus cuadrados suman aproximadamente 1,
    // no exactamente 1 — y esa aproximación es parte del formato, porque es lo
    // que garantiza que los dos lados calculen el mismo escalado. El desvío es
    // de unas pocas cienmilésimas.
    const { decoded } = roundTrip({ lm: 3, channels: 1, bytes: 200, seed: 5 });
    const m = 8;
    for (let band = 0; band < NB_BANDS; band++) {
      let sum = 0;
      for (let j = m * OPUS_EBANDS[band]!; j < m * OPUS_EBANDS[band + 1]!; j++) {
        sum += decoded[j]! * decoded[j]!;
      }
      expect(Math.abs(Math.sqrt(sum) - 1), `banda ${band}`).toBeLessThan(1e-3);
    }
  });

  it('ninguna banda se queda muda, ni con el paquete casi vacío', () => {
    // Es la promesa de CELT: con pocos bits la banda suena imprecisa, no
    // desaparece. Aquí se comprueba de frente.
    const { decoded } = roundTrip({ lm: 3, channels: 1, bytes: 6, seed: 9 });
    const m = 8;
    for (let band = 0; band < NB_BANDS; band++) {
      let sum = 0;
      for (let j = m * OPUS_EBANDS[band]!; j < m * OPUS_EBANDS[band + 1]!; j++) {
        sum += decoded[j]! * decoded[j]!;
      }
      expect(sum, `banda ${band} muda`).toBeGreaterThan(0);
    }
  });

  it('no aparecen NaN ni infinitos en ningún escenario', () => {
    for (const scenario of [
      { lm: 0, channels: 1, bytes: 2, seed: 1 },
      { lm: 3, channels: 2, bytes: 3, seed: 2 },
      { lm: 2, channels: 2, bytes: 800, seed: 3, shortBlocks: true },
    ] as const) {
      const { decoded, encoded } = roundTrip(scenario);
      for (const value of decoded) expect(Number.isFinite(value)).toBe(true);
      for (const value of encoded) expect(Number.isFinite(value)).toBe(true);
    }
  });
});
