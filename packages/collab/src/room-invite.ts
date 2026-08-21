/**
 * Invitaciones caducables de sala.
 *
 * La contraseña cierra la puerta, pero compartirla es para siempre: quien la
 * tiene entra hoy, mañana y el mes que viene, y quitársela a uno se la quita a
 * todos. Una invitación es lo contrario — vale un rato, vale un número de
 * veces, y se revoca sola.
 *
 * **Un token es un portador, y eso es deliberado.** La contraseña no viaja
 * nunca (SCRAM: viaja una prueba distinta en cada conexión); un token, por
 * definición, sí: es un secreto que se le da a alguien para que lo enseñe. Lo
 * que compensa esa diferencia es que caduca, se gasta y se puede revocar — no
 * intentar disimularla. Por eso una invitación no sustituye a la contraseña:
 * es la forma de dejar entrar a alguien SIN darle la contraseña.
 *
 * Lo que el servidor guarda es SHA-256 del secreto, igual que con la puerta:
 * quien robe el archivo de la sala tiene una lista de hashes, no un manojo de
 * llaves.
 *
 * Formato del token: `<id>.<secreto>`, los dos en base64url. El `id` está para
 * poder encontrar el registro sin comparar contra todos, y no es secreto.
 */

import { fromBase64, randomBytes, toBase64 } from './room-auth';

/** Bytes del id y del secreto. 18 bytes = 144 bits: no se adivina. */
export const INVITE_ID_BYTES = 6;
export const INVITE_SECRET_BYTES = 18;

/** Topes. Una invitación que no caduca o que no se gasta no es una invitación. */
export const INVITE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000; // una semana
export const INVITE_MIN_TTL_MS = 60 * 1000; // un minuto
export const INVITE_MAX_USES = 50;
/** Cuántas puede tener una sala a la vez (las caducadas no cuentan). */
export const INVITE_MAX_PER_ROOM = 20;

/** Lo que el servidor guarda de una invitación. No abre nada por sí solo. */
export interface RoomInviteRecord {
  v: 1;
  id: string;
  /** SHA-256(secreto) en base64. */
  hash: string;
  /** Instante en el que deja de valer (epoch ms). */
  expiresAt: number;
  /** Usos que quedan. */
  uses: number;
  createdAt: number;
  /** Quién la creó, para poder enseñarlo en la lista. */
  by: string;
}

/** Lo que se ve de una invitación sin poder usarla (para pintar la lista). */
export interface RoomInvitePublic {
  id: string;
  expiresAt: number;
  uses: number;
  createdAt: number;
  by: string;
}

export function publicInvite(record: RoomInviteRecord): RoomInvitePublic {
  const { id, expiresAt, uses, createdAt, by } = record;
  return { id, expiresAt, uses, createdAt, by };
}

// ── base64url ────────────────────────────────────────────────────────────────
// El token acaba en un campo de texto y, algún día, en una URL: '+' y '/' se
// escapan mal en los dos sitios.

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

// ── Token ────────────────────────────────────────────────────────────────────

export interface NewInvite {
  /** Lo que se le da a la persona. El servidor NO lo guarda. */
  token: string;
  id: string;
  secret: string;
}

/** Genera un token nuevo. El secreto solo existe aquí y en quien lo reciba. */
export function newInviteToken(): NewInvite {
  const id = toBase64Url(randomBytes(INVITE_ID_BYTES));
  const secret = toBase64Url(randomBytes(INVITE_SECRET_BYTES));
  return { token: `${id}.${secret}`, id, secret };
}

/** Parte un token. `null` = no tiene forma de token, ni se busca. */
export function parseInviteToken(token: unknown): { id: string; secret: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const id = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const shape = /^[A-Za-z0-9_-]+$/;
  if (!shape.test(id) || !shape.test(secret)) return null;
  return { id, secret };
}

async function subtleDigest(bytes: Uint8Array): Promise<Uint8Array> {
  const api = globalThis.crypto;
  if (!api?.subtle) throw new Error('Sin WebCrypto no se pueden usar invitaciones');
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Uint8Array(await api.subtle.digest('SHA-256', copy.buffer));
}

/** SHA-256 del secreto, en base64: es lo único que se guarda. */
export async function hashInviteSecret(secret: string): Promise<string> {
  return toBase64(await subtleDigest(fromBase64Url(secret)));
}

/**
 * Compara dos hashes en tiempo constante.
 *
 * Es base64 de un digest, no un secreto largo, pero comparar con `===` filtra
 * por dónde empieza a diferir y no cuesta nada hacerlo bien.
 */
export function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────

/** Crea el registro que guarda el servidor a partir de un token nuevo. */
export async function makeInviteRecord(
  invite: NewInvite,
  ttlMs: number,
  uses: number,
  by: string,
  now: number,
): Promise<RoomInviteRecord> {
  const ttl = Math.min(INVITE_MAX_TTL_MS, Math.max(INVITE_MIN_TTL_MS, Math.floor(ttlMs)));
  return {
    v: 1,
    id: invite.id,
    hash: await hashInviteSecret(invite.secret),
    expiresAt: now + ttl,
    uses: Math.min(INVITE_MAX_USES, Math.max(1, Math.floor(uses))),
    createdAt: now,
    by: by.slice(0, 40),
  };
}

export function inviteIsUsable(record: RoomInviteRecord, now: number): boolean {
  return record.uses > 0 && record.expiresAt > now;
}

/** Quita las gastadas y las caducadas. */
export function pruneInvites(
  records: readonly RoomInviteRecord[],
  now: number,
): RoomInviteRecord[] {
  return records.filter((r) => inviteIsUsable(r, now));
}

export interface ConsumeResult {
  ok: boolean;
  /** Por qué no, para poder decirlo con precisión al cerrar la conexión. */
  reason?: 'unknown' | 'expired' | 'spent';
  /** La lista como queda (con el uso descontado, o sin la que ya no vale). */
  next: RoomInviteRecord[];
}

/**
 * Gasta un uso de la invitación que corresponda al token.
 *
 * Puro a propósito: el servidor decide qué hacer con `next` (persistirlo), y
 * así el ciclo entero —caducidad, usos, revocado implícito— se puede probar sin
 * sockets ni disco.
 *
 * "No existe" y "caducada" se distinguen para el LOG, no para el que llama a la
 * puerta: a él se le dice lo mismo, o el mensaje de error sería un oráculo para
 * saber qué ids existen.
 */
export async function consumeInvite(
  records: readonly RoomInviteRecord[],
  token: string,
  now: number,
): Promise<ConsumeResult> {
  const parsed = parseInviteToken(token);
  const live = pruneInvites(records, now);
  if (!parsed) return { ok: false, reason: 'unknown', next: live };

  const found = records.find((r) => r.id === parsed.id);
  if (!found) return { ok: false, reason: 'unknown', next: live };

  const hash = await hashInviteSecret(parsed.secret);
  if (!hashEquals(hash, found.hash)) return { ok: false, reason: 'unknown', next: live };
  if (found.expiresAt <= now) return { ok: false, reason: 'expired', next: live };
  if (found.uses <= 0) return { ok: false, reason: 'spent', next: live };

  const next = live
    .map((r) => (r.id === found.id ? { ...r, uses: r.uses - 1 } : r))
    .filter((r) => r.uses > 0);
  return { ok: true, next };
}

// ── Lo que llega de disco ────────────────────────────────────────────────────

function isRecord(value: unknown): value is RoomInviteRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Partial<RoomInviteRecord>;
  return (
    r.v === 1 &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.hash === 'string' &&
    r.hash.length > 0 &&
    typeof r.expiresAt === 'number' &&
    Number.isFinite(r.expiresAt) &&
    typeof r.uses === 'number' &&
    Number.isFinite(r.uses) &&
    typeof r.createdAt === 'number' &&
    typeof r.by === 'string'
  );
}

/**
 * Sanea una lista venida del archivo de la sala.
 *
 * Un `.auth.json` tocado a mano o de una versión futura no puede dejar la sala
 * abierta de par en par: lo que no tiene forma de invitación se descarta, y lo
 * que se cuela queda acotado (usos y caducidad dentro de los topes).
 */
export function parseInvites(raw: unknown): RoomInviteRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .slice(0, INVITE_MAX_PER_ROOM)
    .map((r) => ({
      ...r,
      uses: Math.min(INVITE_MAX_USES, Math.max(0, Math.floor(r.uses))),
      by: r.by.slice(0, 40),
    }));
}
