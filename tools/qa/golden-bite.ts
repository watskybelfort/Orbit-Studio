/**
 * `npm run golden:bite` — comprobar que el golden MUERDE.
 *
 * Un golden que nadie ha visto fallar no se sabe si funciona. El riesgo real
 * no es que falle de más: es que un fixture se estropee en silencio —deja de
 * sonar, se queda en el ataque, se le rompe la fuente— y siga pasando para
 * siempre, verde y vacío. Desde fuera no se distingue de uno que funciona.
 *
 * Esto lo distingue. Para cada fixture renderiza dos veces: la normal y otra
 * con UNA perturbación diminuta metida en la señal de salida (por defecto
 * 0,1 % de ganancia, muy por debajo de lo audible). Si el fingerprint no nota
 * la diferencia, ese fixture no está midiendo nada y el informe lo señala.
 *
 * Lo que esto NO es: la prueba de que el golden detecta un cambio de DSP. Esa
 * se hizo perturbando coeficientes del motor de verdad (ANTI_DENORMAL,
 * COEF_SMOOTH_SECONDS, la guarda del 0,2 %, el umbral de transitorios y la
 * ganancia del postfiltro del encoder), y los números están en
 * `docs/GOLDEN.md`. No se puede automatizar aquí sin que el comando edite
 * `packages/engine/src`, que es exactamente lo que un comando no debe hacer.
 *
 * Uso:
 *   npm run golden:bite                 # 0,1 % de perturbación
 *   npm run golden:bite -- --ppm 10     # 10 partes por millón (0,001 %)
 */

import { GOLDEN_FIXTURES, GOLDEN_SR } from '../../packages/engine/test/golden/fixtures';
import {
  compare,
  fingerprint,
  METRIC_TOLERANCE_DB,
} from '../../packages/engine/test/golden/fingerprint';
import { renderProject } from '../../packages/engine/src/render/offline';
import { describeRuntime } from '../../packages/engine/test/golden/platform';
import { numeroDeFlag } from './cli-args';

function main(): void {
  const ppm = numeroDeFlag(process.argv, 'ppm', 1000); // 1000 ppm = 0,1 %
  const gain = 1 + ppm / 1e6;
  console.log(`Golden — ¿muerde? Perturbación: ${ppm} ppm de ganancia (×${gain}).`);
  console.log(`Runtime: ${describeRuntime()}`);
  console.log('');

  let sordos = 0;
  let sinHash = 0;
  for (const f of GOLDEN_FIXTURES) {
    const res = renderProject(f.build(), {
      sampleRate: GOLDEN_SR,
      tailSeconds: f.tailSeconds,
      ...(f.samples ? { samples: f.samples() } : null),
    });
    const limpio = fingerprint(res.left, res.right, res.sampleRate);

    // La perturbación se aplica sobre las MUESTRAS ya renderizadas, no sobre un
    // parámetro del proyecto: así mide la sensibilidad del fingerprint y no la
    // de un parámetro concreto, que variaría de fixture a fixture y haría el
    // informe incomparable entre ellos.
    const l = Float32Array.from(res.left, (x) => x * gain);
    const r = Float32Array.from(res.right, (x) => x * gain);
    const tocado = fingerprint(l, r, res.sampleRate);

    const cmp = compare(limpio, tocado);
    const notaHash = !cmp.hashMatches;
    const notaMetricas = cmp.metricDiffs.length > 0;
    if (!notaHash) sinHash += 1;
    if (!notaHash && !notaMetricas) sordos += 1;

    const peor = `${cmp.worstDelta.toFixed(5)} dB`;
    const veredicto = notaHash
      ? notaMetricas
        ? 'muerde (hash + métricas)'
        : 'muerde en el hash; métricas bajo tolerancia'
      : 'SORDO — este fixture no distingue la perturbación';
    console.log(
      `  ${f.name.padEnd(26)} ${veredicto.padEnd(42)} peor Δ ${peor}` +
        (limpio.samples === 0 ? '  ← ¡RENDER VACÍO!' : ''),
    );
  }

  console.log('');
  console.log(
    `${GOLDEN_FIXTURES.length - sordos}/${GOLDEN_FIXTURES.length} fixtures notan una perturbación de ${ppm} ppm.`,
  );
  console.log(
    `${GOLDEN_FIXTURES.length - sinHash}/${GOLDEN_FIXTURES.length} la notan en el hash` +
      ` (la capa sensible; las métricas, con su tolerancia de ${METRIC_TOLERANCE_DB} dB,` +
      ' están para explicar, no para detectar).',
  );
  if (sordos > 0) {
    console.error('');
    console.error(`${sordos} fixture(s) SORDOS: no fijan nada. Arreglalos o borralos.`);
    process.exit(1);
  }
}

main();
