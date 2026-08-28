/**
 * Lo que enseña el panel de ramas, probado sin React: `branch-rows.ts` toma la
 * vista de árbol de un ProjectStore DE VERDAD (no un mock: así el test también
 * protege que core siga dando lo que la UI espera) y devuelve filas de texto.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ProjectStore, type HistoryTreeView } from '@orbit/core';
import {
  branchRows,
  branchesSummary,
  historyResetNotice,
  originKind,
  originName,
  relativeTime,
} from '../src/history/branch-rows';

/** Store con una rama abandonada: 100 → [110, 120] descartados → 95. */
function conRama(): ProjectStore {
  const store = new ProjectStore();
  store.dispatch({ type: 'setTempo', tempo: 100 });
  store.dispatch({ type: 'setTempo', tempo: 110 });
  store.dispatch({ type: 'setTempo', tempo: 120 });
  store.undo();
  store.undo();
  store.dispatch({ type: 'setTempo', tempo: 95 });
  return store;
}

describe('branchRows', () => {
  it('describe de dónde sale la rama y qué lleva dentro', () => {
    const store = conRama();
    const [row, ...resto] = branchRows(store.historyTree());
    expect(resto).toHaveLength(0);
    expect(row!.title).toBe('Tempo → 110 BPM');
    expect(row!.from).toBe('sale de «Tempo → 100 BPM»');
    expect(row!.meta).toMatch(/^2 cambios · /);
    expect(row!.who).toBe('Tú');
    expect(row!.kind).toBe('local');
    expect(row!.size).toBe(2);
    expect(row!.depth).toBe(0);
    expect(row!.reachable).toBe(true);
    expect(row!.action).toBe('Volver aquí');
    expect(row!.steps.map((s) => s.label)).toEqual(['Tempo → 110 BPM', 'Tempo → 120 BPM']);
    expect(row!.steps[0]!.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it('marca la rama cuya bifurcación es el presente', () => {
    const store = conRama();
    // El presente es "95", que cuelga de "100" — el mismo punto que la rama.
    expect(branchRows(store.historyTree())[0]!.atPresent).toBe(false);
    // Volviendo a "100" sí coinciden: volver a la rama es un salto directo.
    store.undo();
    expect(branchRows(store.historyTree())[0]!.atPresent).toBe(true);
  });

  it('una rama del estado inicial lo dice con esas palabras', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.undo();
    store.dispatch({ type: 'setSwing', swing: 0.2 });
    expect(branchRows(store.historyTree())[0]!.from).toBe('sale del estado inicial');
    expect(branchRows(store.historyTree())[0]!.forkFraction).toBe(0);
  });

  it('la barra del mini-diagrama señala la altura de la bifurcación', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    store.dispatch({ type: 'setTempo', tempo: 110 });
    store.dispatch({ type: 'setTempo', tempo: 120 });
    store.undo();
    store.dispatch({ type: 'setTempo', tempo: 130 });
    // Tronco de 3 entradas, bifurcación tras la 2ª → 2/3.
    const row = branchRows(store.historyTree())[0]!;
    expect(row.forkFraction).toBeCloseTo(2 / 3);
  });

  it('una rama de Claude sale con su nombre y su color', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 }, { origin: 'claude' });
    store.undo('claude');
    store.dispatch({ type: 'setSwing', swing: 0.2 }, { origin: 'claude' });
    const row = branchRows(store.historyTree())[0]!;
    expect(row.who).toBe('Claude');
    expect(row.kind).toBe('claude');
  });

  it('una rama fuera de alcance se enseña pero no se ofrece', () => {
    const tree: HistoryTreeView = {
      entries: [{ id: 'A', label: 'A', origin: 'local', at: 0, done: true }],
      present: 1,
      branches: [
        {
          id: 'r',
          label: 'Perdida',
          origin: 'local',
          at: 0,
          size: 1,
          anchorId: 'ZZ',
          anchorIndex: -1,
          anchorLabel: null,
          steps: [{ id: 's', label: 'Perdida', at: 0 }],
          reachable: false,
          depth: 0,
        },
      ],
    };
    const row = branchRows(tree)[0]!;
    expect(row.reachable).toBe(false);
    expect(row.action).toBe('Fuera de alcance');
    expect(row.atPresent).toBe(false);
    // Sin ancla en el tronco, el punto se dibuja al final de la barra.
    expect(row.forkFraction).toBe(1);
  });

  it('sin ramas no hay filas', () => {
    const store = new ProjectStore();
    store.dispatch({ type: 'setTempo', tempo: 100 });
    expect(branchRows(store.historyTree())).toHaveLength(0);
  });
});

describe('branchesSummary', () => {
  it('cuenta ramas y cambios a salvo', () => {
    const s = branchesSummary(conRama().historyTree());
    expect(s.count).toBe(1);
    expect(s.changes).toBe(2);
    expect(s.title).toBe('1 rama guardada');
    expect(s.detail).toBe('2 cambios que el undo normal habría borrado');
  });

  it('sin ramas no promete nada', () => {
    const store = new ProjectStore();
    const s = branchesSummary(store.historyTree());
    expect(s.title).toBe('Sin ramas guardadas');
    expect(s.detail).toBe('');
    expect(s.count).toBe(0);
  });
});

describe('historyResetNotice', () => {
  it('avisa cuando el epoch cambió y el tronco quedó vacío', () => {
    expect(historyResetNotice(2, 1, 0)).toMatch(/historial se reinició/);
  });

  it('calla si el epoch no cambió, o si ya hay historial nuevo', () => {
    expect(historyResetNotice(1, 1, 0)).toBeNull();
    expect(historyResetNotice(2, 1, 3)).toBeNull();
  });

  it('el epoch sube al sustituir el proyecto, que es lo que dispara el aviso', () => {
    const store = conRama();
    const antes = store.historyEpoch;
    store.replaceProject(store.project);
    expect(store.historyEpoch).toBe(antes + 1);
    expect(historyResetNotice(store.historyEpoch, antes, store.historyView().entries.length))
      .toMatch(/historial se reinició/);
  });
});

describe('texto de apoyo', () => {
  it('originName y originKind', () => {
    expect(originName('local')).toBe('Tú');
    expect(originName('claude')).toBe('Claude');
    expect(originName('remote:ana')).toBe('ana');
    expect(originName('remote:')).toBe('Remoto');
    expect(originKind('local')).toBe('local');
    expect(originKind('claude')).toBe('claude');
    expect(originKind('remote:ana')).toBe('remote');
  });

  it('relativeTime va de "ahora mismo" al reloj', () => {
    const now = Date.parse('2026-08-28T18:00:00Z');
    expect(relativeTime(now - 5_000, now)).toBe('ahora mismo');
    expect(relativeTime(now - 4 * 60_000, now)).toBe('hace 4 min');
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('hace 2 h');
    expect(relativeTime(now - 30 * 3_600_000, now)).toMatch(/^\d{2}:\d{2}$/);
  });
});

/**
 * El .tsx se queda con el dibujo, pero hay tres cosas suyas que una regresión
 * silenciosa rompería sin que ningún test de aritmética se enterara: que el
 * botón llame a `switchToBranch` (y no a `jumpTo`, que es lo parecido y lo
 * incorrecto), que "Olvidar" llame a `dropBranch`, y que no haya un color
 * literal en el JSX (regla dura del repo: todo por tokens del tema).
 *
 * Montar el componente traería jsdom a un repo que hoy no lo necesita
 * (ver CLAUDE.md), así que se lee el CÓDIGO FUENTE de verdad.
 */
describe('HistoryBranches.tsx (código fuente)', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/history/HistoryBranches.tsx'),
    'utf8',
  );

  it('vuelve a la rama por switchToBranch y la tira por dropBranch', () => {
    expect(source).toContain('store.switchToBranch(row.id)');
    expect(source).toContain('store.dropBranch(row.id)');
  });

  it('lee el árbol del store, no una copia paralela', () => {
    expect(source).toContain('store.historyTree()');
    expect(source).toContain('store.historyEpoch');
  });

  it('no hardcodea colores: todo sale de los tokens del tema', () => {
    const jsx = source.slice(source.indexOf('export function HistoryBranches'));
    expect(jsx).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(jsx).not.toMatch(/\b(rgba?|hsla?)\(/);
  });
});
