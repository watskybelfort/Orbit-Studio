/**
 * Invitaciones caducables, dentro de "Puerta de la sala".
 *
 * La contraseña cierra la puerta pero compartirla es para siempre; esto es la
 * forma de dejar entrar a alguien SIN dársela: vale un rato, vale un número de
 * veces y se revoca.
 *
 * El token se enseña UNA vez. No es un capricho de la interfaz: el servidor
 * guarda su hash, así que no existe nadie —tampoco él— que lo pueda volver a
 * mostrar. Si se pierde, se revoca y se hace otra.
 */

import { useEffect, useState } from 'react';
import {
  clearFreshInvite,
  createRoomInvite,
  revokeRoomInvite,
  useCollabStore,
} from './collab-state';

const MINUTE = 60_000;

const TTLS: { label: string; ms: number }[] = [
  { label: '15 minutos', ms: 15 * MINUTE },
  { label: '1 hora', ms: 60 * MINUTE },
  { label: '8 horas', ms: 8 * 60 * MINUTE },
  { label: '1 día', ms: 24 * 60 * MINUTE },
];

const USES: { label: string; n: number }[] = [
  { label: 'una persona', n: 1 },
  { label: 'hasta 3', n: 3 },
  { label: 'hasta 10', n: 10 },
];

/** "en 42 min" / "en 3 h" / "caducada". */
function whenLeft(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'caducada';
  const min = Math.round(ms / MINUTE);
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 60);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} días`;
}

export interface InvitesBlockProps {
  /** Solo el productor crea y revoca (el servidor lo hace cumplir igual). */
  canManage: boolean;
  /** La sala tiene contraseña: sin puerta, una invitación no significa nada. */
  roomProtected: boolean;
}

export function InvitesBlock({ canManage, roomProtected }: InvitesBlockProps) {
  const invites = useCollabStore((s) => s.invites);
  const fresh = useCollabStore((s) => s.freshInvite);
  const [ttl, setTtl] = useState(TTLS[1]!.ms);
  const [uses, setUses] = useState(1);
  const [copied, setCopied] = useState(false);
  /** Reloj propio: la cuenta atrás tiene que bajar sola, no al re-renderizar. */
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!canManage) return null;

  return (
    <>
      <h3 className="collab-heading">Invitaciones</h3>
      {!roomProtected ? (
        <p className="collab-note">
          Ponle contraseña a la sala para poder invitar: sin puerta, entra quien sepa el código y
          una invitación no añadiría nada.
        </p>
      ) : (
        <>
          <p className="collab-note">
            Una invitación deja entrar <b>sin dar la contraseña</b>: caduca sola y se gasta.
          </p>
          <div className="collab-row">
            <select
              className="collab-input"
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              title="Cuánto vale"
            >
              {TTLS.map((t) => (
                <option key={t.ms} value={t.ms}>
                  Caduca en {t.label}
                </option>
              ))}
            </select>
            <select
              className="collab-input"
              value={uses}
              onChange={(e) => setUses(Number(e.target.value))}
              title="Cuánta gente puede usarla"
            >
              {USES.map((u) => (
                <option key={u.n} value={u.n}>
                  Para {u.label}
                </option>
              ))}
            </select>
            <button className="collab-btn primary" onClick={() => createRoomInvite(ttl, uses)}>
              Crear
            </button>
          </div>

          {fresh && (
            <div className="collab-error-box net-invite">
              <p className="collab-note">
                Cópiala ahora: <b>no se puede volver a ver</b> (el servidor solo guarda su huella).
              </p>
              <div className="collab-row">
                <input className="collab-input invite-token" readOnly value={fresh.token} />
                <button
                  className="collab-btn"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(fresh.token)
                      .then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1500);
                      })
                      .catch(() => {
                        // Sin portapapeles el token queda a la vista para copiarlo a mano.
                      });
                  }}
                >
                  {copied ? '¡Copiado!' : 'Copiar'}
                </button>
                <button className="collab-btn" onClick={clearFreshInvite}>
                  Hecho
                </button>
              </div>
            </div>
          )}

          {invites.length === 0 ? (
            <p className="collab-note">No hay invitaciones vivas.</p>
          ) : (
            <ul className="net-list">
              {invites.map((invite) => (
                <li key={invite.id} className="net-row">
                  <span className="net-name">
                    {invite.uses} uso{invite.uses === 1 ? '' : 's'}
                  </span>
                  <span className="net-addr">{whenLeft(invite.expiresAt, now)}</span>
                  <button
                    className="collab-btn danger"
                    onClick={() => revokeRoomInvite(invite.id)}
                    title="Deja de valer ahora mismo"
                  >
                    Revocar
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}
