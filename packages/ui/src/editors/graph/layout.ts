/**
 * Colocación del graph editor: del proyecto a cajas y cables con coordenadas.
 *
 * Va aparte del componente y sin React a propósito — es geometría pura y se
 * puede probar: las pistas se reparten por columnas según lo lejos que estén
 * del master (`trackColumns` de @orbit/core) y las fuentes (canales del rack y
 * carriles de audio) se apilan a la izquierda AGRUPADAS por la pista en la que
 * entran, en el mismo orden vertical que sus pistas. Así los cables salen
 * cortos y sin cruces gratuitos, que es lo único que hace legible un grafo.
 */

import {
  channelsByTrack,
  routingEdges,
  trackColumns,
  usedTracks,
  type Id,
  type Project,
  type RoutingEdgeKind,
  type ResolvedSend,
} from '@orbit/core';

export interface GraphNode {
  /** Clave única: `ch:<id>`, `lane:<id>` o `trk:<índice>`. */
  key: string;
  kind: 'channel' | 'lane' | 'track';
  label: string;
  color: string;
  /** Canal/carril: su id. Pista: su índice en `project.mixer`. */
  ref: Id | number;
  /** Segunda línea (efectos de la cadena, destino…). */
  detail: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLink {
  key: string;
  kind: RoutingEdgeKind;
  from: GraphNode;
  to: GraphNode;
  /** Ganancia del envío (solo 'send'). */
  level?: number;
  /** Cómo es el envío: de dónde toma, qué parte lleva, polaridad (solo 'send'). */
  send?: ResolvedSend;
}

export interface GraphLayout {
  nodes: GraphNode[];
  links: GraphLink[];
  /** Tamaño total del lienzo (para el scroll y el "ajustar"). */
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** Enseñar también los inserts vacíos que nadie usa. */
  showAllTracks: boolean;
}

export const SOURCE_W = 168;
export const SOURCE_H = 38;
export const TRACK_W = 190;
export const TRACK_H = 56;
export const COL_GAP = 96;
export const ROW_GAP = 14;
export const MARGIN = 24;

const COLUMN_W = TRACK_W + COL_GAP;

/** dB legibles de una ganancia lineal (para el detalle de la caja). */
function db(gain: number): string {
  if (gain <= 0.0001) return '-inf';
  const v = 20 * Math.log10(gain);
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
}

/** Resumen de la cadena de efectos de una pista. */
function chainOf(slots: readonly ({ kind: string; enabled: boolean } | null)[]): string {
  const used = slots.filter((s): s is { kind: string; enabled: boolean } => s !== null);
  if (used.length === 0) return '';
  const names = used.slice(0, 3).map((s) => (s.enabled ? s.kind : `(${s.kind})`));
  return used.length > 3 ? `${names.join(' · ')} +${used.length - 3}` : names.join(' · ');
}

export function layoutGraph(project: Project, opts: LayoutOptions): GraphLayout {
  const visible = opts.showAllTracks ? project.mixer.map((_, i) => i) : usedTracks(project);
  const visibleSet = new Set(visible);
  const columns = trackColumns(project.mixer);
  const minColumn = visible.reduce((min, i) => Math.min(min, columns[i] ?? 0), Number.MAX_SAFE_INTEGER);

  // ── Pistas: una columna por profundidad, apiladas por índice ──────────────
  const nodes: GraphNode[] = [];
  const byKey = new Map<string, GraphNode>();
  /** Siguiente y libre de cada columna. */
  const nextY = new Map<number, number>();
  /** Orden vertical final de cada pista (para ordenar sus fuentes igual). */
  const trackOrder: number[] = [];

  for (const index of visible) {
    const track = project.mixer[index];
    if (!track) continue;
    const column = (columns[index] ?? 0) - minColumn + 1; // +1: la 0 es de fuentes
    const y = nextY.get(column) ?? MARGIN;
    const node: GraphNode = {
      key: `trk:${index}`,
      kind: 'track',
      label: track.name,
      color: track.color,
      ref: index,
      detail: chainOf(track.slots) || db(track.volume),
      x: MARGIN + column * COLUMN_W,
      y,
      w: TRACK_W,
      h: TRACK_H,
    };
    nextY.set(column, y + TRACK_H + ROW_GAP);
    nodes.push(node);
    byKey.set(node.key, node);
    trackOrder.push(index);
  }

  // ── Fuentes: canales del rack y carriles con audio, agrupados por destino ──
  // Se recorren las pistas en el orden en el que han quedado pintadas, así lo
  // que entra en la pista de arriba se dibuja arriba.
  const channels = channelsByTrack(project);
  const lanesWithAudio = new Map<number, Id[]>();
  for (const clip of Object.values(project.clips)) {
    if (clip.kind !== 'audio') continue;
    const lane = project.playlistTracks[clip.playlistTrackId];
    if (!lane) continue;
    const target = lane.mixerTrack ?? 0;
    const list = lanesWithAudio.get(target);
    if (!list) lanesWithAudio.set(target, [lane.id]);
    else if (!list.includes(lane.id)) list.push(lane.id);
  }

  let sourceY = MARGIN;
  const pushSource = (node: GraphNode) => {
    node.y = sourceY;
    sourceY += SOURCE_H + ROW_GAP;
    nodes.push(node);
    byKey.set(node.key, node);
  };

  for (const index of trackOrder) {
    for (const id of channels.get(index) ?? []) {
      const channel = project.channels[id];
      if (!channel) continue;
      pushSource({
        key: `ch:${id}`,
        kind: 'channel',
        label: channel.name,
        color: channel.color,
        ref: id,
        detail: channel.kind,
        x: MARGIN,
        y: 0,
        w: SOURCE_W,
        h: SOURCE_H,
      });
    }
    for (const id of lanesWithAudio.get(index) ?? []) {
      const lane = project.playlistTracks[id];
      if (!lane) continue;
      pushSource({
        key: `lane:${id}`,
        kind: 'lane',
        label: lane.name,
        color: lane.color,
        ref: id,
        detail: 'audio',
        x: MARGIN,
        y: 0,
        w: SOURCE_W,
        h: SOURCE_H,
      });
    }
  }

  // ── Cables ────────────────────────────────────────────────────────────────
  const links: GraphLink[] = [];
  for (const edge of routingEdges(project)) {
    const fromKey =
      edge.kind === 'channel'
        ? `ch:${String(edge.from)}`
        : edge.kind === 'lane'
          ? `lane:${String(edge.from)}`
          : `trk:${String(edge.from)}`;
    const from = byKey.get(fromKey);
    const to = byKey.get(`trk:${edge.to}`);
    // Un cable a una pista escondida (o desde una fuente que no se pinta) no
    // se dibuja: sería una línea que sale de la nada.
    if (!from || !to || !visibleSet.has(edge.to)) continue;
    const link: GraphLink = { key: `${edge.kind}:${fromKey}->${edge.to}`, kind: edge.kind, from, to };
    if (edge.level !== undefined) link.level = edge.level;
    if (edge.send !== undefined) link.send = edge.send;
    links.push(link);
  }

  const width = nodes.reduce((max, n) => Math.max(max, n.x + n.w), 0) + MARGIN;
  const height = nodes.reduce((max, n) => Math.max(max, n.y + n.h), 0) + MARGIN;
  return { nodes, links, width, height };
}
