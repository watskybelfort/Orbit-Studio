/**
 * La misma prueba de fuego que `plugin-view-hang.test.ts`, pero para el sitio
 * nuevo: la vista de un plugin de INSTRUMENTO, montada ahora en el Channel
 * Rack (`ChannelRack.tsx` → `InstrumentPluginView`, en `plugins/PluginView.tsx`).
 *
 * La pregunta que hace falta responder no es "¿se cuelga la vista?" —eso ya
 * lo prueba `plugin-view-hang.test.ts` sobre `PluginViewSession`, y la sesión
 * es LA MISMA clase para un efecto, un insert de canal o un instrumento: no
 * hay un segundo camino que reinventar. La pregunta es la que import el canal
 * concreto: si el `createView` de un instrumento se cuelga pintando, ¿deja de
 * sonar la NOTA? Dos comprobaciones, una estructural y otra en vivo:
 *
 *   1. `ChannelRack.tsx` monta el instrumento por el MISMO componente
 *      compartido (no crea su propio `Worker` ni su propia sesión), y
 *      `view-session.ts` no importa el motor/el store en ningún momento — así
 *      que matar una sesión colgada no tiene NINGÚN cable hacia el audio que
 *      cortar.
 *   2. Con un worker que se cuelga DE VERDAD (el mismo arnés que el test de
 *      efectos), un reloj independiente que representa el audio —que no
 *      recibe ni un mensaje del worker colgado— sigue corriendo mientras la
 *      sesión detecta el cuelgue y mata al worker.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginViewSession, type ViewPort } from '../src/plugins/view-session';

const here = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => resolve(here, '../src', p);

describe('la vista de un instrumento reusa el SDK compartido, no un camino propio', () => {
  const rack = readFileSync(src('editors/rack/ChannelRack.tsx'), 'utf8');
  const pluginView = readFileSync(src('plugins/PluginView.tsx'), 'utf8');
  const viewSession = readFileSync(src('plugins/view-session.ts'), 'utf8');

  it('ChannelRack.tsx monta InstrumentPluginView desde plugins/PluginView, no un componente nuevo', () => {
    expect(rack).toMatch(/import\s*\{[^}]*InstrumentPluginView[^}]*\}\s*from\s*'\.\.\/\.\.\/plugins\/PluginView'/);
    expect(rack).toContain('<InstrumentPluginView');
  });

  it('ChannelRack.tsx no crea su propio Worker para pintar el instrumento', () => {
    // El único sitio que instancia el worker de la vista es PluginView.tsx: si
    // el rack empezara a crear el suyo, el watchdog de view-session dejaría de
    // vigilarlo y un cuelgue ya no se cazaría.
    expect(rack).not.toMatch(/new Worker\(/);
  });

  it('InstrumentPluginView delega en el MISMO <PluginView>, y hay una sola sesión en todo el archivo', () => {
    const at = pluginView.indexOf('export function InstrumentPluginView');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = pluginView.slice(at, pluginView.indexOf('export function ChannelPluginView'));
    expect(body).toContain('<PluginView');
    // Una sola clase PluginViewSession en todo el archivo: EffectPluginView,
    // ChannelPluginView e InstrumentPluginView comparten el componente
    // <PluginView>, y es ESE el único sitio del archivo que abre una sesión.
    expect(pluginView.match(/new PluginViewSession\(/g)?.length).toBe(1);
  });

  it('view-session.ts no importa el motor ni el store: matar una sesión no toca el audio', () => {
    expect(viewSession).not.toMatch(/from ['"]\.\.\/state\/app['"]/);
    expect(viewSession).not.toContain('engine.');
  });
});

// ── El worker cuelga de verdad, en otro hilo ─────────────────────────────────
//
// Mismo arnés que `plugin-view-hang.test.ts` (Worker de node:worker_threads
// bajo Vitest; en Electron es un Web Worker y `terminate()` hace lo mismo).

const HUNG_WORKER = `
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', (msg) => {
    if (msg && msg.type === 'init') { parentPort.postMessage({ type: 'ready' }); return; }
    for (;;) {}
  });
`;

let alive: Worker[] = [];

afterEach(async () => {
  await Promise.all(alive.map((w) => w.terminate().catch(() => undefined)));
  alive = [];
});

describe('un instrumento cuya vista se cuelga sigue sonando', () => {
  it('el "audio" (un reloj que no depende del worker) no se detiene mientras la vista se caza y se mata', async () => {
    const worker = new Worker(HUNG_WORKER, { eval: true });
    alive.push(worker);
    worker.unref();
    let terminated = 0;

    const port: ViewPort = {
      post: (message) => worker.postMessage(message),
      terminate: () => {
        terminated++;
        void worker.terminate();
      },
    };
    const deaths: string[] = [];
    const session = new PluginViewSession({
      port,
      source: 'function createInstrument(){} function createView(){}',
      paramKeys: ['x'],
      labelCount: 0,
      sampleRate: 48000,
      fps: 60,
      deadlineMs: 150,
      onDeath: (r) => deaths.push(r),
    });
    worker.on('message', (data: unknown) => session.handleMessage(data, performance.now()));

    // El "motor de audio": un contador que NO oye una palabra del worker
    // colgado ni de la sesión. Si el hilo del host se bloqueara esperando al
    // worker (que es justo lo que NO tiene que pasar), este contador se
    // congelaría igual que el dibujo.
    let engineTicks = 0;
    const engineClock = setInterval(() => {
      engineTicks++;
    }, 5);

    const t0 = performance.now();
    let hostTicks = 0;
    while (performance.now() - t0 < 2000 && session.alive) {
      session.tick(performance.now(), () => {});
      hostTicks++;
      await new Promise((r) => setTimeout(r, 8));
    }
    clearInterval(engineClock);

    // 1) La sesión se dio cuenta del cuelgue y mató al worker de verdad.
    expect(session.alive).toBe(false);
    expect(session.deathReason).toBe('timeout');
    expect(deaths).toEqual(['timeout']);
    expect(terminated).toBe(1);

    // 2) Mientras tanto, "el audio" siguió corriendo: no es un adorno que dio
    // una vuelta y se paró, dio VARIAS —independientes del worker colgado. El
    // número exacto no importa (depende de cuánto tarde la máquina en notar
    // el timeout de 150 ms); que sea mayor que un puñado es lo que separa
    // "corrió de verdad" de "se congeló con todo lo demás".
    expect(engineTicks).toBeGreaterThan(5);
    expect(hostTicks).toBeGreaterThan(3);
  }, 10_000);
});
