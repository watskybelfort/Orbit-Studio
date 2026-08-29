/**
 * La prueba de fuego: un plugin con un bucle infinito dentro, corriendo DE
 * VERDAD en otro hilo, y el host tiene que sobrevivir.
 *
 * `plugin-view-session.test.ts` prueba la lógica del watchdog con un puerto
 * falso, que es donde están los casos raros. Esto prueba la premisa sobre la
 * que se apoya toda la decisión de diseño, y que un puerto falso no puede
 * demostrar: **que el hilo que dibuja se puede matar aunque esté colgado, y
 * que mientras tanto el hilo de la UI sigue corriendo**. Si eso no fuera
 * cierto, el presupuesto de tiempo sería un adorno.
 *
 * Aquí el worker es un `node:worker_threads` (Vitest corre bajo Node, no hay
 * `Worker` de navegador), pero la propiedad que se comprueba es exactamente la
 * misma que usa la app: `postMessage` + `terminate()` sobre un hilo aparte.
 * En Electron el worker es un Web Worker y `terminate()` hace lo mismo.
 */

import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginViewSession, type ViewPort } from '../src/plugins/view-session';
import { pumpWithFakeClock } from './fake-clock-pump';

/**
 * Un "plugin" cuyo draw es `while (true) {}`. Se cuelga al PRIMER frame, que es
 * el caso peor: ni siquiera llega a devolver los buffers.
 */
const HUNG_WORKER = `
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'init') { parentPort.postMessage({ type: 'ready' }); return; }
    // Aquí es donde el plugin dibuja. Y aquí es donde no vuelve.
    for (;;) {}
  });
`;

/** Un worker sano: responde el frame con una lista de dibujo mínima. */
const OK_WORKER = `
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', (msg) => {
    if (!msg) return;
    if (msg.type === 'init') { parentPort.postMessage({ type: 'ready' }); return; }
    msg.out[0] = 1; // OP.CLEAR
    parentPort.postMessage({ type: 'draw', in: msg.in, out: msg.out, len: 1, cost: 0.2 });
  });
`;

let alive: Worker[] = [];

afterEach(async () => {
  await Promise.all(alive.map((w) => w.terminate().catch(() => undefined)));
  alive = [];
});

interface Harness {
  session: PluginViewSession;
  worker: Worker;
  exited: Promise<number>;
  terminateCalls: () => number;
}

function start(code: string, deadlineMs: number, onDeath?: (r: string) => void): Harness {
  const worker = new Worker(code, { eval: true });
  alive.push(worker);
  worker.unref();
  let terminated = 0;
  const exited = new Promise<number>((resolve) => worker.once('exit', resolve));

  const port: ViewPort = {
    post: (message) => worker.postMessage(message),
    terminate: () => {
      terminated++;
      void worker.terminate();
    },
  };
  const session = new PluginViewSession({
    port,
    source: 'function createEffect(){} function createView(){}',
    paramKeys: ['x'],
    labelCount: 0,
    sampleRate: 48000,
    fps: 60,
    deadlineMs,
    ...(onDeath ? { onDeath: (r: string) => onDeath(r) } : {}),
  });
  worker.on('message', (data: unknown) => session.handleMessage(data, performance.now()));
  return { session, worker, exited, terminateCalls: () => terminated };
}

/** El deadline que se le pasa a la sesión colgada en el test de abajo. */
const HANG_DEADLINE_MS = 150;

describe('un plugin que se cuelga pintando, de verdad y en otro hilo', () => {
  it('no bloquea el hilo del host, se caza y se mata al worker', async () => {
    const deaths: string[] = [];
    const h = start(HUNG_WORKER, HANG_DEADLINE_MS, (r) => deaths.push(r));

    // `pumpWithFakeClock` (compartido con `instrument-plugin-view-hang.test.ts`,
    // misma prueba de fuego sobre otro sitio) le da vueltas a `session.tick()`
    // con un reloj de mentira: ver el porqué largo en `fake-clock-pump.ts`.
    const ticks = await pumpWithFakeClock(h.session, HANG_DEADLINE_MS);

    // 1) El hilo del host siguió vivo todo el rato: dio VARIAS vueltas
    //    mientras el otro estaba atascado en su `for(;;)` — no una sola.
    //    Cuántas exactamente ya no depende de la máquina (reloj de mentira
    //    en `pump`), así que lo único que hace falta pedir es "más de una".
    expect(ticks).toBeGreaterThan(1);
    // 2) Se dio cuenta.
    expect(h.session.alive).toBe(false);
    expect(h.session.deathReason).toBe('timeout');
    expect(deaths).toEqual(['timeout']);
    // 3) Y lo mató: el worker de verdad terminó, con bucle infinito y todo.
    expect(h.terminateCalls()).toBe(1);
    await expect(h.exited).resolves.toBeTypeOf('number');
  }, 10_000);

  it('un worker sano dibuja frames y nadie lo mata', async () => {
    // Deadline grande a propósito: lo que se prueba aquí es que un worker
    // SANO no lo maten, no el valor del deadline (eso lo prueba el test de
    // arriba) — con la CPU repartida entre varios agentes, una sola vuelta
    // de ida y vuelta puede tardar más que los 500 ms que tenía antes, y eso
    // mataría un worker perfectamente sano por una razón que no tiene nada
    // que ver con lo que este test quiere cazar.
    const h = start(OK_WORKER, 5_000);
    const t0 = performance.now();
    // 4 s reales de margen para conseguir 5 respuestas de ida y vuelta de
    // verdad entre hilos: bajo carga (varios agentes + la máquina del
    // usuario) se midió esta misma espera fallar con solo 3-4 frames dentro
    // de una ventana de 400 ms — no porque el worker esté colgado (no lo
    // está: `session.alive` sigue en `true`), sino porque cinco vueltas de
    // `postMessage` entre hilos bajo contención pueden tardar más que eso.
    // No hay reloj de mentira posible aquí: la latencia de ida y vuelta ES
    // lo que se está esperando, así que el margen es tiempo real, medido y
    // generoso — no una promesa de que 5 frames "caben" en un instante fijo.
    while (performance.now() - t0 < 4_000 && h.session.frames < 5) {
      h.session.tick(performance.now(), () => {});
      await new Promise((r) => setTimeout(r, 8));
    }
    expect(h.session.alive).toBe(true);
    expect(h.session.frames).toBeGreaterThanOrEqual(5);
    expect(h.terminateCalls()).toBe(0);
  }, 15_000);
});
