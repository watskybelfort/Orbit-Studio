/**
 * Invitaciones caducables. Lo que se prueba aquí es el ciclo de vida entero
 * —caduca, se gasta, no se puede falsificar— sin sockets ni disco, porque es
 * justo lo que no se puede verificar mirando la pantalla.
 */

import { describe, expect, it } from 'vitest';
import {
  INVITE_MAX_TTL_MS,
  INVITE_MAX_USES,
  INVITE_MIN_TTL_MS,
  consumeInvite,
  hashInviteSecret,
  inviteIsUsable,
  makeInviteRecord,
  newInviteToken,
  parseInviteToken,
  parseInvites,
  pruneInvites,
  publicInvite,
  type RoomInviteRecord,
} from '../src/room-invite';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

async function invite(
  ttlMs = 30 * MINUTE,
  uses = 1,
  now = NOW,
): Promise<{ token: string; record: RoomInviteRecord }> {
  const fresh = newInviteToken();
  return { token: fresh.token, record: await makeInviteRecord(fresh, ttlMs, uses, 'Ana', now) };
}

describe('token', () => {
  it('ida y vuelta: el token se parte en id y secreto', () => {
    const fresh = newInviteToken();
    const parsed = parseInviteToken(fresh.token);
    expect(parsed).toEqual({ id: fresh.id, secret: fresh.secret });
  });

  it('dos tokens seguidos no se parecen', () => {
    const a = newInviteToken();
    const b = newInviteToken();
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
  });

  it('solo lleva caracteres que sobreviven a una URL y a un campo de texto', () => {
    for (let i = 0; i < 20; i++) {
      expect(newInviteToken().token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
  });

  it('lo que no tiene forma de token ni se busca', () => {
    for (const bad of ['', '.', 'sinpunto', 'a.', '.b', 'a b.c', 'x'.repeat(300), null, 42]) {
      expect(parseInviteToken(bad)).toBeNull();
    }
  });

  it('el servidor guarda un hash, no el secreto', async () => {
    const fresh = newInviteToken();
    const record = await makeInviteRecord(fresh, 30 * MINUTE, 1, 'Ana', NOW);
    expect(JSON.stringify(record)).not.toContain(fresh.secret);
    expect(record.hash).toBe(await hashInviteSecret(fresh.secret));
  });
});

describe('makeInviteRecord', () => {
  it('acota la caducidad a los topes', async () => {
    const corta = await makeInviteRecord(newInviteToken(), 1, 1, 'Ana', NOW);
    expect(corta.expiresAt).toBe(NOW + INVITE_MIN_TTL_MS);
    const larga = await makeInviteRecord(newInviteToken(), 999 * INVITE_MAX_TTL_MS, 1, 'Ana', NOW);
    expect(larga.expiresAt).toBe(NOW + INVITE_MAX_TTL_MS);
  });

  it('acota los usos: ni cero ni infinitos', async () => {
    expect((await makeInviteRecord(newInviteToken(), MINUTE, 0, 'A', NOW)).uses).toBe(1);
    expect((await makeInviteRecord(newInviteToken(), MINUTE, 9999, 'A', NOW)).uses).toBe(
      INVITE_MAX_USES,
    );
  });

  it('lo público no lleva el hash', async () => {
    const { record } = await invite();
    expect(Object.keys(publicInvite(record))).not.toContain('hash');
  });
});

describe('consumeInvite', () => {
  it('un token bueno entra y gasta su uso', async () => {
    const { token, record } = await invite(30 * MINUTE, 1);
    const result = await consumeInvite([record], token, NOW);
    expect(result.ok).toBe(true);
    expect(result.next).toHaveLength(0); // era de un uso: se agota y desaparece
  });

  it('con varios usos, queda uno menos', async () => {
    const { token, record } = await invite(30 * MINUTE, 3);
    const result = await consumeInvite([record], token, NOW);
    expect(result.next[0]!.uses).toBe(2);
  });

  it('el segundo intento de una de un solo uso ya no vale', async () => {
    const { token, record } = await invite(30 * MINUTE, 1);
    const first = await consumeInvite([record], token, NOW);
    const second = await consumeInvite(first.next, token, NOW);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('unknown');
  });

  it('caducada no entra, aunque le queden usos', async () => {
    const { token, record } = await invite(10 * MINUTE, 5);
    const result = await consumeInvite([record], token, NOW + 11 * MINUTE);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('el secreto de otra invitación no abre esta', async () => {
    const a = await invite();
    const b = await invite();
    // Id de la primera con el secreto de la segunda.
    const frankenstein = `${a.record.id}.${parseInviteToken(b.token)!.secret}`;
    const result = await consumeInvite([a.record, b.record], frankenstein, NOW);
    expect(result.ok).toBe(false);
  });

  it('un id que no existe no entra', async () => {
    const { record } = await invite();
    const result = await consumeInvite([record], 'aaaa.bbbb', NOW);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown');
  });

  it('un token con basura no lanza', async () => {
    const { record } = await invite();
    await expect(consumeInvite([record], 'no-es-un-token', NOW)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('consumir limpia de paso las caducadas de la lista', async () => {
    const viva = await invite(30 * MINUTE, 1);
    const muerta = await invite(2 * MINUTE, 1);
    const result = await consumeInvite([viva.record, muerta.record], viva.token, NOW + 3 * MINUTE);
    expect(result.ok).toBe(true);
    expect(result.next).toHaveLength(0); // la usada se agota y la caducada se cae
  });

  it('fallar no se lleva por delante las que siguen vivas', async () => {
    const { record } = await invite(30 * MINUTE, 2);
    const result = await consumeInvite([record], 'aaaa.bbbb', NOW);
    expect(result.next).toHaveLength(1);
    expect(result.next[0]!.uses).toBe(2);
  });
});

describe('pruneInvites e inviteIsUsable', () => {
  it('se cae la caducada y la gastada', async () => {
    const viva = (await invite(30 * MINUTE, 1)).record;
    const caducada = (await invite(MINUTE, 1)).record;
    const gastada: RoomInviteRecord = { ...(await invite(30 * MINUTE, 1)).record, uses: 0 };
    const live = pruneInvites([viva, caducada, gastada], NOW + 2 * MINUTE);
    expect(live.map((r) => r.id)).toEqual([viva.id]);
    expect(inviteIsUsable(gastada, NOW)).toBe(false);
  });
});

describe('parseInvites', () => {
  it('lo que no tiene forma de invitación se descarta', () => {
    expect(parseInvites(null)).toEqual([]);
    expect(parseInvites('x')).toEqual([]);
    expect(parseInvites([{ id: 'a' }, 42, null, { v: 2, id: 'b' }])).toEqual([]);
  });

  it('un archivo tocado a mano no se salta los topes', async () => {
    const { record } = await invite();
    const tocado = { ...record, uses: 99999 };
    expect(parseInvites([tocado])[0]!.uses).toBe(INVITE_MAX_USES);
  });

  it('usos negativos quedan en cero, no en "infinitos"', async () => {
    const { record } = await invite();
    expect(parseInvites([{ ...record, uses: -5 }])[0]!.uses).toBe(0);
  });

  it('acota cuántas puede tener una sala', async () => {
    const { record } = await invite();
    const muchas = Array.from({ length: 100 }, (_, i) => ({ ...record, id: `id${i}` }));
    expect(parseInvites(muchas).length).toBeLessThanOrEqual(20);
  });
});
