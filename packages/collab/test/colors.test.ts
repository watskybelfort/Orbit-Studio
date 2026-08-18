/**
 * Colores de los colaboradores: que tres personas en una sala no acaben del
 * mismo color por entrar todas con el nombre por defecto.
 */

import { describe, expect, it } from 'vitest';
import { USER_COLORS, colorForName, pickDistinctColor } from '../src/colors';

describe('colorForName', () => {
  it('el mismo nombre da siempre el mismo color', () => {
    expect(colorForName('Ana')).toBe(colorForName('Ana'));
    expect(USER_COLORS).toContain(colorForName('Ana'));
  });

  it('nombres distintos suelen dar colores distintos', () => {
    expect(colorForName('Ana')).not.toBe(colorForName('Productor'));
  });
});

describe('pickDistinctColor', () => {
  const C = USER_COLORS;

  it('sin conflicto no cambia nada', () => {
    expect(pickDistinctColor({ clientId: 7, color: C[0]! }, [{ clientId: 2, color: C[1]! }])).toBe(
      C[0],
    );
  });

  it('el de clientId más bajo se queda con el color', () => {
    // El de arriba no se mueve…
    expect(pickDistinctColor({ clientId: 2, color: C[0]! }, [{ clientId: 7, color: C[0]! }])).toBe(
      C[0],
    );
    // …y el de abajo se aparta.
    expect(pickDistinctColor({ clientId: 7, color: C[0]! }, [{ clientId: 2, color: C[0]! }])).not.toBe(
      C[0],
    );
  });

  it('se aparta al primer hueco libre', () => {
    const others = [
      { clientId: 1, color: C[0]! },
      { clientId: 2, color: C[1]! },
    ];
    expect(pickDistinctColor({ clientId: 9, color: C[0]! }, others)).toBe(C[2]);
  });

  it('una sala entera con el mismo nombre acaba con todos de colores distintos', () => {
    // Seis personas entran como "Productor": mismo color de salida para todas.
    const ids = [11, 22, 33, 44, 55, 66];
    const room = ids.map((clientId) => ({ clientId, color: colorForName('Productor') }));

    // Cada cliente decide por su cuenta mirando la presencia; se repite hasta
    // que nadie se mueva (así se comprueba que converge, no solo que reparte).
    let moved = true;
    let rounds = 0;
    while (moved && rounds < 10) {
      moved = false;
      rounds++;
      for (const peer of room) {
        const next = pickDistinctColor(peer, room.filter((p) => p !== peer));
        if (next !== peer.color) {
          peer.color = next;
          moved = true;
        }
      }
    }

    expect(moved).toBe(false);
    expect(new Set(room.map((p) => p.color)).size).toBe(room.length);
  });

  it('con más gente que colores no se rompe: devuelve uno de la paleta', () => {
    const others = USER_COLORS.map((color, i) => ({ clientId: i + 1, color }));
    const color = pickDistinctColor({ clientId: 99, color: USER_COLORS[0]! }, others);
    expect(USER_COLORS).toContain(color);
  });
});
