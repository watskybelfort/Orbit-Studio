/**
 * Descubrimiento en la red local: quién más tiene Orbit abierto aquí.
 *
 * Un socket UDP en un grupo multicast con TTL 1 — no sale de la subred, a
 * propósito. Nada de servidor central ni de cuentas: la app ya es local
 * primero (el servidor de colaboración lo levanta la propia app), y esto es la
 * pieza que faltaba para no tener que dictarle a nadie un código por teléfono.
 *
 * Dos asimetrías deliberadas:
 *
 * - **Escuchar es siempre; anunciarse es opcional.** Escuchar no cuenta nada de
 *   ti y es lo que hace que te lleguen las invitaciones. Anunciarse manda tu
 *   nombre a toda la red local, y eso se pide.
 * - **Una invitación no entra en ninguna sala.** Llega, se enseña y el usuario
 *   decide. Un paquete UDP que hiciera que la app se uniera sola sería un botón
 *   que puede pulsar cualquiera que esté en el mismo wifi.
 *
 * El parseo y el saneado de lo que llega viven en `discovery-protocol.ts`,
 * aparte y con tests.
 */

import { createSocket, type Socket } from 'node:dgram';
import {
  BEACON_INTERVAL_MS,
  DISCOVERY_GROUP,
  DISCOVERY_PORT,
  MULTICAST_TTL,
  cleanName,
  encodeMessage,
  isLanAddress,
  parseMessage,
  prunePeers,
  upsertPeer,
  type Invite,
  type Peer,
} from './discovery-protocol';

export interface DiscoveryHooks {
  /** La lista de vecinos ha cambiado (alguien apareció o se fue). */
  onPeers(peers: Peer[]): void;
  /** Ha llegado una invitación (ya validada). */
  onInvite(invite: Invite & { address: string }): void;
}

let socket: Socket | null = null;
let beaconTimer: ReturnType<typeof setInterval> | null = null;
let peers: Peer[] = [];
let hooks: DiscoveryHooks | null = null;

/** Identidad de ESTA instalación y el nombre con el que se anuncia. */
let selfId = '';
let selfName = '';
let announcing = false;

/** Última causa por la que el socket no está en marcha (para contarlo en la UI). */
let lastError: string | null = null;

export interface DiscoveryState {
  /** El socket está escuchando de verdad. */
  listening: boolean;
  /** Se está mandando la baliza. */
  announcing: boolean;
  name: string;
  error: string | null;
}

export function discoveryState(): DiscoveryState {
  return { listening: socket !== null, announcing, name: selfName, error: lastError };
}

export function knownPeers(): Peer[] {
  return peers;
}

function emitPeers(): void {
  hooks?.onPeers(peers);
}

/** Quita los que llevan rato callados; devuelve si la lista cambió. */
function pruneNow(): boolean {
  const next = prunePeers(peers, Date.now());
  if (next.length === peers.length) return false;
  peers = next;
  return true;
}

function sendBeacon(): void {
  if (!socket || !announcing) return;
  const payload = Buffer.from(encodeMessage({ kind: 'hello', id: selfId, name: selfName }));
  // El error se traga a posta: una red que va y viene (VPN levantándose, wifi
  // cambiando) haría fallar el envío, y eso no puede tumbar el proceso.
  socket.send(payload, DISCOVERY_PORT, DISCOVERY_GROUP, () => undefined);
}

/**
 * Levanta el socket. Es idempotente y NUNCA lanza: en una máquina sin red, con
 * el puerto ocupado o con el multicast capado por una VPN, la app tiene que
 * seguir arrancando igual — solo que sin esta función.
 */
export function startDiscovery(id: string, name: string, next: DiscoveryHooks): DiscoveryState {
  hooks = next;
  selfId = id;
  selfName = cleanName(name) || 'Orbit';
  if (socket) return discoveryState();

  try {
    const sock = createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('error', (err) => {
      lastError = err.message;
      // Un socket con error ya no sirve: se cierra y se deja el estado limpio
      // para poder reintentar cuando el usuario vuelva a darle.
      try {
        sock.close();
      } catch {
        // ya estaba cerrado
      }
      if (socket === sock) socket = null;
      emitPeers();
    });

    sock.on('message', (raw, rinfo) => {
      const msg = parseMessage(raw);
      if (!msg || msg.id === selfId) return; // el eco de uno mismo no cuenta
      if (msg.kind === 'hello') {
        peers = upsertPeer(peers, {
          id: msg.id,
          name: msg.name,
          address: rinfo.address,
          seenAt: Date.now(),
        });
        emitPeers();
        return;
      }
      hooks?.onInvite({ ...msg, address: rinfo.address });
    });

    sock.bind(DISCOVERY_PORT, () => {
      try {
        sock.setMulticastTTL(MULTICAST_TTL);
        sock.setMulticastLoopback(false);
        sock.addMembership(DISCOVERY_GROUP);
        lastError = null;
      } catch (err) {
        // Sin multicast (VPN, adaptador raro) el socket sigue valiendo para
        // recibir invitaciones directas: no se cierra, solo se avisa.
        lastError = err instanceof Error ? err.message : 'multicast no disponible';
      }
      sendBeacon();
    });

    socket = sock;
    beaconTimer = setInterval(() => {
      sendBeacon();
      if (pruneNow()) emitPeers();
    }, BEACON_INTERVAL_MS);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    socket = null;
  }
  return discoveryState();
}

/** Enciende o apaga la baliza (escuchar sigue igual). */
export function setAnnouncing(on: boolean, name?: string): DiscoveryState {
  if (name !== undefined) selfName = cleanName(name) || 'Orbit';
  announcing = on;
  if (on) sendBeacon();
  return discoveryState();
}

/**
 * Manda una invitación a una dirección concreta.
 *
 * `isLanAddress` no es paranoia de manual: la dirección puede venir de un amigo
 * escrito a mano, y sin la guarda el proceso principal mandaría paquetes UDP a
 * donde le digan desde el renderer.
 */
export function sendInvite(
  address: string,
  room: string,
  url: string,
  token?: string,
): { ok: boolean; error?: string } {
  if (!socket) return { ok: false, error: 'El descubrimiento no está en marcha.' };
  if (!isLanAddress(address)) {
    return { ok: false, error: `Solo se invita dentro de la red local (${address} no lo es).` };
  }
  const payload = Buffer.from(
    encodeMessage({
      kind: 'invite',
      id: selfId,
      name: selfName,
      room,
      url,
      ...(token ? { token } : null),
    }),
  );
  socket.send(payload, DISCOVERY_PORT, address, () => undefined);
  return { ok: true };
}

export function stopDiscovery(): void {
  if (beaconTimer) {
    clearInterval(beaconTimer);
    beaconTimer = null;
  }
  if (socket) {
    try {
      socket.close();
    } catch {
      // ya estaba cerrado
    }
    socket = null;
  }
  peers = [];
  announcing = false;
  hooks = null;
}
