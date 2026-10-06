/**
 * Avisa de los tests que se están ACERCANDO a su timeout. No es una puerta: avisa.
 *
 * La idea (tarjeta del reporter, v3.10): seis tests en dos rondas se acercaron a su
 * límite —uno lo cazó la CI de Windows en rojo— y cada uno se encontró de una forma
 * distinta. Lo que faltaba no era otro barrido, sino ver venir el séptimo ANTES de que
 * lo vea la CI. aquí se responde a eso con los datos que Vitest ya recoge: después de
 * una corrida, qué tests están cerca de su timeout y cuáles ya lo pasaron.
 *
 * LAS TRES DECISIONES, con el porqué (la tarjeta las pedía explícitas):
 *
 * 1. EL UMBRAL, en porcentaje del timeout EFECTIVO de cada test. Medido sobre las
 *    3635 pruebas de la suite en este repo: p50 = 2 ms, p90 = 210 ms, p99 = 1385 ms, y
 *    el más alto de todos llega al 82 % de su límite. El reparto es de cola finita
 *    (3512 tests por debajo del 10 %, y de 0.3 para arriba solo 28), así que 0.5 está
 *    dos veces por encima del percentil 99 y marca 11 tests hoy: una lista que se lee.
 *    Un umbral absoluto (3000 ms) daría lo mismo aquí porque casi todos los límites
 *    son el default, pero en cuanto un test declara 60 000 un absoluto sería inútil.
 *    Y un porcentaje del límite DECLARADO mentiría con los que no declaran nada.
 *
 * 2. QUÉ HACE AL ENCONTRARLO: avisa y sigue. La tarjeta es explícita y la razón se
 *    ve en el caso que la originó: el sexto test falló en la CI de Windows por
 *    5358 ms contra 5000. Convertir esto en puerta significa que una máquina lenta
 *    —o una corrida con más carga— pone la CI en rojo por un test que en el código
 *    está bien, que es justo el problema que se quería resolver. El rojo tiene que
 *    seguir siendo para lo que está roto.
 *
 * 3. DÓNDE VIVE: en las dos partes, con la misma regla. Localmente es `npm run
 *    test:timeouts`, y en la CI un paso que corre lo mismo. El precedente está en las
 *    dos direcciones (`npm run ci:status` es local; el aviso de estado de
 *    `release.yml` es de workflow), y el aviso solo vale si aparece en el sitio donde
 *    se mira: el rojo de una CI.
 *
 * Lo que NO hace, a propósito: no sube timeouts ni los propone. La regla de la v3.9
 * sigue en pie (un test que tarda dos minutos porque alguien puso el margen en 120 s
 * tampoco prueba nada), y el avg de este repo es de 2 ms: el problema no es que el
 * default de 5000 ms sea corto, es que hay una cola de tests caros que ya declaran su
 * margen con un motivo escrito (`render-integrity-v1.test.ts` lo explica en 6 líneas
 * antes de declarar 30 s). Con la cola a la vista, cada uno decide.
 *
 * Uso:
 *   node tools/qa/test-timeouts.mjs [fichero-raw.json] [--umbral 0.5] [--json salida]
 * Sale siempre con 0: avisa, no falla.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** El default de Vitest, para cuando un timeout venga sin resolver (no debería). */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Umbral de aviso: fracción del timeout efectivo.
 *
 * Medido en esta suite (3635 tests): p50 2 ms · p90 210 ms · p99 1385 ms · máximo 82 %
 * de su límite. 0.5 cae el doble por encima del percentil 99 y deja 11 tests a la
 * vista; por debajo de 0.4 la lista se triplica sin mejorar la señal.
 */
export const UMBRAL_POR_DEFECTO = 0.5;

/** Una fila tal y como la deja el reporter. */
function esFila(f) {
  return (
    f !== null &&
    typeof f === 'object' &&
    typeof f.nombre === 'string' &&
    f.nombre !== '' &&
    typeof f.duracion === 'number'
  );
}

/**
 * Las filas que el reporter escribió, ya normalizadas.
 *
 * Un timeout `null` NO se sustituye por el default en silencio: son dos cosas
 * distintas y con la una no se puede juzgar. Se devuelven aparte para que el resumen
 * las cuente, porque un default inventado ahí produce una alarma falsa o un falso
 * silencio, y las dos cosas son peores que decir que no se sabe.
 */
export function normaliza(datos) {
  const filas = [];
  const sinTimeout = [];
  for (const f of Array.isArray(datos?.filas) ? datos.filas : []) {
    if (!esFila(f)) continue;
    if (typeof f.timeout !== 'number' || f.timeout <= 0) {
      sinTimeout.push(f);
      continue;
    }
    filas.push({ nombre: f.nombre, duracion: f.duracion, timeout: f.timeout, ratio: f.duracion / f.timeout });
  }
  return { filas, sinTimeout };
}

/** Las filas que avisan, de la más cercana a su límite a la másAlejada. */
export function seleccionaAvisos(filas, umbral = UMBRAL_POR_DEFECTO) {
  return filas.filter((f) => f.ratio >= umbral).sort((a, b) => b.ratio - a.ratio);
}

/** Una línea de aviso. En GitHub Actions, `::warning::` la saca en el resumen. */
export function lineaWarning(fila) {
  const pct = Math.round(fila.ratio * 100);
  const ms = Math.round(fila.duracion);
  return (
    `::warning::test al ${pct}% de su timeout (${ms} ms de ${fila.timeout} ms) — ` +
    `va camino de caerse por tiempo: ${fila.nombre}`
  );
}

/** Una línea legible, para el resumen del job. */
export function lineaResumen(fila) {
  const pct = (fila.ratio * 100).toFixed(0).padStart(3);
  const ms = Math.round(fila.duracion).toString().padStart(6);
  return `  ${pct}%  ${ms} ms / ${fila.timeout} ms  ${fila.nombre}`;
}

/** Números para el resumen y para el JSON de comparación. */
export function resumen(filas, avisos, sinTimeout, umbral) {
  const ratios = filas.map((f) => f.ratio).sort((a, b) => a - b);
  const q = (p) => (ratios.length === 0 ? 0 : ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))]);
  const duraciones = filas.map((f) => f.duracion).sort((a, b) => a - b);
  const dq = (p) =>
    duraciones.length === 0 ? 0 : duraciones[Math.min(duraciones.length - 1, Math.floor(duraciones.length * p))];
  return {
    umbral,
    tests: filas.length,
    avisos: avisos.length,
    sinTimeout: sinTimeout.length,
    yaSuperado: filas.filter((f) => f.ratio >= 1).length,
    ratio: { p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: ratios[ratios.length - 1] ?? 0 },
    duracionMs: { p50: dq(0.5), p90: dq(0.9), p99: dq(0.99), max: duraciones[duraciones.length - 1] ?? 0 },
  };
}

/** Lo que se escribe en el log de la corrida: una línea por test y el resumen. */
export function textoDelInforme(res, avisos, sinTimeout) {
  const out = [];
  out.push(
    `Tests cerca de su timeout (>= ${Math.round(res.umbral * 100)}% del límite efectivo): ` +
      `${res.avisos} de ${res.tests}.`,
  );
  if (res.yaSuperado > 0) {
    out.push(`  OJO: ${res.yaSuperado} test(s) ya han pasado de su timeout en esta corrida.`);
  }
  for (const fila of avisos) out.push(lineaResumen(fila));
  if (sinTimeout.length > 0) {
    out.push(
      `  Sin timeout resuelto: ${sinTimeout.length}. No se han juzgado (el default de ` +
        `Vitest son ${DEFAULT_TIMEOUT_MS} ms, pero inventarlo daría una alarma falsa), ` +
        'así que quedan fuera de la cuenta.',
    );
  }
  out.push(
    `  Reparto: p50 ${res.ratio.p50.toFixed(3)} · p90 ${res.ratio.p90.toFixed(3)} · ` +
      `p99 ${res.ratio.p99.toFixed(3)} · max ${res.ratio.max.toFixed(3)} del límite.`,
  );
  out.push('  Aviso, no puerta: esto no falla la CI (una máquina lenta no es un bug).');
  return out.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseaArgs(argv) {
  const opciones = { entrada: null, umbral: UMBRAL_POR_DEFECTO, salida: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--umbral') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`--umbral necesita un número > 0 (recibido: ${argv[i]})`);
      opciones.umbral = v;
    } else if (a === '--json') {
      opciones.salida = argv[++i] ?? null;
    } else if (!a.startsWith('--')) {
      opciones.entrada = a;
    }
  }
  return opciones;
}

export function main(argv, salida = console) {
  const opciones = parseaArgs(argv);
  const entrada = opciones.entrada ?? 'out/qa/test-timeouts-raw.json';
  let datos;
  try {
    datos = JSON.parse(readFileSync(entrada, 'utf8'));
  } catch (error) {
    // Sin datos no hay nada que avisar, y no es un fallo del repo: se dice y se sale 0.
    salida.log(`test-timeouts: no se pudo leer ${entrada} (${error.message}).`);
    salida.log('  Se genera corriendo: npm run test:timeouts');
    return 0;
  }
  const { filas, sinTimeout } = normaliza(datos);
  const avisos = seleccionaAvisos(filas, opciones.umbral);
  const res = resumen(filas, avisos, sinTimeout, opciones.umbral);
  for (const fila of avisos) salida.log(lineaWarning(fila));
  salida.log(textoDelInforme(res, avisos, sinTimeout));
  const destino = opciones.salida ?? 'out/qa/test-timeouts-resumen.json';
  try {
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, JSON.stringify({ ...res, avisos }, null, 1), 'utf8');
    salida.log(`  Informe escrito en ${destino}`);
  } catch (error) {
    salida.log(`  No se pudo escribir ${destino}: ${error.message}`);
  }
  return 0;
}

const invocadoDirectamente =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /test-timeouts\.mjs$/.test(process.argv[1] ?? '');
if (invocadoDirectamente) process.exitCode = main(process.argv.slice(2));