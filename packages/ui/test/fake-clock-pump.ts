/**
 * Reloj de mentira para las pruebas de "un worker que se cuelga no bloquea
 * el host": lo comparten `plugin-view-hang.test.ts` e
 * `instrument-plugin-view-hang.test.ts`, que son la MISMA prueba de fuego
 * sobre dos sitios distintos (`PluginViewSession` a secas, y la sesión
 * montada detrás de un instrumento en el Channel Rack). Compartir esto es a
 * propósito: si el arreglo vive en un solo archivo, el otro se queda con el
 * reloj de pared de antes sin que nadie lo note hasta que vuelva a
 * parpadear bajo carga — que es exactamente el modo de fallo que este repo
 * ya cometió tres veces («se tapó un archivo, no la clase de problema»).
 *
 * El resumen: con `performance.now()` real, cuántas vueltas de
 * `session.tick()` caben antes de que el watchdog cruce su `deadlineMs` es
 * una medida de cuánta CPU había libre en ESE instante — no una propiedad
 * del código, y por eso el número de vueltas parpadeaba bajo carga (varios
 * agentes a la vez, la CI de Windows con el runner ocupado). Aquí se le pasa
 * a `tick()` un reloj que avanza un paso FIJO por vuelta en vez de tiempo
 * real, así que cuántas vueltas hacen falta para cruzar el deadline pasa a
 * ser un cálculo (`deadlineMs / CLOCK_STEP_MS`, y pico) — el mismo con la
 * máquina en reposo o con media docena de procesos peleando por el CPU.
 *
 * Lo que SÍ sigue siendo tiempo real es la espera entre vueltas
 * (`setTimeout`): eso es lo que le da al worker colgado —que corre de
 * verdad en su propio hilo del sistema operativo— tiempo real en el que
 * seguir atascado, y lo que demuestra que el hilo del host no se bloqueó:
 * si lo estuviera, el bucle ni siquiera llegaría a completar sus vueltas
 * dentro del timeout del test — no haría falta ninguna aserción sobre un
 * número para notarlo.
 */
import type { PluginViewSession } from '../src/plugins/view-session';

/** Paso del reloj de mentira que ve `session.tick()` en cada vuelta. */
export const CLOCK_STEP_MS = 10;

/**
 * Le da vueltas a `session.tick()` con el reloj de mentira hasta que la
 * sesión muere (el caso esperado: un worker colgado) o se agota el tope de
 * vueltas calculado a partir de `deadlineMs`. Devuelve cuántas vueltas dio.
 *
 * El tope (`deadlineMs / CLOCK_STEP_MS` + margen) es de sobra para llegar al
 * tick que cruza el deadline; si el watchdog no disparara nunca —una
 * regresión real, no un problema de reloj—, `session.alive` seguiría en
 * `true` después del bucle y esa aserción, hecha por quien llama, es la que
 * lo cazaría. Determinista de punta a punta: ni el tope ni el número de
 * vueltas dependen de cuánta CPU hubiera libre.
 */
export async function pumpWithFakeClock(
  session: PluginViewSession,
  deadlineMs: number,
): Promise<number> {
  const maxTicks = Math.ceil(deadlineMs / CLOCK_STEP_MS) + 10;
  let fakeNow = 0;
  let ticks = 0;
  while (ticks < maxTicks) {
    session.tick(fakeNow, () => {});
    ticks++;
    if (!session.alive) break;
    fakeNow += CLOCK_STEP_MS;
    await new Promise((r) => setTimeout(r, 8));
  }
  return ticks;
}
