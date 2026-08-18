/**
 * El enrutado visto como un grafo: lo que pinta y valida el graph editor.
 *
 * La señal va por tres clases de arista y ninguna vive en el mismo sitio:
 * un canal declara su pista (`Channel.mixerTrack`), un carril de la playlist
 * declara la suya para el audio (`PlaylistTrack.mixerTrack`) y una pista de
 * mixer declara a dónde desemboca (`routeTo`) más sus envíos (`sends`). Aquí
 * se juntan las tres en una sola lista de aristas, se calcula en qué columna
 * cae cada pista y —lo importante— se comprueba si un cable nuevo cerraría un
 * bucle ANTES de enchufarlo: el compilador tolera los ciclos (los ordena por
 * índice y sigue), pero lo que suena entonces no es lo que nadie quería.
 *
 * Todo son funciones puras sobre el proyecto: sin React y sin comandos.
 */

import type { Id, MixerTrack, Project } from './types';

/** Cómo llega la señal de un nodo a otro. */
export type RoutingEdgeKind =
  /** Canal del rack → su pista de mixer. */
  | 'channel'
  /** Carril de la playlist (audio) → su pista de mixer. */
  | 'lane'
  /** Salida de una pista → la pista donde desemboca. */
  | 'route'
  /** Envío paralelo de una pista a otra. */
  | 'send';

export interface RoutingEdge {
  kind: RoutingEdgeKind;
  /** Origen: índice de pista ('route'/'send') o id del canal/carril. */
  from: number | Id;
  /** Destino: índice de pista de mixer. */
  to: number;
  /** Ganancia del envío (solo 'send'). */
  level?: number;
}

/** Índice de pista válido dentro del mixer del proyecto. */
function inRange(index: number, tracks: readonly unknown[]): boolean {
  return Number.isInteger(index) && index >= 0 && index < tracks.length;
}

/** Pista de un canal, ya recortada al mixer que hay (fuera de rango = master). */
export function trackOfChannel(project: Project, channelId: Id): number {
  const track = project.channels[channelId]?.mixerTrack ?? 0;
  return inRange(track, project.mixer) ? track : 0;
}

/** Salidas de una pista: su routeTo y sus envíos, sin repetir destino. */
export function outputsOf(tracks: readonly MixerTrack[], index: number): number[] {
  const track = tracks[index];
  if (!track) return [];
  const out = new Set<number>();
  if (track.routeTo !== null && inRange(track.routeTo, tracks)) out.add(track.routeTo);
  for (const send of track.sends) {
    if (inRange(send.target, tracks)) out.add(send.target);
  }
  out.delete(index); // un auto-cable no es una salida: es un bucle de un nodo
  return [...out];
}

/**
 * Todas las aristas del proyecto, en orden estable: primero los canales (en el
 * orden del rack), luego los carriles de audio, luego las salidas de cada
 * pista y sus envíos.
 */
export function routingEdges(project: Project): RoutingEdge[] {
  const edges: RoutingEdge[] = [];
  for (const id of project.channelOrder) {
    if (!project.channels[id]) continue;
    edges.push({ kind: 'channel', from: id, to: trackOfChannel(project, id) });
  }
  for (const track of Object.values(project.playlistTracks)) {
    const to = track.mixerTrack ?? 0;
    if (!inRange(to, project.mixer)) continue;
    edges.push({ kind: 'lane', from: track.id, to });
  }
  project.mixer.forEach((track, i) => {
    if (track.routeTo !== null && inRange(track.routeTo, project.mixer) && track.routeTo !== i) {
      edges.push({ kind: 'route', from: i, to: track.routeTo });
    }
    for (const send of track.sends) {
      if (!inRange(send.target, project.mixer) || send.target === i) continue;
      edges.push({ kind: 'send', from: i, to: send.target, level: send.level });
    }
  });
  return edges;
}

/**
 * ¿Enchufar la salida de `from` a `to` cerraría un bucle? Se responde
 * andando el grafo DESDE `to`: si por ahí se vuelve a `from`, la señal se
 * mordería la cola. Enchufarse a uno mismo también cuenta.
 */
export function wouldLoop(tracks: readonly MixerTrack[], from: number, to: number): boolean {
  if (!inRange(from, tracks) || !inRange(to, tracks)) return false;
  if (from === to) return true;
  const seen = new Set<number>([to]);
  const pending = [to];
  while (pending.length > 0) {
    const at = pending.pop()!;
    for (const next of outputsOf(tracks, at)) {
      if (next === from) return true;
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

/**
 * Columna de cada pista para el layout: 0 las que no reciben nada y, a partir
 * de ahí, una más que la más profunda de las que le entran (camino más largo,
 * así el master queda a la derecha del todo). Las pistas atrapadas en un ciclo
 * —que el modelo permite guardar— se quedan en la columna 0 en vez de colgar
 * el cálculo.
 */
export function trackColumns(tracks: readonly MixerTrack[]): number[] {
  const n = tracks.length;
  const outs = tracks.map((_, i) => outputsOf(tracks, i));
  const indeg = new Array<number>(n).fill(0);
  for (const targets of outs) for (const t of targets) indeg[t]!++;

  const columns = new Array<number>(n).fill(0);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const next of outs[at]!) {
      columns[next] = Math.max(columns[next]!, columns[at]! + 1);
      if (--indeg[next]! === 0) queue.push(next);
    }
  }
  // Las pistas atrapadas en un ciclo nunca entran en la cola: se quedan en la
  // columna que hubieran alcanzado (0 si no las alimenta nadie de fuera). Se
  // pintan igual — el grafo enseña el bucle mejor que cualquier aviso.
  return columns;
}

/** Canales que entran en cada pista, en el orden del rack. */
export function channelsByTrack(project: Project): Map<number, Id[]> {
  const map = new Map<number, Id[]>();
  for (const id of project.channelOrder) {
    if (!project.channels[id]) continue;
    const track = trackOfChannel(project, id);
    const list = map.get(track);
    if (list) list.push(id);
    else map.set(track, [id]);
  }
  return map;
}

/**
 * Pistas que vale la pena enseñar: el master, las que tienen algo dentro
 * (canales, audio, efectos, envíos), las que no van al master y las que
 * reciben de otra. El resto son 25 inserts vacíos que solo hacen ruido.
 */
export function usedTracks(project: Project): number[] {
  const used = new Set<number>([0]);
  for (const id of project.channelOrder) {
    if (project.channels[id]) used.add(trackOfChannel(project, id));
  }
  for (const lane of Object.values(project.playlistTracks)) {
    const to = lane.mixerTrack ?? 0;
    if (inRange(to, project.mixer)) used.add(to);
  }
  project.mixer.forEach((track, i) => {
    const tocada =
      track.sends.length > 0 ||
      track.slots.some((slot) => slot !== null) ||
      (i !== 0 && track.routeTo !== 0);
    if (tocada) {
      used.add(i);
      for (const target of outputsOf(project.mixer, i)) used.add(target);
    }
  });
  return [...used].sort((a, b) => a - b);
}
