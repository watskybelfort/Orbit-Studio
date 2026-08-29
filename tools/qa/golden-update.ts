/**
 * `npm run golden:update` — regenerar la línea base del sonido.
 *
 * Existe para que aceptar un cambio de sonido cueste un gesto y no un
 * descuido. Por eso NO hay un `--update-snapshots`: sin argumentos esto NO
 * escribe nada, solo enseña el diff. Escribir pide `--accept "<motivo>"`, y el
 * motivo acaba dentro del archivo y en el mensaje de commit que el propio
 * comando propone.
 *
 * Uso:
 *   npm run golden:update                      # informe, no toca nada
 *   npm run golden:update -- --only fx-vinyl   # informe de un fixture
 *   npm run golden:update -- --accept "el vinilo ya no da silencio exacto"
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { GOLDEN_FIXTURES, GOLDEN_OPUS_FIXTURES } from '../../packages/engine/test/golden/fixtures';
import { compare, METRIC_TOLERANCE_DB } from '../../packages/engine/test/golden/fingerprint';
import {
  BASELINE_FORMAT_VERSION,
  encodeFixture,
  renderFixture,
  type Baseline,
} from '../../packages/engine/test/golden/run';
import {
  describeRuntime,
  isBitExactVerified,
  runtimeInfo,
  unverifiedArchWarning,
} from '../../packages/engine/test/golden/platform';

const BASELINE_PATH = fileURLToPath(
  new URL('../../packages/engine/test/golden/baseline.json', import.meta.url),
);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function readBaseline(): Baseline | null {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline;
  } catch {
    return null;
  }
}

function orbitVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../../package.json') as { version: string }).version;
}

function main(): void {
  const only = arg('only');
  const accept = arg('accept');
  const previous = readBaseline();

  console.log(
    `Golden — banco de ${GOLDEN_FIXTURES.length} renders + ${GOLDEN_OPUS_FIXTURES.length} flujos Opus`,
  );
  console.log(`Runtime: ${describeRuntime()}`);
  if (previous) {
    console.log(
      `Línea base actual: v${previous.orbitVersion}, grabada ${previous.recordedAt}` +
        ` en ${previous.recordedOn.platform}/${previous.recordedOn.arch}` +
        ` (Node ${previous.recordedOn.node})`,
    );
  } else {
    console.log('No hay línea base: esto la crearía desde cero.');
  }
  console.log('');

  const fixtures = GOLDEN_FIXTURES.filter((f) => !only || f.name === only);
  if (only && fixtures.length === 0 && !GOLDEN_OPUS_FIXTURES.some((f) => f.name === only)) {
    console.error(`No hay ningún fixture "${only}".`);
    process.exit(2);
  }

  const nuevo: Baseline['fixtures'] = {};
  const cambiados: string[] = [];
  const sonoros: string[] = [];
  const soloBits: string[] = [];
  const nuevos: string[] = [];

  for (const f of fixtures) {
    process.stdout.write(`  ${f.name} … `);
    const fp = renderFixture(f);
    nuevo[f.name] = { covers: f.covers, ...fp };
    const antes = previous?.fixtures[f.name];
    if (!antes) {
      nuevos.push(f.name);
      console.log('NUEVO (no tenía línea base)');
      continue;
    }
    const cmp = compare(antes, fp);
    if (cmp.hashMatches && cmp.metricDiffs.length === 0) {
      console.log('igual');
      continue;
    }
    cambiados.push(f.name);
    if (cmp.metricDiffs.length > 0) {
      sonoros.push(f.name);
      const peor = cmp.worst!;
      console.log(
        `CAMBIÓ EL SONIDO — ${cmp.metricDiffs.length} medida(s) fuera de ${METRIC_TOLERANCE_DB} dB;` +
          ` la peor: ${peor.where} · ${peor.key} ${peor.expected.toFixed(3)} → ${peor.actual.toFixed(3)}` +
          ` (Δ ${peor.delta.toFixed(3)} dB)`,
      );
      for (const d of cmp.metricDiffs.slice(1, 5)) {
        console.log(
          `      ${d.where} · ${d.key}: ${d.expected.toFixed(3)} → ${d.actual.toFixed(3)}` +
            ` (Δ ${d.delta.toFixed(3)} dB)`,
        );
      }
    } else {
      soloBits.push(f.name);
      console.log('solo el hash — ninguna medida se movió (cambio numérico, no sonoro)');
    }
  }

  // El encoder Opus: bytes, sin tolerancia. `--only` de un fixture de render
  // no toca esta parte (no hay nada que recalcular), pero `--only` de uno de
  // Opus sí, así que se filtra por el mismo nombre.
  const nuevoOpus: Baseline['opus'] = {};
  const opusFixtures = GOLDEN_OPUS_FIXTURES.filter((f) => !only || f.name === only);
  for (const f of opusFixtures) {
    process.stdout.write(`  ${f.name} … `);
    const fp = encodeFixture(f);
    nuevoOpus[f.name] = { covers: f.covers, ...fp };
    const antes = previous?.opus?.[f.name];
    if (!antes) {
      nuevos.push(f.name);
      console.log('NUEVO (no tenía línea base)');
    } else if (antes.hash === fp.hash) {
      console.log('igual');
    } else {
      cambiados.push(f.name);
      sonoros.push(f.name);
      console.log(
        `CAMBIÓ EL FLUJO — ${antes.bytes} → ${fp.bytes} bytes.` +
          ' En un bitstream entrópico no hay «casi igual»: esto es otro archivo.',
      );
    }
  }

  console.log('');
  if (cambiados.length === 0 && nuevos.length === 0) {
    console.log('Nada que actualizar: la línea base ya describe este sonido.');
    return;
  }
  console.log(
    `Resumen: ${sonoros.length} con cambio de SONIDO, ${soloBits.length} solo de bits,` +
      ` ${nuevos.length} nuevo(s).`,
  );

  if (!accept) {
    console.log('');
    console.log('No se ha escrito nada. Si este diff de sonido es el que buscabas:');
    console.log('');
    console.log('  npm run golden:update -- --accept "qué cambió y por qué"');
    console.log('');
    console.log('Y el commit tiene que decirlo. Plantilla:');
    console.log('');
    console.log('  golden: <qué cambió de sonido>');
    console.log('');
    for (const n of sonoros) console.log(`  · ${n}: <qué se movió y por qué se acepta>`);
    for (const n of soloBits) console.log(`  · ${n}: solo bits, ninguna medida se movió`);
    for (const n of nuevos) console.log(`  · ${n}: fixture nuevo, se fija por primera vez`);
    process.exitCode = 1;
    return;
  }

  // Una línea base grabada donde la reproducibilidad bit a bit no está medida
  // rompería el hash para toda la CI (que corre en x64). Ver platform.ts.
  if (!isBitExactVerified() && !has('force')) {
    console.error('');
    console.error(unverifiedArchWarning());
    console.error('');
    console.error('Si aun así sabés lo que hacés, repetilo con --force.');
    process.exit(3);
  }

  if (only && previous) {
    // Actualizar UN fixture no puede borrar los demás.
    for (const [name, fp] of Object.entries(previous.fixtures)) {
      if (!(name in nuevo)) nuevo[name] = fp;
    }
    for (const [name, fp] of Object.entries(previous.opus ?? {})) {
      if (!(name in nuevoOpus)) nuevoOpus[name] = fp;
    }
  }

  const baseline: Baseline & { accepted: string } = {
    formatVersion: BASELINE_FORMAT_VERSION,
    orbitVersion: orbitVersion(),
    recordedAt: new Date().toISOString(),
    recordedOn: runtimeInfo(),
    accepted: accept,
    fixtures: nuevo,
    opus: nuevoOpus,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`Escrito: ${BASELINE_PATH}`);
  console.log(`Motivo guardado: "${accept}"`);
  console.log('Revisá el diff del JSON antes de commitear — es un diff de sonido.');
}

main();
