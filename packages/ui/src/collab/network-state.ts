/**
 * Gente en la red local y amigos, en el renderer.
 *
 * El descubrimiento lo hace el main (es quien tiene sockets); aquí solo se
 * cachea lo que manda, se guardan los amigos y se recuerda la última
 * invitación recibida para poder enseñarla.
 *
 * Una invitación entrante NO se acepta sola. Se guarda y la UI ofrece el botón:
 * unirse a una sala reemplaza el proyecto abierto, así que un paquete que
 * llega por la red no puede decidirlo.
 */

import { create } from 'zustand';
import { requestInvite, useCollabStore } from './collab-state';

export interface NetPeer {
  id: string;
  name: string;
  address: string;
  seenAt: number;
}

export interface Friend {
  id: string;
  name: string;
  address: string;
}

export interface IncomingInvite {
  id: string;
  name: string;
  room: string;
  url: string;
  address: string;
  /** Invitación caducable: con ella se entra sin saber la contraseña. */
  token?: string;
  /** Cuándo llegó (para poder caducarla en la vista). */
  at: number;
}

interface NetworkState {
  /** El socket del main está en marcha. */
  listening: boolean;
  /** Se está anunciando en la red. */
  announcing: boolean;
  /** Motivo por el que el descubrimiento no va (sin red, multicast capado…). */
  error: string | null;
  peers: NetPeer[];
  friends: Friend[];
  /** La última invitación recibida, hasta que se acepte o se descarte. */
  invite: IncomingInvite | null;
  /** Aviso transitorio del propio panel ("Invitación enviada a Ana"). */
  notice: string | null;
}

export const useNetworkStore = create<NetworkState>(() => ({
  listening: false,
  announcing: false,
  error: null,
  peers: [],
  friends: [],
  invite: null,
  notice: null,
}));

/**
 * Vida del token que viaja en una invitación de la red local: media hora.
 *
 * Corta a propósito. El token va por el socket (es lo que distingue una
 * invitación de la contraseña, que nunca viaja), así que un paquete capturado
 * tiene que servir para poco: un uso, y durante un rato.
 */
const INVITE_TTL_MS = 30 * 60 * 1000;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function notify(notice: string): void {
  if (noticeTimer) clearTimeout(noticeTimer);
  useNetworkStore.setState({ notice });
  noticeTimer = setTimeout(() => useNetworkStore.setState({ notice: null }), 4000);
}

let unsubscribe: (() => void)[] = [];

/** Se suscribe a lo que manda el main y pide el estado inicial. Idempotente. */
export function initNetwork(): void {
  const api = window.orbit;
  if (!api || unsubscribe.length > 0) return;

  unsubscribe.push(api.net.onPeers((peers) => useNetworkStore.setState({ peers })));
  unsubscribe.push(
    api.net.onInvite((invite) => {
      useNetworkStore.setState({ invite: { ...invite, at: Date.now() } });
    }),
  );
  void api.net.state().then((state) => {
    useNetworkStore.setState({
      listening: state.listening,
      announcing: state.announcing,
      error: state.error,
      peers: state.peers,
    });
  });
  void refreshFriends();
}

export function stopNetwork(): void {
  for (const off of unsubscribe) off();
  unsubscribe = [];
}

/** Enciende o apaga la baliza. El nombre es el mismo con el que entras a las salas. */
export async function setAnnouncing(on: boolean, name: string): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  const state = await api.net.announce(on, name);
  useNetworkStore.setState({
    listening: state.listening,
    announcing: state.announcing,
    error: state.error,
  });
}

export async function refreshFriends(): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  useNetworkStore.setState({ friends: await api.friends.list() });
}

export async function addFriend(friend: Friend): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  useNetworkStore.setState({ friends: await api.friends.add(friend) });
  notify(`${friend.name} guardado en tus amigos.`);
}

export async function forgetFriend(id: string): Promise<void> {
  const api = window.orbit;
  if (!api) return;
  useNetworkStore.setState({ friends: await api.friends.forget(id) });
}

/**
 * Invita a alguien a la sala en la que estás.
 *
 * `url` tiene que ser la dirección con la que se llega desde FUERA: si el
 * servidor escucha en una IP concreta, un `localhost` en la invitación es una
 * sala a la que el invitado no puede entrar.
 */
export async function invitePerson(
  who: { name: string; address: string },
  room: string,
  url: string,
): Promise<void> {
  const api = window.orbit;
  if (!api) return;

  /*
   * Con la sala protegida, la invitación lleva un token de UN uso y media hora
   * de vida: es lo que hace que el otro entre de un clic sin que nadie le tenga
   * que decir la contraseña. Si no se consigue (no eres el productor, la sala
   * está sin contraseña, o el servidor dijo que no), se manda igual: al otro le
   * pedirán la contraseña, que es como estaba antes de esto.
   */
  const token = useCollabStore.getState().roomProtected
    ? await requestInvite(INVITE_TTL_MS, 1)
    : null;

  const result = await api.net.invite(who.address, room, url, token ?? undefined);
  if (!result.ok) {
    notify(`No se pudo invitar a ${who.name}: ${result.error ?? 'error desconocido'}`);
    return;
  }
  notify(
    token
      ? `Invitación enviada a ${who.name} (entra sin contraseña, un uso y 30 min).`
      : `Invitación enviada a ${who.name}.`,
  );
}

export function dismissInvite(): void {
  useNetworkStore.setState({ invite: null });
}

/** Nombre visible de un peer que además es amigo (o al revés). */
export function isFriend(friends: readonly Friend[], id: string): boolean {
  return friends.some((f) => f.id === id);
}
