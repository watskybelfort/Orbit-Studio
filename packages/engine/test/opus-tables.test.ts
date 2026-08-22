/**
 * Tablas de CELT.
 *
 * Aquí no se está probando lógica: se está probando que **696 números siguen
 * siendo los que son**. El archivo lo genera `tools/opus-tables.ts` desde la
 * implementación de referencia, y esto es la red por si alguien lo edita a mano,
 * lo reformatea con una herramienta que se coma un dígito, o el extractor cambia
 * y deja de sacar lo mismo.
 *
 * Dos capas:
 *
 * 1. **Invariantes estructurales.** Cosas que tienen que ser verdad por lo que
 *    la tabla ES: los bordes de banda suben, las ICDF bajan hasta cero, la
 *    calidad crece fila a fila. Una tabla corrupta casi siempre rompe una.
 * 2. **Firma por suma y longitud**, tabla por tabla. Cubre lo que se le escapa
 *    a los invariantes — dos cifras intercambiadas, un dígito de menos. Se usa
 *    la suma y no un hash a propósito: si esto falla, el número que sale por
 *    pantalla se puede comparar a ojo con el de la referencia, mientras que un
 *    hash sólo dice "algo ha cambiado".
 */

import { describe, expect, it } from 'vitest';
import {
  BAND_ALLOCATION,
  BETA_COEF,
  BETA_INTRA,
  BITRES,
  EBAND_5MS,
  E_PROB_MODEL,
  FITS32_MAX_K,
  FITS32_MAX_N,
  LOG2_FRAC_TABLE,
  NB_BANDS,
  PRED_COEF,
  SMALL_ENERGY_ICDF,
  SPREAD_ICDF,
  TAPSET_ICDF,
  TF_SELECT_TABLE,
  TRIM_ICDF,
} from '../src/render/opus/tables';

const flat = (value: unknown): number[] =>
  Array.isArray(value) ? value.flatMap(flat) : [value as number];

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

describe('tablas · firma', () => {
  it('cada tabla tiene la longitud y la suma que le tocan', () => {
    // Si una de éstas falla, la tabla no coincide con la referencia. El valor
    // esperado se puede recalcular volviendo a extraer el tarball de la RFC y
    // pasando `tools/opus-tables.ts`.
    const expected: Record<string, [number, number]> = {
      EBAND_5MS: [22, 520],
      BAND_ALLOCATION: [231, 16533],
      E_PROB_MODEL: [336, 28200],
      SMALL_ENERGY_ICDF: [3, 3],
      TRIM_ICDF: [11, 640],
      SPREAD_ICDF: [4, 50],
      TAPSET_ICDF: [3, 3],
      TF_SELECT_TABLE: [32, -11],
      LOG2_FRAC_TABLE: [24, 641],
      FITS32_MAX_N: [15, 100403],
      FITS32_MAX_K: [15, 132773],
    };
    const tables: Record<string, unknown> = {
      EBAND_5MS,
      BAND_ALLOCATION,
      E_PROB_MODEL,
      SMALL_ENERGY_ICDF,
      TRIM_ICDF,
      SPREAD_ICDF,
      TAPSET_ICDF,
      TF_SELECT_TABLE,
      LOG2_FRAC_TABLE,
      FITS32_MAX_N,
      FITS32_MAX_K,
    };
    for (const [name, [length, total]] of Object.entries(expected)) {
      const values = flat(tables[name]);
      expect(values.length, `${name}: longitud`).toBe(length);
      expect(sum(values), `${name}: suma`).toBe(total);
    }
  });

  it('son 696 números en total, que es lo que se transcribe del formato', () => {
    const all = [
      EBAND_5MS,
      BAND_ALLOCATION,
      E_PROB_MODEL,
      SMALL_ENERGY_ICDF,
      TRIM_ICDF,
      SPREAD_ICDF,
      TAPSET_ICDF,
      TF_SELECT_TABLE,
      LOG2_FRAC_TABLE,
      FITS32_MAX_N,
      FITS32_MAX_K,
    ].flatMap(flat);
    expect(all).toHaveLength(696);
  });
});

describe('tablas · bordes de banda', () => {
  it('son 21 bandas, 22 bordes', () => {
    expect(EBAND_5MS).toHaveLength(NB_BANDS + 1);
    expect(NB_BANDS).toBe(21);
  });

  it('suben siempre y empiezan en 0', () => {
    expect(EBAND_5MS[0]).toBe(0);
    for (let i = 1; i < EBAND_5MS.length; i++) {
      expect(EBAND_5MS[i]!, `borde ${i}`).toBeGreaterThan(EBAND_5MS[i - 1]!);
    }
  });

  it('siguen la escala de Bark: las bandas de arriba son más anchas', () => {
    // Ésta es la razón de ser de la tabla. Abajo, bandas de 200 Hz; arriba, de
    // kilohercios — porque así distingue el oído, y ahí es donde se puede
    // tirar información sin que se note.
    const width = (i: number): number => EBAND_5MS[i + 1]! - EBAND_5MS[i]!;
    for (let i = 0; i < 8; i++) expect(width(i), `banda ${i}`).toBe(1);
    expect(width(NB_BANDS - 1)).toBeGreaterThan(width(0) * 15);
    // El último borde son 20 kHz en unidades de 200 Hz.
    expect(EBAND_5MS[NB_BANDS]! * 200).toBe(20000);
  });
});

describe('tablas · asignación de bits', () => {
  it('son 11 filas de calidad, una por banda', () => {
    expect(BAND_ALLOCATION).toHaveLength(11 * NB_BANDS);
  });

  it('la fila 0 no da nada: es el suelo del interpolador', () => {
    for (let band = 0; band < NB_BANDS; band++) expect(BAND_ALLOCATION[band]).toBe(0);
  });

  it('a más calidad, más bits en cada banda', () => {
    // Si una columna bajara al subir de fila, el interpolador daría menos bits
    // al pedirle más bitrate.
    for (let band = 0; band < NB_BANDS; band++) {
      for (let quality = 1; quality < 11; quality++) {
        const previous = BAND_ALLOCATION[(quality - 1) * NB_BANDS + band]!;
        const current = BAND_ALLOCATION[quality * NB_BANDS + band]!;
        expect(current, `banda ${band}, calidad ${quality}`).toBeGreaterThanOrEqual(previous);
      }
    }
  });

  it('dentro de una fila, las bandas graves reciben más que las agudas', () => {
    for (let quality = 1; quality < 11; quality++) {
      for (let band = 1; band < NB_BANDS; band++) {
        const left = BAND_ALLOCATION[quality * NB_BANDS + band - 1]!;
        const right = BAND_ALLOCATION[quality * NB_BANDS + band]!;
        expect(right, `calidad ${quality}, banda ${band}`).toBeLessThanOrEqual(left);
      }
    }
  });
});

describe('tablas · ICDF', () => {
  // Todas las ICDF de CELT comparten forma, y mi range coder DEPENDE de ella:
  // valores que bajan estrictamente y terminan en 0. Una que no la cumpla
  // produce un rango de cero y desincroniza el flujo.
  const icdfs = {
    TRIM_ICDF,
    SPREAD_ICDF,
    TAPSET_ICDF,
    SMALL_ENERGY_ICDF,
  };

  it('bajan estrictamente y acaban en 0', () => {
    for (const [name, table] of Object.entries(icdfs)) {
      expect(table[table.length - 1], `${name}: no acaba en 0`).toBe(0);
      for (let i = 1; i < table.length; i++) {
        expect(table[i]!, `${name}[${i}]`).toBeLessThan(table[i - 1]!);
      }
    }
  });

  it('caben en un byte, que es como las lee el codificador', () => {
    for (const [name, table] of Object.entries(icdfs)) {
      for (const value of table) {
        expect(value, `${name}`).toBeGreaterThanOrEqual(0);
        expect(value, `${name}`).toBeLessThan(256);
      }
    }
  });
});

describe('tablas · modelo de energía', () => {
  it('tiene las cuatro tramas y los dos modos', () => {
    expect(E_PROB_MODEL).toHaveLength(4); // 120, 240, 480, 960
    for (const perFrame of E_PROB_MODEL) {
      expect(perFrame).toHaveLength(2); // inter, intra
      for (const model of perFrame) expect(model).toHaveLength(42); // 21 bandas x 2
    }
  });

  it('todos los valores caben en un byte', () => {
    for (const value of flat(E_PROB_MODEL)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(256);
    }
  });

  it('predecir de la trama anterior sale más barato que no hacerlo', () => {
    // Cada par es (fs0, decay) del codificador Laplace: `fs0` es la
    // probabilidad de que el residuo de energía sea CERO, o sea de que la banda
    // suene igual que en la trama anterior. Cuanto más alta, menos bits cuesta.
    //
    // Una trama intra no puede apoyarse en la anterior, así que su fs0 es más
    // bajo en todas las bandas: ahí está, en números, por qué las tramas intra
    // son las caras y por qué CELT no las usa salvo cuando toca.
    for (let lm = 0; lm < 4; lm++) {
      const zeroProb = (model: readonly number[]): number =>
        sum(model.filter((_, i) => i % 2 === 0));
      const inter = zeroProb(E_PROB_MODEL[lm]![0]!);
      const intra = zeroProb(E_PROB_MODEL[lm]![1]!);
      expect(inter, `LM=${lm}`).toBeGreaterThan(intra);
    }
  });
});

describe('tablas · resto', () => {
  it('tf_select tiene 4 tamaños de trama por 8 combinaciones', () => {
    expect(TF_SELECT_TABLE).toHaveLength(4);
    for (const row of TF_SELECT_TABLE) expect(row).toHaveLength(8);
  });

  it('log2_frac no baja nunca', () => {
    expect(LOG2_FRAC_TABLE).toHaveLength(24);
    for (let i = 1; i < LOG2_FRAC_TABLE.length; i++) {
      expect(LOG2_FRAC_TABLE[i]!).toBeGreaterThanOrEqual(LOG2_FRAC_TABLE[i - 1]!);
    }
  });

  it('los límites de fits_in32 se estrechan al crecer la banda', () => {
    for (let i = 1; i < FITS32_MAX_N.length; i++) {
      expect(FITS32_MAX_N[i]!).toBeLessThanOrEqual(FITS32_MAX_N[i - 1]!);
      expect(FITS32_MAX_K[i]!).toBeLessThanOrEqual(FITS32_MAX_K[i - 1]!);
    }
  });

  it('los coeficientes de predicción bajan con el tamaño de trama', () => {
    // Cuanto más larga la trama, menos se parece a la anterior y menos se
    // puede predecir de ella.
    expect(PRED_COEF).toHaveLength(4);
    for (let i = 1; i < PRED_COEF.length; i++) {
      expect(PRED_COEF[i]!).toBeLessThan(PRED_COEF[i - 1]!);
    }
    for (const value of [...PRED_COEF, ...BETA_COEF, BETA_INTRA]) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('la resolución del asignador son octavos de bit', () => {
    expect(BITRES).toBe(3);
    expect(1 << BITRES).toBe(8);
  });
});
