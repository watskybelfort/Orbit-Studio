import { describe, expect, it } from 'vitest';
import { signSession, verifySession, type SessionClaim } from '../src/index';

const claim = (extra: Partial<SessionClaim> = {}): SessionClaim => ({
  sid: 'sesion-1',
  room: 'K3P9QF',
  role: 'invitado',
  exp: Date.now() + 60_000,
  ...extra,
});

describe('credencial de sesión firmada', () => {
  it('verifica la firma y devuelve el sid y el rol', () => {
    const token = signSession(claim());
    expect(verifySession(token, 'K3P9QF')).toMatchObject({ sid: 'sesion-1', role: 'invitado' });
  });

  it('un cambio de un carácter en la firma o en el payload la invalida', () => {
    const token = signSession(claim());
    const [payload, sig] = token.split('.');
    // El carácter elegido tiene que ser DISTINTO del que ya está: el test
    // anterior cambiaba el último por 'A' y en Windows la firma ya acababa en
    // 'A', así que no cambiaba nada y el token seguía siendo válido.
    const changed = sig!.startsWith('A') ? 'B' : 'A';
    expect(verifySession(`${payload}.${changed}${sig!.slice(1)}`, 'K3P9QF')).toBeNull();
    const altered = Buffer.from(payload!, 'base64url').toString('utf8').replace('invitado', 'productor');
    const fakePayload = Buffer.from(altered, 'utf8').toString('base64url');
    expect(verifySession(`${fakePayload}.${sig}`, 'K3P9QF')).toBeNull();
  });

  it('no vale para otra sala, ni caducada', () => {
    expect(verifySession(signSession(claim()), 'OTRA12')).toBeNull();
    expect(verifySession(signSession(claim({ exp: Date.now() - 1 })), 'K3P9QF')).toBeNull();
  });
});
