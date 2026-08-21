/**
 * Aviso de invitación entrante.
 *
 * Lo importante es lo que NO hace: no entra en la sala. Unirse reemplaza el
 * proyecto abierto por el de la sala, así que la decisión no puede tomarla un
 * paquete que llega por la red — solo se enseña quién invita y a qué, y hay un
 * botón.
 *
 * El nombre de quien invita viene de fuera y se pinta como texto (React lo
 * escapa) y ya llega saneado del main: sin controles y acotado.
 */

import { formatRoomCode } from '@orbit/collab';
import { joinRoom } from './collab-state';
import { dismissInvite, useNetworkStore } from './network-state';

export interface InviteBannerProps {
  /** Con qué nombre entrarías si aceptas. */
  userName: string;
}

export function InviteBanner({ userName }: InviteBannerProps) {
  const invite = useNetworkStore((s) => s.invite);
  if (invite === null) return null;

  return (
    <div className="collab-error-box net-invite">
      <p className="collab-error">
        <b>{invite.name}</b> te invita a la sala <b>{formatRoomCode(invite.room)}</b>.
      </p>
      <p className="collab-note">
        Al entrar, el proyecto de la sala sustituye al tuyo. Si la sala pide contraseña, te la
        pedirá después.
      </p>
      <div className="collab-row">
        <button
          className="collab-btn primary"
          onClick={() => {
            dismissInvite();
            void joinRoom(invite.room, invite.url, userName);
          }}
        >
          Unirme
        </button>
        <button className="collab-btn" onClick={dismissInvite}>
          Ahora no
        </button>
      </div>
      <p className="collab-note">
        {invite.url} · desde {invite.address}
      </p>
    </div>
  );
}
