/**
 * Cómo se LEE el árbol del historial (sin React, para poder probarlo).
 *
 * `HistoryTreeView` de core dice la forma del árbol; aquí se traduce a filas
 * con su texto ya montado: de dónde sale la rama, cuántos cambios tiene, de
 * quién son, cuánto hace que se abandonó, y dónde cae la bifurcación en el
 * tronco (para el mini-diagrama). El `.tsx` hermano solo dibuja esto.
 *
 * Se prueba en `packages/ui/test/history-branches.test.ts`.
 */

import type { HistoryTreeView } from '@orbit/core';

export type OriginKind = 'local' | 'claude' | 'remote';

/** Un paso de una rama, ya con su hora escrita. */
export interface BranchStepRow {
  id: string;
  label: string;
  time: string;
}

/** Una rama lista para pintar. */
export interface BranchRow {
  id: string;
  /** Lo que la identifica: la etiqueta de su primer cambio. */
  title: string;
  /** «sale de "Tempo → 110 BPM"» o «sale del estado inicial». */
  from: string;
  /** "4 cambios · hace 3 min". */
  meta: string;
  /** Quién los hizo: "Tú", "Claude"… */
  who: string;
  kind: OriginKind;
  size: number;
  /** 0 = cuelga del tronco · 1 = cuelga de otra rama · … (indentación). */
  depth: number;
  reachable: boolean;
  /** Su bifurcación es el presente: volver aquí es un solo salto. */
  atPresent: boolean;
  /** 0..1 — a qué altura del tronco se bifurca (barra del mini-diagrama). */
  forkFraction: number;
  steps: BranchStepRow[];
  /** Texto del botón de volver, que cambia si la rama está fuera de alcance. */
  action: string;
}

/** Cabecera de la sección: cuántas ramas y cuántos cambios hay a salvo. */
export interface BranchesSummary {
  /** "2 ramas guardadas" / "Sin ramas guardadas". */
  title: string;
  /** "7 cambios que el undo normal habría borrado" (vacío si no hay ramas). */
  detail: string;
  count: number;
  /** Total de cambios archivados. */
  changes: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 'local' → Tú · 'claude' → Claude · 'remote:ana' → ana. */
export function originName(origin: string): string {
  if (origin === 'local') return 'Tú';
  if (origin === 'claude') return 'Claude';
  if (origin.startsWith('remote:')) return origin.slice('remote:'.length) || 'Remoto';
  return origin;
}

/** Familia del origen: decide el color del punto, como en el tronco. */
export function originKind(origin: string): OriginKind {
  if (origin === 'local') return 'local';
  if (origin === 'claude') return 'claude';
  return 'remote';
}

/** "ahora mismo" · "hace 4 min" · "hace 2 h" · la hora si ya es de otro rato. */
export function relativeTime(at: number, now: number): string {
  const delta = now - at;
  if (delta < MINUTE) return 'ahora mismo';
  if (delta < HOUR) return `hace ${Math.floor(delta / MINUTE)} min`;
  if (delta < 6 * HOUR) return `hace ${Math.floor(delta / HOUR)} h`;
  return clockTime(at);
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Traduce el árbol de core a filas pintables. */
export function branchRows(tree: HistoryTreeView, now = Date.now()): BranchRow[] {
  const trunk = tree.entries.length;
  return tree.branches.map((b) => ({
    id: b.id,
    title: b.label,
    from:
      b.anchorLabel === null
        ? 'sale del estado inicial'
        : `sale de «${b.anchorLabel}»`,
    meta: `${plural(b.size, 'cambio', 'cambios')} · ${relativeTime(b.at, now)}`,
    who: originName(b.origin),
    kind: originKind(b.origin),
    size: b.size,
    depth: b.depth,
    reachable: b.reachable,
    atPresent: b.reachable && b.anchorIndex === tree.present,
    // Una rama sin ancla en el tronco (cuelga de otra rama) se dibuja al final
    // de la barra: no hay punto del tronco al que apuntar.
    forkFraction: trunk === 0 ? 0 : clamp01((b.anchorIndex < 0 ? trunk : b.anchorIndex) / trunk),
    steps: b.steps.map((s) => ({ id: s.id, label: s.label, time: clockTime(s.at) })),
    action: b.reachable ? 'Volver aquí' : 'Fuera de alcance',
  }));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** El resumen de la cabecera. */
export function branchesSummary(tree: HistoryTreeView): BranchesSummary {
  const count = tree.branches.length;
  const changes = tree.branches.reduce((sum, b) => sum + b.size, 0);
  if (count === 0) {
    return { title: 'Sin ramas guardadas', detail: '', count: 0, changes: 0 };
  }
  return {
    title: `${plural(count, 'rama guardada', 'ramas guardadas')}`,
    detail: `${plural(changes, 'cambio', 'cambios')} que el undo normal habría borrado`,
    count,
    changes,
  };
}

/**
 * ¿Hay que avisar de que el historial se reinició?
 *
 * `historyEpoch` sube cada vez que el proyecto se sustituye entero: cargar un
 * archivo, unirse a una sala o re-derivar tras un cambio simultáneo. Si el
 * epoch cambió y el tronco quedó vacío, el usuario merece saber por qué se le
 * ha quedado el panel en blanco en vez de pensar que se ha roto algo.
 * Devuelve null cuando no hay nada que decir.
 */
export function historyResetNotice(
  epoch: number,
  seenEpoch: number,
  trunkLength: number,
): string | null {
  if (epoch === seenEpoch) return null;
  if (trunkLength > 0) return null;
  return 'El historial se reinició: el proyecto se cargó de nuevo (archivo abierto, entrada a una sala o cambio simultáneo). Las ramas guardadas no sobreviven a eso.';
}
