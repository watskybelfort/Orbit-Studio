/**
 * Historial en ÁRBOL: lo que se abandona al divergir se guarda como rama.
 *
 * El undo clásico es una lista: deshaces cinco pasos, tocas cualquier cosa y
 * esos cinco se BORRAN. Aquí no. El tronco sigue siendo el par de pilas de
 * `ProjectStore` (undoStack = pasado, redoStack = futuro) — o sea, el camino
 * que tienes ahora mismo "sacado" — y todo lo que un `dispatch` habría tirado
 * se archiva como `HistoryBranch`, colgada del punto del tronco donde se bifurcó.
 *
 *   raíz ──A──B──C──D          (tronco: lo aplicado + lo rehacible)
 *             └──X──Y          (rama abandonada, colgada de B)
 *                 └──Z         (rama colgada de X, que vive DENTRO de otra rama)
 *
 * Volver a una rama es cambiar de camino, no "restaurar una copia": el tronco
 * que dejas atrás se archiva a su vez, así que la operación es simétrica y
 * nunca pierde nada. Por eso una rama puede colgar de una entrada que hoy vive
 * dentro de otra rama: para llegar a `Z` hay que pasar antes por `X` — eso es
 * lo que calcula `branchChain`.
 *
 * Este módulo es puro: no toca el store, solo razona sobre la forma del árbol.
 * Las pilas las mueve `ProjectStore` (ver `switchToBranch`).
 */

import type { HistoryEntry, HistoryView } from './store';

/**
 * Una rama abandonada tal como la guarda el store, con sus comandos.
 *
 * Sus `entries` están en **orden de aplicación** y en forma de redo (igual que
 * el `redoStack`: `entry.inverse` es lo que hay que aplicar para rehacerla),
 * porque de ahí salieron.
 */
export interface HistoryBranch {
  id: string;
  /**
   * Entrada tras la que diverge esta rama. `null` = diverge del estado
   * inicial. Puede apuntar a una entrada del tronco o a una que hoy está
   * dentro de OTRA rama (una bifurcación de una bifurcación).
   */
  anchorId: string | null;
  /** Origen de TODAS sus entradas: una rama nunca mezcla orígenes. */
  origin: string;
  /** Cuándo se abandonó. */
  at: number;
  /** Sus cambios, en orden de aplicación. */
  entries: HistoryEntry[];
}

/** Un paso de una rama, sin comandos crudos (para pintarlo). */
export interface HistoryBranchStep {
  id: string;
  label: string;
  at: number;
}

/** Una rama tal como la ve el panel. */
export interface HistoryBranchItem {
  id: string;
  /** Etiqueta del primer cambio de la rama: es lo que la identifica. */
  label: string;
  /** 'local' | 'claude' (nunca 'remote:*', ver `isBranchableOrigin`). */
  origin: string;
  /** Cuándo se abandonó. */
  at: number;
  /** Cuántos cambios tiene. */
  size: number;
  anchorId: string | null;
  /**
   * Cuántas entradas del tronco quedan aplicadas en el punto de bifurcación —
   * la misma escala que `HistoryView.present`, así el panel puede alinear la
   * rama con su fila. `-1` si el ancla no está en el tronco (cuelga de otra
   * rama, o se perdió).
   */
  anchorIndex: number;
  /** Etiqueta de la entrada de la que cuelga (`null` = estado inicial). */
  anchorLabel: string | null;
  /** Sus cambios, para desplegarla. */
  steps: HistoryBranchStep[];
  /** ¿Se puede volver a ella ahora mismo? */
  reachable: boolean;
  /** 0 = cuelga del tronco · 1 = cuelga de una rama · 2 = de una rama de una rama… */
  depth: number;
}

/** El historial entero: el tronco de `historyView()` + las ramas guardadas. */
export interface HistoryTreeView extends HistoryView {
  branches: HistoryBranchItem[];
}

/**
 * ¿Se archivan las ramas de este origen?
 *
 * NO para `remote:*`, y es una decisión de diseño, no un olvido: en una sala,
 * `CommandLogBinding` solo anexa al log compartido los comandos cuyo origen NO
 * empieza por `remote:` (los remotos ya venían de ahí). Si dejáramos volver a
 * una rama de otro usuario, sus comandos se re-aplicarían en MI proyecto sin
 * llegar al log — y mi cliente se saldría del estado de la sala en silencio.
 * El árbol de cada uno vive en su máquina; ver `docs/HISTORY.md`.
 */
export function isBranchableOrigin(origin: string): boolean {
  return !origin.startsWith('remote:');
}

/** La rama con ese id, si sigue archivada. */
export function findBranch(
  branches: readonly HistoryBranch[],
  id: string,
): HistoryBranch | undefined {
  return branches.find((b) => b.id === id);
}

/** La rama que contiene esa entrada (para anclas que no están en el tronco). */
export function branchContaining(
  branches: readonly HistoryBranch[],
  entryId: string,
): HistoryBranch | undefined {
  return branches.find((b) => b.entries.some((e) => e.id === entryId));
}

/**
 * Las ramas que hay que restaurar, EN ORDEN, para llegar a `targetId`.
 *
 * Casi siempre es una sola (`[rama]`): su ancla está en el tronco y se vuelve
 * de un salto. Si el ancla vive dentro de otra rama, hay que sacar antes esa
 * otra, y así hasta tocar tronco: `[abuela, madre, objetivo]`.
 *
 * `null` = no se llega: la rama no existe, o su cadena de anclas se rompió
 * (el tope de historial se comió la entrada de la que colgaba).
 *
 * El grafo de anclas es acíclico por construcción — una rama solo puede
 * anclarse a entradas que ya existían cuando se creó — pero el `seen` está
 * igualmente: un ciclo aquí sería un bucle infinito en el hilo de la UI.
 */
export function branchChain(
  branches: readonly HistoryBranch[],
  targetId: string,
  inTrunk: (entryId: string) => boolean,
): HistoryBranch[] | null {
  const chain: HistoryBranch[] = [];
  const seen = new Set<string>();
  let branch = findBranch(branches, targetId);
  while (branch) {
    if (seen.has(branch.id)) return null;
    seen.add(branch.id);
    chain.unshift(branch);
    if (branch.anchorId === null || inTrunk(branch.anchorId)) return chain;
    const owner = branchContaining(branches, branch.anchorId);
    if (!owner) return null;
    branch = owner;
  }
  return null;
}

/** ¿Se puede volver a esta rama ahora mismo? */
export function isBranchReachable(
  branches: readonly HistoryBranch[],
  id: string,
  inTrunk: (entryId: string) => boolean,
): boolean {
  return branchChain(branches, id, inTrunk) !== null;
}

/**
 * Monta la vista del árbol: el tronco tal cual lo da `historyView()` más las
 * ramas resueltas (dónde cuelgan, a qué profundidad y si se puede volver).
 *
 * Orden de las ramas: por punto de bifurcación (las que salen de más abajo
 * primero) y, a igualdad, la más reciente arriba. Las inalcanzables al final,
 * que son las que ya no se pueden usar para nada.
 */
export function buildTreeView(
  view: HistoryView,
  branches: readonly HistoryBranch[],
): HistoryTreeView {
  const index = new Map<string, number>();
  view.entries.forEach((e, i) => index.set(e.id, i));

  // El panel se repinta en CADA cambio del proyecto (una perilla arrastrada son
  // ~60 por segundo), así que los índices se montan una vez y no se vuelve a
  // escanear nada: `branchChain` a pelo escanearía todas las ramas por cada
  // rama, y con el archivo lleno eso se nota en el hilo de la UI.
  const owner = new Map<string, HistoryBranch>();
  for (const b of branches) for (const e of b.entries) owner.set(e.id, b);

  /** Longitud de la cadena de ramas hasta el tronco; null = no se llega. */
  const depthOf = (start: HistoryBranch): number | null => {
    const seen = new Set<string>();
    let branch: HistoryBranch | undefined = start;
    let depth = 0;
    while (branch) {
      if (seen.has(branch.id)) return null;
      seen.add(branch.id);
      if (branch.anchorId === null || index.has(branch.anchorId)) return depth;
      branch = owner.get(branch.anchorId);
      depth++;
    }
    return null;
  };

  const items: HistoryBranchItem[] = branches.map((b) => {
    const depth = depthOf(b);
    const trunkAt = b.anchorId === null ? undefined : index.get(b.anchorId);
    // `present` cuenta entradas aplicadas, así que el punto de bifurcación es
    // "índice + 1": la misma escala con la que el panel alinea el presente.
    const anchorIndex = b.anchorId === null ? 0 : trunkAt === undefined ? -1 : trunkAt + 1;
    const anchorLabel =
      b.anchorId === null
        ? null
        : trunkAt !== undefined
          ? (view.entries[trunkAt]?.label ?? null)
          : (owner
              .get(b.anchorId)
              ?.entries.find((e) => e.id === b.anchorId)?.label ?? null);
    return {
      id: b.id,
      label: b.entries[0]?.label ?? 'Rama vacía',
      origin: b.origin,
      at: b.at,
      size: b.entries.length,
      anchorId: b.anchorId,
      anchorIndex,
      anchorLabel,
      steps: b.entries.map(toStep),
      reachable: depth !== null,
      depth: depth ?? 0,
    };
  });

  items.sort((a, b) => {
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    if (a.anchorIndex !== b.anchorIndex) return a.anchorIndex - b.anchorIndex;
    return b.at - a.at;
  });

  return { entries: view.entries, present: view.present, branches: items };
}

function toStep(e: HistoryEntry): HistoryBranchStep {
  return { id: e.id, label: e.label, at: e.at };
}
