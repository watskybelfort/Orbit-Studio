/**
 * El protocolo de "quién hay en esta red", sin sockets.
 *
 * Dos mensajes y ya: una BALIZA que dice "estoy aquí y me llamo así", y una
 * INVITACIÓN que dice "mi sala es esta". Van por UDP en la red local, así que
 * todo lo que llega viene de fuera y hay que tratarlo como tal: aquí está el
 * parseo, la validación y el saneado, aparte y con tests, porque es la única
 * frontera del programa a la que le puede escribir cualquiera.
 *
 * Lo que NO hace una invitación es entrar en ninguna sala. Es un aviso que el
 * usuario ve y decide; un paquete UDP que hiciera que la app se uniera sola
 * sería un botón que puede pulsar cualquiera del bar.
 */

import { isValidRoomCode, normalizeRoomCode, parseInviteToken } from '@orbit/collab';

/** Versión del protocolo: si no coincide, el paquete se ignora entero. */
export const DISCOVERY_VERSION = 1;

/** Grupo multicast y puerto. TTL 1: no sale de la subred, a propósito. */
export const DISCOVERY_GROUP = '239.255.77.90';
export const DISCOVERY_PORT = 47900;
export const MULTICAST_TTL = 1;

/** Cada cuánto se anuncia uno, y cuánto se le espera antes de darlo por ido. */
export const BEACON_INTERVAL_MS = 4000;
export const PEER_TTL_MS = 13_000;

/** Tope de lo que se acepta de fuera: un nombre no es un sitio para meter texto. */
export const MAX_NAME = 40;
/** Un paquete más largo que esto no es nuestro; se descarta sin parsear. */
export const MAX_PACKET = 512;

export interface Beacon {
  kind: 'hello';
  /** Id estable de esa instalación (no identifica a la persona, solo al equipo). */
  id: string;
  name: string;
}

export interface Invite {
  kind: 'invite';
  /** Quién invita. */
  id: string;
  name: string;
  /** Código de sala normalizado ("K3P9QF"). */
  room: string;
  /** URL del servidor de colaboración: ws:// o wss://, nada más. */
  url: string;
  /**
   * Token de invitación caducable, cuando la sala tiene contraseña.
   *
   * Con él, el invitado entra sin saber la contraseña; sin él, la sala se la
   * pedirá. Que un token viaje por el socket es el precio de una invitación de
   * un clic, y por eso los que se generan aquí son de UN uso y de vida corta:
   * un paquete capturado sirve para entrar una vez y durante un rato, no para
   * siempre — que es exactamente lo que pasaba compartiendo la contraseña.
   */
  token?: string;
}

export type DiscoveryMessage = Beacon | Invite;

/** Un peer visto en la red, con la última vez que dio señales. */
export interface Peer {
  id: string;
  name: string;
  address: string;
  seenAt: number;
}

/**
 * Deja un nombre en algo que se pueda pintar: sin controles, sin saltos de
 * línea y acotado. Lo que llega por la red acaba en una lista de la UI, y un
 * nombre con `\n` o de diez mil caracteres es la forma barata de romperla.
 */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = [...raw]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // Los controles se sustituyen por un espacio, no se quitan: un salto
      // de línea dentro de un nombre tiene que separar, no pegar dos palabras.
      return code < 0x20 || code === 0x7f ? ' ' : ch;
    })
    .join('');
  return flat.trim().slice(0, MAX_NAME);
}

/** Id: solo lo que puede salir de nanoid, y corto. */
function cleanId(raw: unknown): string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{4,32}$/.test(raw) ? raw : '';
}

/**
 * URL de un servidor de colaboración.
 *
 * Solo ws/wss y solo con host: una invitación es una URL que llega de fuera y
 * que la app va a abrir. Sin esta guarda, un paquete podría apuntar a
 * `file://` o a cualquier otro esquema y el que invita elegiría a qué se
 * conecta el invitado.
 */
export function cleanServerUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 200) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
    if (!url.hostname) return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** Serializa un mensaje para mandarlo. */
export function encodeMessage(msg: DiscoveryMessage): string {
  return JSON.stringify({ v: DISCOVERY_VERSION, ...msg });
}

/**
 * Parsea lo que llegó por el socket. `null` = no es nuestro, o no se sostiene.
 *
 * Nada de excepciones hacia fuera: un JSON roto en un puerto abierto a la red
 * local no puede tumbar el proceso principal.
 */
export function parseMessage(raw: string | Uint8Array): DiscoveryMessage | null {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  if (text.length === 0 || text.length > MAX_PACKET) return null;

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m['v'] !== DISCOVERY_VERSION) return null;

  const id = cleanId(m['id']);
  const name = cleanName(m['name']);
  if (id === '') return null;

  if (m['kind'] === 'hello') {
    return { kind: 'hello', id, name: name || 'Sin nombre' };
  }
  if (m['kind'] === 'invite') {
    const room = normalizeRoomCode(typeof m['room'] === 'string' ? m['room'] : '');
    const url = cleanServerUrl(m['url']);
    if (!isValidRoomCode(room) || url === '') return null;
    // Un token con forma rara no se reenvía a la sesión: mejor entrar pidiendo
    // la contraseña que mandarle basura a la puerta.
    const token = parseInviteToken(m['token']) === null ? undefined : (m['token'] as string);
    return {
      kind: 'invite',
      id,
      name: name || 'Alguien',
      room,
      url,
      ...(token ? { token } : null),
    };
  }
  return null;
}

/** Mete o refresca un peer en la lista. Devuelve la lista nueva. */
export function upsertPeer(peers: readonly Peer[], peer: Peer): Peer[] {
  const rest = peers.filter((p) => p.id !== peer.id);
  return [...rest, peer].sort((a, b) => a.name.localeCompare(b.name));
}

/** Quita los que llevan callados más de `PEER_TTL_MS`. */
export function prunePeers(peers: readonly Peer[], now: number): Peer[] {
  return peers.filter((p) => now - p.seenAt < PEER_TTL_MS);
}

/**
 * ¿Es una dirección de red local?
 *
 * Las invitaciones se mandan a una dirección que da el renderer, y aunque el
 * flujo normal la saca de un peer descubierto, un amigo se puede escribir a
 * mano. Sin esta guarda, la app sería un reflector: escribe una IP de
 * internet y el proceso principal le manda un paquete UDP por ti.
 */
export function isLanAddress(address: string): boolean {
  if (address === 'localhost') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b].some((n) => Number.isNaN(n) || n > 255)) return false;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }
  const v6 = address.toLowerCase();
  // ::1 y el rango único local (fc00::/7) y link-local (fe80::/10).
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}
