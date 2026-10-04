/**
 * BUG 006 — cambiar a una rama puede aplicar la rama sobre un estado que no es el suyo.
 *
 * La secuencia medida en la tarjeta, con orígenes mezclados (Claude = remoto, local):
 *
 *   1. Claude: setTempo 100        (queda como ancla)
 *   2. local: setSwing 0.3
 *   3. local: undo                 (el swing va al futuro)
 *   4. local: setTimeSig 6/8       (al seguir por otro lado, el swing se ARCHIVA)
 *   5. Claude: undo                (el otro origen se mueve y el ancla cruza al futuro)
 *   6. switchToBranch(rama del swing)
 *
 * Antes: `switched=1`, el swing entraba encima del 6/8 (que no era de esa rama), el
 * 6/8 se quedaba puesto y la rama se consumía (`branchCount` 1 → 0). Los dos caminos
 * quedaban mezclados y el que se archiva no se recuperaba.
 *
 * Ahora, si el salto no deja el presente JUSTO encima del ancla, `switchToBranch` no
 * toca nada: la rama sigue archivada y el estado no se ensucia.
 */

import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src/index';

const CLAUDE = 'remote:claude';

/** Vacía el historial de un origen (undo devuelve si pudo). */
function vaciar(s: ProjectStore, origin: string): void {
  while (s.undo(origin)) {
    /* seguir hasta que no queden */
  }
}

/** El id de la primera rama archivada, o null. */
function primeraRama(s: ProjectStore): string | null {
  return s.historyTree().branches[0]?.id ?? null;
}

/**
 * Deja el patrón de la tarjeta: Claude pone el tempo, nosotros el swing, deshacemos y
 * seguimos por otro lado (que es lo que archiva el swing como rama). Devuelve el id.
 */
function ramaDelSwing(s: ProjectStore): string {
  s.dispatch({ type: 'setTempo', tempo: 100 }, { origin: CLAUDE });
  s.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'local' });
  s.undo('local');
  s.dispatch({ type: 'setTimeSig', timeSig: { num: 6, den: 8 } }, { origin: 'local' });
  const id = primeraRama(s);
  expect(id).not.toBeNull();
  return id!;
}

describe('006 · cambiar a una rama solo si el ancla se alcanza de verdad', () => {
  it('la secuencia de la tarjeta: la rama NO se aplica encima de un estado ajeno', () => {
    const s = new ProjectStore();
    const rama = ramaDelSwing(s);
    expect(s.branchCount).toBe(1);

    // El otro origen se mueve: su entrada (el ancla) pasa al futuro.
    s.undo(CLAUDE);

    // El salto no puede dejar el presente encima del ancla para este origen (el
    // ancla está al otro lado), así que no se aplica nada.
    expect(s.switchToBranch(rama)).toBe(0);
    // El estado sigue como estaba: el 6/8 no se mezcla con el swing de la rama.
    expect(s.project.timeSig).toEqual({ num: 6, den: 8 });
    expect(s.project.swing).toBeCloseTo(0);
    // Y la rama NO se consume: sigue archivada, con su contenido.
    expect(s.branchCount).toBe(1);
    const archivada = s.historyTree().branches[0]!;
    expect(archivada.size).toBe(1);
  });
  it('con el ancla en su sitio: la rama entra y el camino abandonado queda archiving', () => {
    const s = new ProjectStore();
    s.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'local' });
    s.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'local' });
    s.undo('local');
    s.dispatch({ type: 'setTimeSig', timeSig: { num: 6, den: 8 } }, { origin: 'local' });
    const rama = primeraRama(s)!;

    const pasos = s.switchToBranch(rama);

    // El ancla (el tempo) sigue en el tronco, así que se llega: entra el swing y el
    // 6/8 se archiva como OTRA rama, no se pierde.
    expect(pasos).toBe(1);
    expect(s.project.swing).toBeCloseTo(0.3);
    expect(s.project.timeSig).toEqual({ num: 4, den: 4 });
    expect(s.branchCount).toBe(1);
  });

  it('ida y vuelta entre las dos ramas: los dos caminos siguen vivos', () => {
    const s = new ProjectStore();
    s.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'local' });
    s.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'local' });
    s.undo('local');
    s.dispatch({ type: 'setTimeSig', timeSig: { num: 6, den: 8 } }, { origin: 'local' });
    const antes = {
      tempo: s.project.tempo,
      swing: s.project.swing,
      timeSig: { ...s.project.timeSig },
    };
    const rama = primeraRama(s)!;

    // Cambiar de rama CONSUME la que entras (es un intercambio de caminos): al volver,
    // la otra ha cambiado de id, así que se toma la que exista en cada momento.
    expect(s.switchToBranch(rama)).toBe(1);
    expect(s.project.swing).toBeCloseTo(0.3);

    const delSeisOcho = primeraRama(s)!;
    expect(s.switchToBranch(delSeisOcho)).toBe(1);
    // Vuelta al camino del 6/8: el swing desaparece y el 6/8 vuelve.
    expect(s.project.timeSig).toEqual({ num: 6, den: 8 });
    expect(s.project.swing).toBeCloseTo(0);

    // Y de ahí al del swing otra vez, sin haber perdido nada por el camino.
    const delSwing = primeraRama(s)!;
    expect(s.switchToBranch(delSwing)).toBe(1);
    expect(s.project.swing).toBeCloseTo(0.3);
    expect(s.project.timeSig).toEqual({ num: 4, den: 4 });
    expect(s.project.tempo).toBe(antes.tempo);
  });

  it('con el historial deshecho del todo, el ancla se recupera y la rama entra limpia', () => {
    const s = new ProjectStore();
    s.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'local' });
    s.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'local' });
    s.undo('local');
    s.dispatch({ type: 'setTimeSig', timeSig: { num: 6, den: 8 } }, { origin: 'local' });
    const rama = primeraRama(s)!;

    // Se deshace todo lo nuestro: el ancla está en el futuro, pero sigue ahí.
    vaciar(s, 'local');

    // Se alcanza con un redo y la rama entra con SU camino, no mezclado.
    expect(s.switchToBranch(rama)).toBe(1);
    expect(s.project.tempo).toBe(100);
    expect(s.project.swing).toBeCloseTo(0.3);
    expect(s.project.timeSig).toEqual({ num: 4, den: 4 });
  });
  it('undo/redo sigue coherente después de un cambio de rama', () => {
    const s = new ProjectStore();
    s.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'local' });
    s.dispatch({ type: 'setSwing', swing: 0.3 }, { origin: 'local' });
    s.undo('local');
    s.dispatch({ type: 'setTimeSig', timeSig: { num: 6, den: 8 } }, { origin: 'local' });
    const rama = primeraRama(s)!;
    expect(s.switchToBranch(rama)).toBe(1);

    // Un Ctrl+Z normal deshace lo último que se aplicó (el swing de la rama) y un
    // redo lo vuelve a poner: el switch no rompe la pila.
    expect(s.undo('local')).toBe(true);
    expect(s.project.swing).toBeCloseTo(0);
    expect(s.redo('local')).toBe(true);
    expect(s.project.swing).toBeCloseTo(0.3);
  });
});