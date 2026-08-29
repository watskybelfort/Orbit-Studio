/**
 * Los golden tests que la regla dura 5 de CLAUDE.md da por hechos.
 *
 * Fijan el sonido renderizando 25 proyectos deterministas —uno por
 * familia de sonido— y comparándolos contra `baseline.json` de DOS maneras a
 * la vez: el hash de las muestras crudas y una matriz de medidas
 * perceptuales por ventana de tiempo. El porqué de cada una está en
 * `fingerprint.ts`; el porqué de que el hash se pueda comparar en toda la
 * matriz de la CI está MEDIDO en `platform.ts`.
 *
 * Si esto se pone rojo, no es un test quisquilloso: cambió el sonido de algo.
 * El mensaje de fallo dice qué y cuánto. Aceptar el cambio es un gesto
 * explícito (`npm run golden:update`), nunca un `--update-snapshots`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_FIXTURES, GOLDEN_OPUS_FIXTURES } from './fixtures';
import { compare, explain, METRIC_TOLERANCE_DB } from './fingerprint';
import { BASELINE_FORMAT_VERSION, encodeFixture, renderFixture, type Baseline } from './run';
import {
  BIT_EXACT_ARCHS,
  describeRuntime,
  isBitExactVerified,
  unverifiedArchWarning,
} from './platform';

const baseline = JSON.parse(
  readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'),
) as Baseline;

describe('golden: la línea base es legible y está completa', () => {
  it('el formato del archivo es el que este test sabe leer', () => {
    // Un `baseline.json` de otro formato compararía peras con manzanas sin
    // avisar: menos ventanas, otra métrica, otra escala. Mejor romper aquí.
    expect(baseline.formatVersion).toBe(BASELINE_FORMAT_VERSION);
  });

  it('hay una línea base por fixture, y ninguna sobra', () => {
    const enBanco = GOLDEN_FIXTURES.map((f) => f.name).sort();
    const enBase = Object.keys(baseline.fixtures).sort();
    // Las dos direcciones importan. Que falte una es un fixture nuevo sin
    // fijar (el agujero que esta tarea vino a tapar). Que sobre una es un
    // fixture borrado o RENOMBRADO: renombrar pierde la línea base, y si eso
    // pasa en silencio el fixture nuevo se fija con el sonido de hoy sin que
    // nadie compare nada.
    expect(enBase).toEqual(enBanco);
  });

  it('lo mismo para los flujos Opus', () => {
    expect(Object.keys(baseline.opus).sort()).toEqual(
      GOLDEN_OPUS_FIXTURES.map((f) => f.name).sort(),
    );
  });
});

describe('golden: el sonido', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    const expected = baseline.fixtures[fixture.name];

    it(`${fixture.name} — ${fixture.covers}`, () => {
      expect(expected, `sin línea base para "${fixture.name}"`).toBeDefined();
      const actual = renderFixture(fixture);
      const cmp = compare(expected!, actual);

      // Se comprueban las MÉTRICAS primero a propósito. Las dos fallan a la
      // vez cuando cambia el sonido, y en ese caso lo que hay que leer es
      // "el grave subió 3 dB en la ventana 4", no "el sha256 cambió". Vitest
      // corta en la primera aserción que falla, así que el orden decide qué
      // mensaje llega a la persona.
      //
      // Y el informe va en el MENSAJE de la aserción, no dentro del valor
      // comparado: metido en un objeto, vitest lo esconde tras un "1 matching
      // property omitted from actual" y el diff que costó calcular no lo ve
      // nadie. Comprobado — la primera versión de este test lo hacía así.
      expect(
        cmp.metricDiffs.length,
        `medidas fuera de la tolerancia de ${METRIC_TOLERANCE_DB} dB\n` +
          explain(fixture.name, fixture.covers, cmp),
      ).toBe(0);

      expect(actual.samples, `${fixture.name}: el render cambió de largo`).toBe(expected!.samples);

      expect(
        actual.hash,
        `${fixture.name}: el hash cambió aunque el sonido medido es el mismo.\n` +
          explain(fixture.name, fixture.covers, cmp) +
          (isBitExactVerified() ? '' : `\n\n${unverifiedArchWarning()}`),
      ).toBe(expected!.hash);
    });
  }
});

describe('golden: el encoder Opus', () => {
  // Aquí NO hay tolerancia y no es un descuido: el `.opus` es un bitstream
  // codificado con rango. Un bit distinto no es «un poco distinto», es un
  // archivo que se decodifica a otra cosa a partir de ese punto. La única
  // comparación con sentido es la igualdad, y por eso el mensaje de fallo no
  // ofrece un diagnóstico gradual: ofrece el banco de calidad, que es lo que
  // sabe decir si el flujo nuevo suena mejor o peor.
  for (const f of GOLDEN_OPUS_FIXTURES) {
    it(`${f.name} — ${f.covers}`, () => {
      const expected = baseline.opus[f.name];
      expect(expected, `sin línea base para "${f.name}"`).toBeDefined();
      const actual = encodeFixture(f);
      expect(
        actual.hash,
        `${f.name}: el flujo Opus cambió (${expected!.bytes} → ${actual.bytes} bytes).\n` +
          '  El encoder produce otros bytes. Si fue a propósito, el banco de calidad\n' +
          '  (`tools/qa/opus-quality.ts`) es lo que dice si suena mejor o peor —\n' +
          '  un hash solo dice que cambió. Con esa medida en la mano:\n' +
          '  `npm run golden:update -- --accept "…"`.',
      ).toBe(expected!.hash);
    });
  }
});

describe('golden: el propio banco es determinista', () => {
  // Sin esto, todo lo demás es aire: un banco que no da dos veces el mismo
  // render no está fijando nada, solo fotografiando ruido. Se comprueba con un
  // fixture de cada mitad —uno con voces y osciladores, otro con la cadena de
  // efectos entera— en vez de con los 24, para no doblar el tiempo del test
  // por una propiedad que o se cumple en todo el motor o en ninguna parte.
  for (const name of ['inst-prisma-default', 'fx-master-chain']) {
    it(`${name}: dos renders seguidos dan exactamente lo mismo`, () => {
      const f = GOLDEN_FIXTURES.find((x) => x.name === name)!;
      expect(renderFixture(f).hash).toBe(renderFixture(f).hash);
    });
  }

  it('la línea base dice con qué runtime se grabó', () => {
    // No es adorno: es lo primero que hay que mirar cuando un hash cambia sin
    // que se haya tocado el motor.
    expect(baseline.recordedOn.arch).toBeTruthy();
    expect(baseline.recordedOn.node).toBeTruthy();
    // Y tiene que venir de una arquitectura donde la reproducibilidad bit a bit
    // está MEDIDA. Hay un `--force` para saltarse esa negativa, así que esto es
    // lo único que se entera si alguien lo usó: una línea base grabada fuera de
    // x64 deja el hash roto para toda la CI, y el síntoma sería un rojo masivo
    // sin que nadie haya tocado el motor.
    // (Aquí antes había `expect(describeRuntime()).toContain(process.arch)`,
    // que no afirmaba nada: `describeRuntime()` construye ese string CON
    // `process.arch`.)
    expect(BIT_EXACT_ARCHS).toContain(baseline.recordedOn.arch);
  });
});
