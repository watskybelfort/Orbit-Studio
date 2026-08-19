/**
 * Arpegiador completo (paridad con el diálogo de FL): recorridos, octavas,
 * Time mul, Gate, Group notes y las rampas de Levels.
 */

import { describe, expect, it } from 'vitest';
import { arpeggiate, type Note } from '../src';

function note(start: number, duration: number, key: number, velocity = 0.8, pan = 0): Note {
  return { id: `n${key}@${start}`, start, duration, key, velocity, pan, slide: false };
}

/** Do menor de 4 beats: la ventana da para 8 pasos de 0.5. */
const CHORD = [note(0, 4, 60), note(0, 4, 63), note(0, 4, 67)];

const keys = (ns: Note[]) => ns.map((n) => n.key);
/** En orden de disparo (las notas salen ordenadas por start y luego key). */
const order = (ns: Note[]) => [...ns].sort((a, b) => a.start - b.start || a.key - b.key);

describe('recorridos del arpegio', () => {
  it('abajo-arriba baja y vuelve sin repetir extremos', () => {
    const out = order(arpeggiate(CHORD, { rate: 1, mode: 'downup' }));
    expect(keys(out)).toEqual([67, 63, 60, 63]);
  });

  it('alternate va de los extremos al centro', () => {
    const cuatro = [note(0, 4, 60), note(0, 4, 63), note(0, 4, 67), note(0, 4, 70)];
    const out = order(arpeggiate(cuatro, { rate: 1, mode: 'alternate' }));
    expect(keys(out)).toEqual([60, 70, 63, 67]);
  });

  it('acorde no arpegia: suelta las tres notas en cada paso', () => {
    const out = arpeggiate(CHORD, { rate: 1, mode: 'chord' });
    expect(out).toHaveLength(12);
    expect(out.filter((n) => n.start === 0).map((n) => n.key)).toEqual([60, 63, 67]);
  });

  it('aleatorio es determinista: misma semilla, mismo arpegio', () => {
    const a = arpeggiate(CHORD, { rate: 0.5, mode: 'random', seed: 7 });
    const b = arpeggiate(CHORD, { rate: 0.5, mode: 'random', seed: 7 });
    expect(keys(order(a))).toEqual(keys(order(b)));
    // Y usa todas las alturas del acorde, no se queda en una.
    expect(new Set(keys(a)).size).toBe(3);
  });

});

describe('octavas', () => {
  it('las octavas extienden el ciclo hacia arriba', () => {
    const out = order(arpeggiate([note(0, 4, 60), note(0, 4, 64)], { rate: 1, mode: 'up', octaves: 2 }));
    expect(keys(out)).toEqual([60, 64, 72, 76]);
  });

  it('en reverse el ciclo empieza por la octava de arriba', () => {
    const out = order(
      arpeggiate([note(0, 4, 60), note(0, 4, 64)], {
        rate: 1,
        mode: 'up',
        octaves: 2,
        octaveMode: 'reverse',
      }),
    );
    expect(keys(out)).toEqual([76, 72, 64, 60]);
  });
});

describe('Time mul y Gate', () => {
  it('time mul estira el paso: la mitad de notas al doble de largo', () => {
    const normal = arpeggiate(CHORD, { rate: 0.5, mode: 'up' });
    const lento = arpeggiate(CHORD, { rate: 0.5, mode: 'up', timeMul: 2 });
    expect(normal).toHaveLength(8);
    expect(lento).toHaveLength(4);
    expect(lento[0]!.duration).toBeCloseTo(1);
  });

  it('gate corto deja staccato sin mover los inicios', () => {
    const out = order(arpeggiate(CHORD, { rate: 1, mode: 'up', gate: 0.25 }));
    expect(out.map((n) => n.start)).toEqual([0, 1, 2, 3]);
    expect(out.every((n) => Math.abs(n.duration - 0.25) < 1e-9)).toBe(true);
  });

  it('gate largo no deja que una nota se salga del acorde', () => {
    const out = arpeggiate(CHORD, { rate: 1, mode: 'up', gate: 4 });
    const fin = Math.max(...out.map((n) => n.start + n.duration));
    expect(fin).toBeLessThanOrEqual(4 + 1e-9);
  });
});

describe('Group notes', () => {
  const dos = [note(0, 1, 60), note(0, 1, 64), note(2, 1, 67), note(2, 1, 71)];

  it('de fábrica cada acorde se arpegia por su cuenta', () => {
    const out = order(arpeggiate(dos, { rate: 0.5, mode: 'up' }));
    // El hueco entre el beat 1 y el 2 se respeta: nada suena ahí.
    expect(out.some((n) => n.start >= 1 && n.start < 2)).toBe(false);
    expect(keys(out)).toEqual([60, 64, 67, 71]);
  });

  it('agrupadas, las cuatro forman un solo ciclo que llena el hueco', () => {
    const out = order(arpeggiate(dos, { rate: 0.5, mode: 'up', group: true }));
    expect(out.some((n) => n.start >= 1 && n.start < 2)).toBe(true);
    expect(out).toHaveLength(6); // de 0 a 3 en pasos de 0.5
    expect(keys(out)).toEqual([60, 64, 67, 71, 60, 64]);
  });
});

describe('Levels (rampas del ciclo)', () => {
  it('la rampa de velocity va de la original a la original + nivel', () => {
    const out = order(
      arpeggiate([note(0, 4, 60, 0.5)], { rate: 1, mode: 'up', levels: { velocity: 0.4 } }),
    );
    expect(out[0]!.velocity).toBeCloseTo(0.5);
    expect(out[out.length - 1]!.velocity).toBeCloseTo(0.9);
  });

  it('la rampa de pan puede ir en negativo y se acota a -1..1', () => {
    const out = order(arpeggiate([note(0, 4, 60, 0.8, 0)], { rate: 1, mode: 'up', levels: { pan: -3 } }));
    expect(out[0]!.pan).toBeCloseTo(0);
    expect(out[out.length - 1]!.pan).toBe(-1);
  });

  it('la rampa de tono sube el arpegio a lo largo del ciclo', () => {
    const out = order(arpeggiate([note(0, 4, 60)], { rate: 1, mode: 'up', levels: { pitch: 12 } }));
    expect(keys(out)).toEqual([60, 64, 68, 72]);
  });

  it('sin levels nada cambia respecto al arpegio de siempre', () => {
    const conCeros = arpeggiate(CHORD, { rate: 1, mode: 'up', levels: {} });
    const sinNada = arpeggiate(CHORD, { rate: 1, mode: 'up' });
    expect(keys(order(conCeros))).toEqual(keys(order(sinNada)));
  });
});
