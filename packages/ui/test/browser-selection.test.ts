/**
 * Selección múltiple del Browser.
 *
 * Los dos que importan de verdad están al final: que no se arrastre lo que el
 * filtro escondió, y que el grupo salga en el orden de la pantalla. Ese orden
 * es el que decide qué muestra va en qué tecla del keymap — barajarlo deja el
 * piano con las notas cambiadas de sitio, y eso no se ve: se descubre tocando.
 */

import { describe, expect, it } from 'vitest';
import {
  dragSetFor,
  orderedSelection,
  pruneSelection,
  selectOne,
  selectRange,
  toggleOne,
  EMPTY_SELECTION,
} from '../src/browser/selection';

const VISIBLE = ['a', 'b', 'c', 'd', 'e'];
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

describe('clic normal', () => {
  it('deja una sola y la pone de ancla', () => {
    const s = selectOne('c');
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
  });

  it('sustituye a lo que hubiera', () => {
    const s = selectOne('a');
    expect(ids(selectOne('e'))).toEqual(['e']);
    expect(ids(s)).toEqual(['a']); // el estado anterior no se toca
  });
});

describe('Ctrl/Cmd', () => {
  it('mete y saca', () => {
    let s = toggleOne(EMPTY_SELECTION, 'b');
    expect(ids(s)).toEqual(['b']);
    s = toggleOne(s, 'd');
    expect(ids(s)).toEqual(['b', 'd']);
    s = toggleOne(s, 'b');
    expect(ids(s)).toEqual(['d']);
  });

  it('mueve el ancla aunque saque', () => {
    const s = toggleOne(toggleOne(EMPTY_SELECTION, 'b'), 'b');
    expect(ids(s)).toEqual([]);
    expect(s.anchor).toBe('b');
  });
});

describe('Mayús', () => {
  it('coge el tramo entre el ancla y la que se pulsa', () => {
    const s = selectRange(selectOne('b'), VISIBLE, 'd');
    expect(ids(s)).toEqual(['b', 'c', 'd']);
  });

  it('funciona igual hacia arriba', () => {
    expect(ids(selectRange(selectOne('d'), VISIBLE, 'b'))).toEqual(['b', 'c', 'd']);
  });

  it('el ancla NO se mueve: se puede reabrir el tramo desde el mismo sitio', () => {
    const primera = selectRange(selectOne('b'), VISIBLE, 'e');
    expect(ids(primera)).toEqual(['b', 'c', 'd', 'e']);
    const segunda = selectRange(primera, VISIBLE, 'c');
    expect(ids(segunda)).toEqual(['b', 'c']);
    expect(segunda.anchor).toBe('b');
  });

  it('sin ancla es un clic normal', () => {
    expect(ids(selectRange(EMPTY_SELECTION, VISIBLE, 'c'))).toEqual(['c']);
  });

  it('con el ancla ya fuera de la vista, también', () => {
    const s = selectRange({ ids: new Set(['z']), anchor: 'z' }, VISIBLE, 'c');
    expect(ids(s)).toEqual(['c']);
  });

  it('sobre algo que no está a la vista no hace nada', () => {
    const antes = selectOne('b');
    expect(selectRange(antes, VISIBLE, 'zzz')).toBe(antes);
  });
});

describe('qué se arrastra', () => {
  it('tirar de una SELECCIONADA arrastra el grupo', () => {
    const s = selectRange(selectOne('b'), VISIBLE, 'd');
    expect(dragSetFor(s, VISIBLE, 'c')).toEqual(['b', 'c', 'd']);
  });

  it('tirar de una que NO lo está arrastra solo esa', () => {
    // El accidente que esto evita: quedaban veinte marcados de antes, tiras de
    // un sonido cualquiera y se te van los veinte al keymap.
    const s = selectRange(selectOne('b'), VISIBLE, 'd');
    expect(dragSetFor(s, VISIBLE, 'e')).toEqual(['e']);
  });

  it('el grupo sale EN EL ORDEN DE LA PANTALLA, no en el de selección', () => {
    // Ese orden es el que reparte las muestras por el teclado.
    let s = toggleOne(EMPTY_SELECTION, 'e');
    s = toggleOne(s, 'a');
    s = toggleOne(s, 'c');
    expect(dragSetFor(s, VISIBLE, 'a')).toEqual(['a', 'c', 'e']);
  });

  it('una selección que ya no se ve no bloquea el arrastre', () => {
    const s = { ids: new Set(['x', 'y']), anchor: 'x' };
    expect(dragSetFor(s, VISIBLE, 'x')).toEqual(['x']);
  });
});

describe('la selección no sobrevive al filtro', () => {
  it('lo que el filtro esconde sale de la selección', () => {
    // Marcabas diez, escribías en el buscador, y el contador seguía diciendo
    // diez mientras la pantalla enseñaba dos — y el arrastre se llevaba diez.
    const s = { ids: new Set(['a', 'c', 'zzz']), anchor: 'c' };
    const podada = pruneSelection(s, ['a', 'c']);
    expect(ids(podada)).toEqual(['a', 'c']);
    expect(podada.anchor).toBe('c');
  });

  it('el ancla escondida se suelta', () => {
    const podada = pruneSelection({ ids: new Set(['a']), anchor: 'zzz' }, ['a']);
    expect(podada.anchor).toBeNull();
  });

  it('si no sobra nada devuelve el MISMO objeto', () => {
    // Devolver uno nuevo en cada render repintaría el Browser entero sin parar.
    const s = selectOne('a');
    expect(pruneSelection(s, VISIBLE)).toBe(s);
  });

  it('quedarse sin nada a la vista deja la selección vacía', () => {
    const podada = pruneSelection({ ids: new Set(['a', 'b']), anchor: 'a' }, []);
    expect(ids(podada)).toEqual([]);
    expect(podada.anchor).toBeNull();
  });
});

describe('orden', () => {
  it('orderedSelection respeta la pantalla y descarta lo escondido', () => {
    const s = { ids: new Set(['e', 'b', 'zzz']), anchor: null };
    expect(orderedSelection(s, VISIBLE)).toEqual(['b', 'e']);
  });
});
