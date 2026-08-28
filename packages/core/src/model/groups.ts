/**
 * Carpetas del rack como BUSES de mezcla.
 *
 * La idea entera cabe en una frase: una carpeta no añade un nodo de audio, solo
 * declara a dónde va lo suyo. Aquí se traduce esa declaración a lo que el motor
 * ya sabe hacer —un canal en una pista, y una pista que desemboca en otra— para
 * que ni el protocolo ni el kernel aprendan un concepto nuevo. Todo son
 * funciones puras sobre el proyecto: sin React, sin comandos y sin motor.
 *
 * Cómo entra cada canal de la carpeta en el bus:
 *
 *  - **Sin pista propia** (`mixerTrack` 0, el Master, que es como nace un
 *    canal): entra DIRECTO en el bus. Es el caso normal —seis canales de
 *    batería y un solo strip para todos— y sale gratis: solo cambia el número
 *    de pista con el que se compila el canal.
 *  - **Con pista propia** (un insert suyo, con su EQ y su compresor): la pista
 *    conserva su cadena y lo que cambia es su SALIDA, que pasa a desembocar en
 *    el bus. Así el bombo sigue teniendo su EQ y además pasa por el compresor
 *    de la batería.
 *
 * Y dos límites, a propósito:
 *
 *  - Una pista **solo se reencamina si iba al Master**, que es su valor de
 *    fábrica. Si alguien la enrutó a mano a otro sitio, la carpeta no le pisa
 *    el cable: una decisión tomada con la mano gana a una automática.
 *  - Si dos carpetas se pelean por la misma pista (dos canales de carpetas
 *    distintas comparten strip), gana la PRIMERA en `channelGroupOrder`. Es
 *    arbitrario pero determinista, que es lo que importa para que dos clientes
 *    de una sala compilen lo mismo.
 *
 * **Carpetas anidadas: no.** `Channel.groupId` es un id suelto y no hay padre,
 * así que el rack es de un nivel. Anidar buses ya se puede —y con validación de
 * ciclos de verdad— en el sitio donde vive el enrutado: la pista de bus de la
 * batería se enruta a la pista de bus del ritmo desde el mixer. Meter un árbol
 * en el rack duplicaría esa validación en dos sitios sin dar nada nuevo.
 */

import type { Channel, ChannelGroup, Id, MixerTrack, Project } from './types';

/** Índice de pista válido dentro de un mixer. */
function inRange(index: number | undefined, tracks: readonly unknown[]): boolean {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < tracks.length;
}

/** Carpeta EFECTIVA de un canal: la que existe (un id colgado no cuenta). */
export function groupOf(project: Project, channel: Channel | undefined): ChannelGroup | undefined {
  if (!channel?.groupId) return undefined;
  return project.channelGroups[channel.groupId];
}

/**
 * Bus de una carpeta, ya recortado al mixer que hay. `null` = no tiene.
 *
 * El Master (0) NO cuenta como bus: es a donde va todo por defecto, así que
 * declararlo no agrupa nada y en cambio haría que el "fader de la carpeta"
 * fuera el fader general.
 */
export function groupBusTrack(project: Project, group: ChannelGroup | undefined): number | null {
  const bus = group?.busTrack;
  if (!inRange(bus, project.mixer) || bus === 0) return null;
  return bus as number;
}

/** Bus de la carpeta de un canal (null si está suelto o su carpeta no tiene). */
export function busOfChannel(project: Project, channelId: Id): number | null {
  return groupBusTrack(project, groupOf(project, project.channels[channelId]));
}

/** Enrutado que sale de las carpetas, listo para compilar. */
export interface GroupBusRouting {
  /** Canal → pista de mixer efectiva. Solo los canales que el bus mueve. */
  channels: Map<Id, number>;
  /** Pista → `routeTo` efectivo. Solo las pistas que un bus reencamina. */
  routes: Map<number, number>;
}

const EMPTY_ROUTING: GroupBusRouting = { channels: new Map(), routes: new Map() };

/** Salidas de una pista con los reencaminados de carpeta ya aplicados. */
function outputsOf(
  tracks: readonly MixerTrack[],
  routes: ReadonlyMap<number, number>,
  index: number,
): number[] {
  const track = tracks[index];
  if (!track) return [];
  const out = new Set<number>();
  const routeTo = routes.get(index) ?? track.routeTo;
  if (routeTo !== null && inRange(routeTo, tracks)) out.add(routeTo);
  for (const send of track.sends) {
    if (inRange(send.target, tracks)) out.add(send.target);
  }
  out.delete(index);
  return [...out];
}

/**
 * ¿Se llega de `from` a `target` siguiendo la señal? Se anda el grafo YA
 * resuelto (con los reencaminados que llevamos puestos), que es la única forma
 * de que dos carpetas no monten un bucle entre las dos sin que ninguna lo vea.
 */
function reaches(
  tracks: readonly MixerTrack[],
  routes: ReadonlyMap<number, number>,
  from: number,
  target: number,
): boolean {
  if (from === target) return true;
  const seen = new Set<number>([from]);
  const pending = [from];
  while (pending.length > 0) {
    const at = pending.pop()!;
    for (const next of outputsOf(tracks, routes, at)) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return false;
}

/**
 * Resuelve TODAS las carpetas con bus del proyecto a enrutado normal.
 *
 * Devuelve solo las diferencias: un proyecto sin carpetas con bus da dos mapas
 * vacíos y todo lo que lo consume (compilador, grafo, stems) se comporta
 * exactamente igual que antes de que esto existiera.
 */
export function resolveGroupBuses(project: Project): GroupBusRouting {
  if (project.channelGroupOrder.length === 0) return EMPTY_ROUTING;
  const tracks = project.mixer;
  const channels = new Map<Id, number>();
  const routes = new Map<number, number>();

  for (const groupId of project.channelGroupOrder) {
    const group = project.channelGroups[groupId];
    const bus = groupBusTrack(project, group);
    if (bus === null) continue;
    for (const channelId of project.channelOrder) {
      const channel = project.channels[channelId];
      if (!channel || channel.groupId !== groupId) continue;
      const own = inRange(channel.mixerTrack, tracks) ? channel.mixerTrack : 0;
      if (own === bus) continue; // ya está en el bus: nada que hacer
      if (own === 0) {
        // Sin pista propia: el canal se compila directamente en el bus.
        channels.set(channelId, bus);
        continue;
      }
      // Con pista propia: se conserva su cadena y lo que cambia es su salida.
      if (routes.has(own)) continue; // otra carpeta llegó antes a esta pista
      const track = tracks[own];
      // Solo se toma la pista que iba al Master: un cable puesto a mano manda.
      if (!track || track.routeTo !== 0) continue;
      // Y nunca si con eso la señal se mordería la cola.
      if (reaches(tracks, routes, bus, own)) continue;
      routes.set(own, bus);
    }
  }

  if (channels.size === 0 && routes.size === 0) return EMPTY_ROUTING;
  return { channels, routes };
}

/**
 * Pistas de mixer que son bus de alguna carpeta, con la carpeta que las usa.
 * Si dos carpetas declaran la misma, se queda la primera (la que también gana
 * al reencaminar).
 */
export function busTracks(project: Project): Map<number, ChannelGroup> {
  const out = new Map<number, ChannelGroup>();
  for (const groupId of project.channelGroupOrder) {
    const group = project.channelGroups[groupId];
    const bus = groupBusTrack(project, group);
    if (bus === null || !group || out.has(bus)) continue;
    out.set(bus, group);
  }
  return out;
}

// ── Mute / solo de carpeta ───────────────────────────────────────────────────
//
// La carpeta lleva sus propios flags y NO se los copia a sus canales: apagar la
// percusión entera y volver tiene que dejar a cada canal con el mute que tenía.
// Un canal está en solo si lo está él O su carpeta, y muteado si lo está él O
// su carpeta; el solo sigue ganando al mute, como en todo el resto de la app.

/** ¿Este canal está en solo, por sí mismo o por su carpeta? */
export function channelSoloOn(project: Project, channel: Channel): boolean {
  if (channel.solo) return true;
  return groupOf(project, channel)?.solo === true;
}

/** ¿Este canal está muteado, por sí mismo o por su carpeta? */
export function channelMuteOn(project: Project, channel: Channel): boolean {
  if (channel.mute) return true;
  return groupOf(project, channel)?.mute === true;
}

/**
 * ¿Hay algún solo activo en el rack?
 *
 * Se cuenta por CANALES y no por flags: una carpeta vacía en solo no enmudece
 * el proyecto entero, que es lo que pasaría si el solo de la carpeta contara
 * por su cuenta.
 */
export function anyChannelSoloOn(project: Project): boolean {
  for (const id of project.channelOrder) {
    const channel = project.channels[id];
    if (channel && channelSoloOn(project, channel)) return true;
  }
  return false;
}

/** ¿Suena este canal? `anySolo` se calcula una vez con `anyChannelSoloOn`. */
export function channelAudible(project: Project, channel: Channel, anySolo: boolean): boolean {
  return anySolo ? channelSoloOn(project, channel) : !channelMuteOn(project, channel);
}

// ── Elegir una pista para hacerla bus ────────────────────────────────────────

/**
 * Primera pista de mixer libre para estrenarla como bus: sin canales dentro,
 * sin carriles de audio, sin efectos, sin envíos, sin nada que la reciba y sin
 * ser ya el bus de otra carpeta. `null` si el mixer está lleno.
 *
 * Vive aquí y no en la UI porque la elección tiene que ser la misma la haga
 * quien la haga —el rack, la paleta o Claude por MCP—: si cada uno cuenta las
 * pistas ocupadas a su manera, dos caminos distintos estrenan la misma.
 */
export function freeBusTrack(project: Project): number | null {
  const taken = new Set<number>([0]);
  for (const id of project.channelOrder) {
    const track = project.channels[id]?.mixerTrack;
    if (inRange(track, project.mixer)) taken.add(track as number);
  }
  for (const lane of Object.values(project.playlistTracks)) {
    if (inRange(lane.mixerTrack, project.mixer)) taken.add(lane.mixerTrack as number);
  }
  for (const bus of busTracks(project).keys()) taken.add(bus);
  project.mixer.forEach((track, i) => {
    if (track.slots.some((s) => s !== null) || track.sends.length > 0) taken.add(i);
    if (i !== 0 && track.routeTo !== 0) taken.add(i);
    for (const target of outputsOf(project.mixer, EMPTY_ROUTING.routes, i)) {
      if (i !== 0) taken.add(target);
    }
  });
  for (let i = 1; i < project.mixer.length; i++) {
    if (!taken.has(i)) return i;
  }
  return null;
}
