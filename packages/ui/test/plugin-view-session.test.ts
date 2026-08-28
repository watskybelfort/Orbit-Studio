/**
 * Qué pasa cuando la vista de un plugin se porta mal.
 *
 * La sesión habla con un `ViewPort` (post + terminate), no con un `Worker`, así
 * que un worker COLGADO se puede escribir aquí tal cual es: un puerto que se
 * traga los mensajes y no contesta jamás. Eso es exactamente lo que hace un
 * `while (true)` al otro lado, y permite comprobar bajo Node lo que importa —
 * que el host sigue funcionando, que se da cuenta, y que mata al worker.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  MAX_DRAW_ERRORS,
  PluginViewSession,
  VIEW_DEADLINE_MS,
  type ViewPort,
} from '../src/plugins/view-session';
import { DEFAULT_BUDGET, ViewBudget } from '../src/plugins/view-budget';
import { IN_LEN, OP, VIEW_LIST_CAP } from '../src/plugins/view-protocol';

/** Puerto de mentira que apunta lo que se le manda y si lo mataron. */
function fakePort() {
  const sent: { message: unknown; transfer?: ArrayBuffer[] }[] = [];
  let terminated = 0;
  const port: ViewPort = {
    post: (message, transfer) => {
      sent.push({ message, transfer });
    },
    terminate: () => {
      terminated++;
    },
  };
  return {
    port,
    sent,
    get terminated() {
      return terminated;
    },
  };
}

interface Over {
  onDraw?: (list: Float32Array, len: number) => void;
  onDeath?: (reason: string, detail: string) => void;
  fps?: number;
  deadlineMs?: number;
}

function newSession(port: ViewPort, over: Over = {}): PluginViewSession {
  return new PluginViewSession({
    port,
    source: 'function createEffect(){} function createView(){}',
    paramKeys: ['a', 'b'],
    labelCount: 0,
    sampleRate: 48000,
    fps: over.fps ?? 60,
    ...(over.deadlineMs !== undefined ? { deadlineMs: over.deadlineMs } : {}),
    ...(over.onDraw ? { onDraw: over.onDraw } : {}),
    ...(over.onDeath ? { onDeath: over.onDeath } : {}),
  });
}

/** Respuesta sana del worker: devuelve los buffers y una lista mínima. */
function replyOk(session: PluginViewSession, sentMsg: unknown, now: number, cost = 1) {
  const m = sentMsg as { in: Float32Array; out: Float32Array };
  m.out[0] = OP.CLEAR;
  session.handleMessage(
    { type: 'draw', in: m.in, out: m.out, len: 1, cost },
    now,
  );
}

describe('PluginViewSession: el ciclo normal', () => {
  it('manda la fuente UNA vez al arrancar y nunca la compila aquí', () => {
    const p = fakePort();
    newSession(p.port);
    expect(p.sent).toHaveLength(1);
    const init = p.sent[0]!.message as { type: string; source: string };
    expect(init.type).toBe('init');
    expect(init.source).toContain('createView');
    // El código viaja como TEXTO: no hay nada compilado en este lado.
    expect(typeof init.source).toBe('string');
  });

  it('el frame va y vuelve con los MISMOS buffers (ping-pong, sin reservar)', () => {
    const p = fakePort();
    const s = newSession(p.port);
    s.tick(0, () => {});
    const first = p.sent[1]!;
    const msg = first.message as { in: Float32Array; out: Float32Array };
    expect(msg.in.length).toBe(IN_LEN);
    expect(msg.out.length).toBe(VIEW_LIST_CAP);
    // Se transfieren los dos ArrayBuffer: el host se queda sin ellos hasta que
    // vuelvan, que es lo que impide mandar un segundo frame encima.
    expect(first.transfer).toHaveLength(2);

    const inBuf = msg.in;
    const outBuf = msg.out;
    replyOk(s, msg, 20);
    s.tick(1000, () => {});
    const second = (p.sent[2]!.message as { in: Float32Array; out: Float32Array });
    expect(second.in).toBe(inBuf);
    expect(second.out).toBe(outBuf);
  });

  it('no manda un frame nuevo mientras el anterior está en vuelo', () => {
    const p = fakePort();
    const s = newSession(p.port);
    s.tick(0, () => {});
    s.tick(1, () => {});
    s.tick(2, () => {});
    expect(p.sent).toHaveLength(2); // init + un frame
  });

  it('respeta el ritmo declarado', () => {
    const p = fakePort();
    const s = newSession(p.port, { fps: 10 }); // 100 ms entre frames
    s.tick(0, () => {});
    replyOk(s, (p.sent[1]!.message), 1);
    s.tick(50, () => {});
    expect(p.sent).toHaveLength(2); // aún no toca
    s.tick(120, () => {});
    expect(p.sent).toHaveLength(3);
  });

  it('la lista llega al repintado con su longitud', () => {
    const draws: number[] = [];
    const p = fakePort();
    const s = newSession(p.port, { onDraw: (_list, len) => draws.push(len) });
    s.tick(0, () => {});
    replyOk(s, p.sent[1]!.message, 5);
    expect(draws).toEqual([1]);
    expect(s.frames).toBe(1);
  });
});

describe('un plugin que se cuelga pintando', () => {
  it('NO bloquea al host: los ticks siguen corriendo y devuelven el control', () => {
    const p = fakePort();
    const s = newSession(p.port);
    // El puerto nunca contesta: es un worker con un while(true) dentro.
    s.tick(0, () => {});
    for (let t = 1; t < VIEW_DEADLINE_MS; t += 10) {
      // Si esto colgara, el test no terminaría. Que llegue al final ES la prueba.
      s.tick(t, () => {});
    }
    expect(s.alive).toBe(true);
    expect(p.terminated).toBe(0);
  });

  it('pasado el plazo lo da por colgado y MATA el worker', () => {
    const deaths: string[] = [];
    const p = fakePort();
    const s = newSession(p.port, { onDeath: (reason) => deaths.push(reason) });
    s.tick(0, () => {});
    s.tick(VIEW_DEADLINE_MS - 1, () => {});
    expect(s.alive).toBe(true);
    s.tick(VIEW_DEADLINE_MS + 1, () => {});
    expect(s.alive).toBe(false);
    expect(s.deathReason).toBe('timeout');
    expect(deaths).toEqual(['timeout']);
    // terminate() es lo ÚNICO que para un bucle infinito ajeno.
    expect(p.terminated).toBe(1);
  });

  it('una vez muerta no vuelve a mandar nada ni a pintar', () => {
    const draws: number[] = [];
    const p = fakePort();
    const s = newSession(p.port, { onDraw: (_l, len) => draws.push(len), deadlineMs: 100 });
    s.tick(0, () => {});
    s.tick(200, () => {});
    const after = p.sent.length;
    s.tick(300, () => {});
    s.tick(400, () => {});
    expect(p.sent).toHaveLength(after);
    // Y un mensaje tardío del cadáver tampoco pinta nada.
    s.handleMessage(
      { type: 'draw', in: new Float32Array(IN_LEN), out: new Float32Array(4), len: 1, cost: 0 },
      500,
    );
    expect(draws).toEqual([]);
  });

  it('el fill del frame no se llega a llamar si la vista está muerta', () => {
    const fill = vi.fn();
    const p = fakePort();
    const s = newSession(p.port, { deadlineMs: 50 });
    s.tick(0, fill);
    expect(fill).toHaveBeenCalledTimes(1);
    s.tick(100, fill); // aquí muere
    s.tick(200, fill);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('si el worker muere por su cuenta, la vista se apaga con motivo', () => {
    const p = fakePort();
    const s = newSession(p.port);
    s.handleWorkerError('Uncaught RangeError');
    expect(s.deathReason).toBe('worker');
    expect(s.deathMessage).toBe('Uncaught RangeError');
  });
});

describe('un plugin que lanza al dibujar', () => {
  it('aguanta fallos sueltos y se apaga a la tercera seguida', () => {
    const p = fakePort();
    const s = newSession(p.port);
    for (let i = 0; i < MAX_DRAW_ERRORS - 1; i++) {
      s.tick(i * 100, () => {});
      const m = p.sent[p.sent.length - 1]!.message as { in: Float32Array; out: Float32Array };
      s.handleMessage({ type: 'draw', in: m.in, out: m.out, len: 0, cost: 0, error: 'boom' }, 0);
      expect(s.alive).toBe(true);
    }
    s.tick(1000, () => {});
    const last = p.sent[p.sent.length - 1]!.message as { in: Float32Array; out: Float32Array };
    s.handleMessage({ type: 'draw', in: last.in, out: last.out, len: 0, cost: 0, error: 'boom' }, 0);
    expect(s.alive).toBe(false);
    expect(s.deathReason).toBe('error');
    expect(s.deathMessage).toBe('boom');
  });

  it('un fallo devuelve los buffers igual: la vista no se queda muda', () => {
    const p = fakePort();
    const s = newSession(p.port);
    s.tick(0, () => {});
    const m = p.sent[1]!.message as { in: Float32Array; out: Float32Array };
    s.handleMessage({ type: 'draw', in: m.in, out: m.out, len: 0, cost: 0, error: 'boom' }, 0);
    s.tick(100, () => {});
    expect(p.sent).toHaveLength(3); // pudo mandar el siguiente frame
  });

  it('un fallo al arrancar (no compila, no hay createView) apaga la vista', () => {
    const p = fakePort();
    const s = newSession(p.port);
    s.handleMessage({ type: 'error', message: 'El plugin no declara createView()' }, 0);
    expect(s.deathReason).toBe('error');
    expect(p.terminated).toBe(1);
  });
});

describe('ViewBudget: el que no se cuelga pero cuesta', () => {
  it('por debajo del presupuesto no pasa nada', () => {
    const b = new ViewBudget(30);
    for (let i = 0; i < 50; i++) expect(b.record(0.5)).toBe('ok');
    expect(b.fps).toBe(30);
  });

  it('pasado el presupuesto blando le baja el ritmo', () => {
    const b = new ViewBudget(30);
    let verdict = 'ok';
    for (let i = 0; i < 50 && verdict !== 'slow'; i++) verdict = b.record(10);
    expect(verdict).toBe('slow');
    expect(b.fps).toBe(DEFAULT_BUDGET.slowFps);
  });

  it('vuelve al ritmo normal cuando se porta bien (con histéresis)', () => {
    const b = new ViewBudget(30);
    for (let i = 0; i < 50; i++) b.record(10);
    expect(b.fps).toBe(DEFAULT_BUDGET.slowFps);
    for (let i = 0; i < 100; i++) b.record(0.2);
    expect(b.fps).toBe(30);
  });

  it('a los N frames pasados del presupuesto duro, se apaga', () => {
    const b = new ViewBudget(30);
    let verdict = 'ok';
    for (let i = 0; i < DEFAULT_BUDGET.strikes + 5 && verdict !== 'kill'; i++) {
      verdict = b.record(DEFAULT_BUDGET.hardMs + 10);
    }
    expect(verdict).toBe('kill');
    // Apagar es definitivo: no se resucita portándose bien.
    expect(b.record(0)).toBe('kill');
  });

  it('un coste absurdo del worker no descoloca la media', () => {
    const b = new ViewBudget(30);
    b.record(NaN);
    b.record(-5);
    expect(b.averageMs).toBe(0);
  });
});

describe('presupuesto dentro de la sesión', () => {
  it('un plugin lento de verdad acaba con la vista apagada, no con la UI', () => {
    const p = fakePort();
    const s = newSession(p.port, { fps: 60 });
    let now = 0;
    for (let i = 0; i < DEFAULT_BUDGET.strikes + 4 && s.alive; i++) {
      now += 100;
      s.tick(now, () => {});
      const m = p.sent[p.sent.length - 1]!.message as { in: Float32Array; out: Float32Array };
      replyOk(s, m, now + 1, DEFAULT_BUDGET.hardMs + 20);
    }
    expect(s.alive).toBe(false);
    expect(s.deathReason).toBe('budget');
    expect(p.terminated).toBe(1);
  });

  it('cerrar la vista mata el worker sin avisar de ninguna muerte rara', () => {
    const deaths: string[] = [];
    const p = fakePort();
    const s = newSession(p.port, { onDeath: (r) => deaths.push(r) });
    s.dispose();
    expect(p.terminated).toBe(1);
    expect(deaths).toEqual([]);
    expect(s.deathReason).toBe('disposed');
  });
});
