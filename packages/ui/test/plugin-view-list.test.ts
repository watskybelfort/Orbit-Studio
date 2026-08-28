/**
 * La frontera de dibujo de un plugin, por el lado de los datos.
 *
 * Lo que se prueba aquí es que entre el código del plugin y la pantalla no hay
 * más que números: el grabador solo escribe floats en un buffer que le dan, y
 * el repintado se los cree lo justo — recorta, descarta y corta. Todo bajo Node,
 * sin DOM: el repintado recibe un doble que apunta las llamadas, que es
 * exactamente la forma de la frontera.
 */

import { describe, expect, it } from 'vitest';
import { DrawRecorder } from '../src/plugins/view-recorder';
import { replayDisplayList, type Canvas2DLike } from '../src/plugins/view-replay';
import { MAX_LINE_WIDTH, OP, PALETTE_SLOTS, VIEW_LIST_CAP } from '../src/plugins/view-protocol';

/** Doble del contexto 2D: apunta qué se le pidió y con qué números. */
interface Call {
  fn: string;
  args: number[];
  text?: string;
}

function fakeCtx(): Canvas2DLike & { calls: Call[]; styles: string[] } {
  const calls: Call[] = [];
  const styles: string[] = [];
  const rec =
    (fn: string) =>
    (...args: number[]) => {
      calls.push({ fn, args });
    };
  let fill = '';
  return {
    calls,
    styles,
    // Cada color que el repintado fija queda apuntado: así se comprueba que
    // salen de la paleta del host y no de una cadena del plugin.
    get fillStyle(): unknown {
      return fill;
    },
    set fillStyle(v: unknown) {
      fill = String(v);
      styles.push(fill);
    },
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    font: '',
    clearRect: rec('clearRect'),
    fillRect: rec('fillRect'),
    strokeRect: rec('strokeRect'),
    beginPath: rec('beginPath'),
    moveTo: rec('moveTo'),
    lineTo: rec('lineTo'),
    closePath: rec('closePath'),
    arc: rec('arc'),
    stroke: rec('stroke'),
    fill: rec('fill'),
    fillText(text: string, x: number, y: number) {
      calls.push({ fn: 'fillText', args: [x, y], text });
    },
  } as unknown as Canvas2DLike & { calls: Call[]; styles: string[] };
}

const PALETTE = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
const OPTS = { width: 200, height: 100, palette: PALETTE, labels: ['uno', 'dos'], font: '10px x' };

describe('DrawRecorder: lo único que el plugin toca del host', () => {
  it('no sostiene nada que no sea números y su propio buffer', () => {
    const buf = new Float32Array(64);
    const rec = new DrawRecorder(buf, 2);
    rec.color(4).line(0, 0, 1, 1);
    // Todo lo que un plugin puede alcanzar por el objeto que se le pasa: si
    // aquí apareciera un canvas, un worker o un nodo, la frontera estaría rota.
    for (const value of Object.values(rec as unknown as Record<string, unknown>)) {
      const ok =
        typeof value === 'number' || typeof value === 'boolean' || value instanceof Float32Array;
      expect(ok).toBe(true);
    }
  });

  it('escribe opcodes y argumentos en el buffer que le dan', () => {
    const buf = new Float32Array(32);
    const rec = new DrawRecorder(buf, 0);
    rec.color(3).moveTo(0.25, 0.5).lineTo(1, 0).stroke();
    expect(rec.length).toBe(1 + 1 + 3 + 3 + 1);
    expect(Array.from(buf.subarray(0, rec.length))).toEqual([
      OP.COLOR, 3,
      OP.MOVE, 0.25, 0.5,
      OP.LINE, 1, 0,
      OP.STROKE,
    ]);
    expect(rec.overflow).toBe(false);
  });

  it('lleno el buffer, deja de anotar en vez de reservar más', () => {
    // Tope pequeño a propósito: un plugin que dibuje sin parar no puede hacer
    // que la UI reserve memoria por él.
    const buf = new Float32Array(8);
    const rec = new DrawRecorder(buf, 0);
    for (let i = 0; i < 500; i++) rec.lineTo(i, i);
    expect(rec.overflow).toBe(true);
    expect(rec.length).toBeLessThanOrEqual(8);
  });

  it('una orden que no cabe entera no se escribe a medias', () => {
    const buf = new Float32Array(3);
    const rec = new DrawRecorder(buf, 0);
    rec.moveTo(1, 1); // 3 floats: cabe justo
    expect(rec.length).toBe(3);
    rec.fillRect(0, 0, 1, 1); // 5 floats: no cabe nada
    expect(rec.length).toBe(3);
    expect(rec.overflow).toBe(true);
  });

  it('label fuera del catálogo declarado no se anota siquiera', () => {
    const buf = new Float32Array(32);
    const rec = new DrawRecorder(buf, 2);
    rec.label(5, 0.5, 0.5); // solo hay 2 etiquetas
    rec.label(-1, 0.5, 0.5);
    expect(rec.length).toBe(0);
    rec.label(1, 0.5, 0.5, 2);
    expect(rec.length).toBe(5);
  });

  it('reset cambia de buffer sin arrastrar lo anterior (ping-pong)', () => {
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    const rec = new DrawRecorder(a, 0);
    rec.clear();
    expect(rec.length).toBe(1);
    rec.reset(b);
    expect(rec.length).toBe(0);
    rec.stroke();
    expect(b[0]).toBe(OP.STROKE);
  });

  it('curve() traza una polilínea de N puntos sin reservar arrays', () => {
    const rec = new DrawRecorder(new Float32Array(VIEW_LIST_CAP), 0);
    rec.curve((x) => x * x, 10);
    // begin + move + 9 lineTo + stroke
    expect(rec.length).toBe(1 + 3 + 9 * 3 + 1);
  });
});

describe('replayDisplayList: el host no se fía de lo que le devuelven', () => {
  it('recorre la lista completa con las coordenadas ya en píxeles', () => {
    const buf = new Float32Array(64);
    const rec = new DrawRecorder(buf, 0);
    rec.begin().moveTo(0, 0).lineTo(1, 1).stroke();
    const ctx = fakeCtx();
    const stats = replayDisplayList(ctx, buf, rec.length, OPTS);
    expect(stats).toEqual({ ops: 4, aborted: false });
    expect(ctx.calls.map((c) => c.fn)).toEqual(['beginPath', 'moveTo', 'lineTo', 'stroke']);
    expect(ctx.calls[2]!.args).toEqual([200, 100]);
  });

  it('NaN e infinitos no llegan al canvas (un NaN envenena el trazo entero)', () => {
    const buf = new Float32Array(32);
    buf[0] = OP.MOVE;
    buf[1] = NaN;
    buf[2] = Infinity;
    buf[3] = OP.LINE;
    buf[4] = -5;
    buf[5] = 99;
    const ctx = fakeCtx();
    replayDisplayList(ctx, buf, 6, OPTS);
    for (const call of ctx.calls) {
      for (const a of call.args) expect(Number.isFinite(a)).toBe(true);
    }
    expect(ctx.calls[0]!.args).toEqual([0, 100]); // NaN → 0 · Infinity → borde
    expect(ctx.calls[1]!.args).toEqual([0, 100]); // -5 → 0 · 99 → 1
  });

  it('las coordenadas nunca salen del rectángulo de la vista', () => {
    const buf = new Float32Array(64);
    const rec = new DrawRecorder(buf, 0);
    rec.fillRect(-10, -10, 50, 50).strokeRect(2, 2, 2, 2).circle(5, -5, 9);
    const ctx = fakeCtx();
    replayDisplayList(ctx, buf, rec.length, OPTS);
    for (const call of ctx.calls) {
      if (call.fn === 'arc') {
        expect(call.args[2]).toBeLessThanOrEqual(Math.min(OPTS.width, OPTS.height));
        continue;
      }
      expect(call.args[0]).toBeGreaterThanOrEqual(0);
      expect(call.args[0]).toBeLessThanOrEqual(OPTS.width);
      expect(call.args[1]).toBeGreaterThanOrEqual(0);
      expect(call.args[1]).toBeLessThanOrEqual(OPTS.height);
    }
  });

  it('el color es un índice a la paleta del host, no una cadena del plugin', () => {
    const buf = new Float32Array(16);
    const rec = new DrawRecorder(buf, 0);
    rec.color(6).clear();
    const ctx = fakeCtx();
    replayDisplayList(ctx, buf, rec.length, OPTS);
    expect(ctx.styles).toContain('c6');
    // Un índice inventado se recorta al último slot; nunca sale del array.
    // (styles[0] es el color de partida que fija el repintado, no el plugin.)
    const buf2 = new Float32Array([OP.COLOR, 999, OP.COLOR, -3]);
    const ctx2 = fakeCtx();
    replayDisplayList(ctx2, buf2, 4, OPTS);
    expect(ctx2.styles.slice(1)).toEqual([PALETTE[PALETTE_SLOTS - 1], PALETTE[0]]);
  });

  it('la opacidad y el grosor se recortan a rangos visibles', () => {
    const buf = new Float32Array([OP.WIDTH, 1000, OP.ALPHA, 5]);
    const ctx = fakeCtx();
    replayDisplayList(ctx, buf, 4, OPTS);
    expect(ctx.lineWidth).toBe(MAX_LINE_WIDTH);
    // El repintado deja siempre la opacidad restaurada al terminar.
    expect(ctx.globalAlpha).toBe(1);
  });

  it('el texto sale del catálogo del host, nunca del buffer', () => {
    const buf = new Float32Array([OP.LABEL, 1, 0.5, 0.5, 1]);
    const ctx = fakeCtx();
    replayDisplayList(ctx, buf, 5, OPTS);
    const label = ctx.calls.find((c) => c.fn === 'fillText');
    expect(label?.text).toBe('dos');
    // Sin catálogo no se pinta ningún texto.
    const ctx2 = fakeCtx();
    replayDisplayList(ctx2, buf, 5, { ...OPTS, labels: [] });
    expect(ctx2.calls.some((c) => c.fn === 'fillText')).toBe(false);
  });

  it('un opcode desconocido corta el repintado en vez de resincronizar', () => {
    // Seguir leyendo sería interpretar coordenadas como órdenes.
    const buf = new Float32Array([OP.STROKE, 42, OP.FILL]);
    const ctx = fakeCtx();
    const stats = replayDisplayList(ctx, buf, 3, OPTS);
    expect(stats.aborted).toBe(true);
    expect(ctx.calls.map((c) => c.fn)).toEqual(['stroke']);
  });

  it('una orden cortada al final del buffer se descarta', () => {
    const buf = new Float32Array([OP.MOVE, 0.5]); // falta la y
    const ctx = fakeCtx();
    const stats = replayDisplayList(ctx, buf, 2, OPTS);
    expect(stats).toEqual({ ops: 0, aborted: true });
    expect(ctx.calls).toHaveLength(0);
  });

  it('una longitud mentirosa se recorta al buffer real', () => {
    const buf = new Float32Array([OP.STROKE]);
    const ctx = fakeCtx();
    const stats = replayDisplayList(ctx, buf, 999999, OPTS);
    expect(stats.ops).toBe(1);
  });

  it('un buffer entero de basura no revienta el bucle de dibujo', () => {
    const buf = new Float32Array(256);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random() * 1e6 - 5e5;
    const ctx = fakeCtx();
    expect(() => replayDisplayList(ctx, buf, buf.length, OPTS)).not.toThrow();
  });
});
