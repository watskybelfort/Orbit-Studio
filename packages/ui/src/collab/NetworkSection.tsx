/**
 * "Gente en la red" y "Amigos" dentro del panel de Colaboración.
 *
 * Antes, meter a alguien en una sala era dictarle un código de seis caracteres
 * y una dirección IP. Aquí salen los que tienen Orbit abierto en la misma red,
 * se guardan como amigos y se les invita de un clic — y al otro le llega un
 * aviso con el botón de entrar.
 *
 * Invitar solo se ofrece estando DENTRO de una sala: una invitación a ningún
 * sitio no es una invitación.
 */

import {
  addFriend,
  forgetFriend,
  invitePerson,
  isFriend,
  setAnnouncing,
  useNetworkStore,
} from './network-state';

export interface NetworkSectionProps {
  /** Nombre con el que te anuncias (el mismo con el que entras a las salas). */
  userName: string;
  /** Sala en la que estás, o null: sin sala no se puede invitar a nada. */
  roomCode: string | null;
  /**
   * URL con la que el invitado llega a la sala. No es "la mía": si el servidor
   * escucha en una IP concreta, un localhost en la invitación es una sala a la
   * que el otro no puede entrar.
   */
  inviteUrl: string;
}

export function NetworkSection({ userName, roomCode, inviteUrl }: NetworkSectionProps) {
  const { listening, announcing, error, peers, friends, notice } = useNetworkStore();

  const canInvite = roomCode !== null && inviteUrl !== '';
  const inviteHint = canInvite
    ? 'Le llega un aviso con el botón de entrar'
    : 'Primero crea una sala o entra en una';

  return (
    <>
      <h3 className="collab-heading">Gente en la red</h3>

      <label className="collab-check" title="Manda tu nombre a la red local para que te encuentren">
        <input
          type="checkbox"
          checked={announcing}
          disabled={!listening}
          onChange={(e) => void setAnnouncing(e.target.checked, userName)}
        />
        Que me vean en esta red
      </label>
      <p className="collab-note">
        Escuchar está siempre: las invitaciones te llegan aunque no te anuncies. Anunciarte manda tu
        nombre a la red local para que los demás puedan invitarte.
      </p>

      {error !== null && (
        <p className="collab-warn">
          El descubrimiento no está disponible aquí ({error}). Las invitaciones directas pueden
          seguir funcionando.
        </p>
      )}

      {peers.length === 0 ? (
        <p className="collab-note">
          Nadie más por aquí. Aparecerán los que tengan Orbit abierto en esta red y hayan activado
          «Que me vean».
        </p>
      ) : (
        <ul className="net-list">
          {peers.map((peer) => (
            <li key={peer.id} className="net-row">
              <span className="net-name" title={peer.address}>
                {peer.name}
              </span>
              <span className="net-addr">{peer.address}</span>
              <button
                className="collab-btn"
                disabled={isFriend(friends, peer.id)}
                title={
                  isFriend(friends, peer.id)
                    ? 'Ya está en tus amigos'
                    : 'Guardarlo para invitarle otro día sin buscarlo'
                }
                onClick={() =>
                  void addFriend({ id: peer.id, name: peer.name, address: peer.address })
                }
              >
                {isFriend(friends, peer.id) ? 'Amigo ✓' : '+ Amigo'}
              </button>
              <button
                className="collab-btn primary"
                disabled={!canInvite}
                title={inviteHint}
                onClick={() => void invitePerson(peer, roomCode ?? '', inviteUrl)}
              >
                Invitar
              </button>
            </li>
          ))}
        </ul>
      )}

      {friends.length > 0 && (
        <>
          <h3 className="collab-heading">Amigos</h3>
          <ul className="net-list">
            {friends.map((friend) => {
              const online = peers.some((p) => p.id === friend.id);
              return (
                <li key={friend.id} className="net-row">
                  <span className="net-name" title={friend.address}>
                    <span className={`collab-dot ${online ? 'online' : ''}`} />
                    {friend.name}
                  </span>
                  <span className="net-addr">{online ? 'en la red' : friend.address}</span>
                  <button
                    className="collab-btn"
                    title="Quitarlo de tus amigos"
                    onClick={() => void forgetFriend(friend.id)}
                  >
                    Quitar
                  </button>
                  <button
                    className="collab-btn primary"
                    disabled={!canInvite}
                    title={inviteHint}
                    onClick={() => void invitePerson(friend, roomCode ?? '', inviteUrl)}
                  >
                    Invitar
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {notice !== null && <p className="collab-note net-notice">{notice}</p>}
    </>
  );
}
