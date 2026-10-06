/**
 * Recoge, de cada test, su DURACIÓN y su TIMEOUT EFECTIVO, y lo deja escrito para
 * `tools/qa/test-timeouts.mjs`, que es quien avisa de los que se acercan al suyo.
 *
 * Por qué un reporter y no el JSON de Vitest: el JSON trae la duración pero no el
 * timeout, y unir las dos mitades por `fullName` es frágil — el JSON no siempre
 * separa igual los ancestros (`Suite > test` o `Suite test`), así que una parte
 * silenciosamente se queda con el default y sale una alarma falsa (medido: dos tests
 * de render, con 30 s declarados, salían como si tuvieran 5 s). Leyendo las dos cosas
 * del nodo del test no hay nada que unir.
 *
 * Y por qué el TIMEOUT que se guarda es el efectivo y no el que escribe el test:
 * `test.options.timeout` ya viene resuelto por Vitest con el default del proyecto
 * cuando el test no declara ninguno, así que el fallback no hay que adivinarlo (los
 * timeoutsNULL se cuentan aparte en el resumen, para que no se pierdan en silencio).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Dónde se escribe; lo puede fijar ORBIT_TEST_TIMEOUTS_OUT. */
const SALIDA = process.env.ORBIT_TEST_TIMEOUTS_OUT ?? 'out/qa/test-timeouts-raw.json';

const filas = [];

/** La duración y el estado, tal y como están en el nodo cuando el test termina. */
export default class TimeoutRecolector {
  onTestCaseResult(test) {
    const result = test.task?.result;
    const timeout = test.options?.timeout;
    filas.push({
      nombre: test.fullName,
      duracion: typeof result?.duration === 'number' ? result.duration : null,
      estado: typeof result?.state === 'string' ? result.state : null,
      timeout: typeof timeout === 'number' ? timeout : null,
    });
  }

  onTestRunEnd() {
    mkdirSync(dirname(SALIDA), { recursive: true });
    writeFileSync(SALIDA, JSON.stringify({ filas }, null, 1), 'utf8');
  }
}