/**
 * Contraseña de sala: la puerta.
 *
 * Desde v1.8 el ROL lo reparte el servidor, pero entrar seguía siendo saber el
 * código de seis caracteres. Esto cierra la puerta sin caer en lo obvio (mandar
 * la contraseña por el socket y que el servidor la guarde).
 *
 * El esquema es el de SCRAM, reducido a lo que hace falta aquí:
 *
 *   saltedPassword = PBKDF2-SHA256(contraseña, salt, iteraciones)
 *   clientKey      = HMAC(saltedPassword, "Orbit Client Key")
 *   storedKey      = SHA-256(clientKey)          <- lo UNICO que guarda el server
 *   authMessage    = "<sala>:<nonce>"            <- el nonce lo pone el server
 *   signature      = HMAC(storedKey, authMessage)
 *   proof          = clientKey XOR signature     <- lo UNICO que viaja
 *
 * El servidor recupera `clientKey = proof XOR signature` y comprueba que su
 * SHA-256 es el `storedKey` que tiene apuntado. De ahí salen las tres
 * propiedades que importan:
 *
 * - La contraseña NUNCA viaja, ni siquiera derivada: viaja una prueba distinta
 *   en cada conexión (el nonce es de un solo uso), así que grabar el tráfico no
 *   sirve para volver a entrar.
 * - El servidor no puede reconstruir la contraseña: guarda un hash de un hash.
 * - Quien robe el archivo de la sala TAMPOCO puede entrar con él: para firmar
 *   hace falta `clientKey`, y de `storedKey` solo se llega por preimagen.
 *
 * Todo con WebCrypto, que existe igual en el renderer y en Node >= 19: este
 * módulo lo comparten cliente y servidor sin `node:crypto` de por medio.
 */

/** Iteraciones de PBKDF2 por defecto (~150 ms en un portátil de 2024). */
export const AUTH_ITERATIONS = 210_000;
/** Bytes de sal y de nonce. */
export const AUTH_SALT_BYTES = 16;
export const AUTH_NONCE_BYTES = 18;
/** Tope de longitud de la contraseña (una cota, no una regla de estilo). */
export const AUTH_MAX_PASSWORD = 200;
/** Rango de iteraciones que se acepta de un registro ajeno. */
export const AUTH_MIN_ITERATIONS = 10_000;
export const AUTH_MAX_ITERATIONS = 2_000_000;

/**
 * Lo que el servidor guarda de una sala protegida. No hay nada aquí con lo que
 * entrar: `storedKey` es SHA-256 de la clave que firma, no la clave.
 */
export interface RoomAuthRecord {
  v: 1;
  /** Sal en base64. */
  salt: string;
  iterations: number;
  /** SHA-256(clientKey), en base64. */
  storedKey: string;
}

// -- base64 sin Buffer (vale en el renderer y en Node) ------------------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Bytes aleatorios de verdad (WebCrypto; sin él no hay contraseña que valga). */
export function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const api = globalThis.crypto;
  if (!api || typeof api.getRandomValues !== 'function') {
    throw new Error('Sin WebCrypto no se puede proteger una sala');
  }
  api.getRandomValues(bytes);
  return bytes;
}

/** Nonce de un solo uso para el desafío, en base64. */
export function randomNonce(): string {
  return toBase64(randomBytes(AUTH_NONCE_BYTES));
}

// -- Primitivas ---------------------------------------------------------------

function subtle(): SubtleCrypto {
  const api = globalThis.crypto;
  if (!api?.subtle) throw new Error('Sin WebCrypto no se puede proteger una sala');
  return api.subtle;
}

/** Copia con ArrayBuffer propio: WebCrypto no admite vistas sobre SharedArrayBuffer. */
function buf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function hmac(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await subtle().importKey(
    'raw',
    buf(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await subtle().sign('HMAC', cryptoKey, buf(message)));
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', buf(bytes)));
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ (b[i] ?? 0);
  return out;
}

/**
 * Comparación en tiempo constante. Con `===` sobre base64 el tiempo de fallo
 * delata cuántos bytes acertaste, y eso convierte una fuerza bruta ciega en una
 * byte a byte.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// -- Derivación ---------------------------------------------------------------

/** PBKDF2 -> HMAC: la clave con la que se firma (nunca sale de esta máquina). */
export async function deriveClientKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await subtle().importKey('raw', buf(utf8(password)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const salted = new Uint8Array(
    await subtle().deriveBits(
      { name: 'PBKDF2', salt: buf(salt), iterations, hash: 'SHA-256' },
      material,
      256,
    ),
  );
  return hmac(salted, utf8('Orbit Client Key'));
}

/** El registro que se guarda de una sala protegida (sal nueva cada vez). */
export async function makeRoomAuth(
  password: string,
  iterations = AUTH_ITERATIONS,
): Promise<RoomAuthRecord> {
  const salt = randomBytes(AUTH_SALT_BYTES);
  const clientKey = await deriveClientKey(password, salt, iterations);
  return {
    v: 1,
    salt: toBase64(salt),
    iterations,
    storedKey: toBase64(await sha256(clientKey)),
  };
}

/** El mensaje que se firma: sala + nonce, para que la prueba no valga en otra. */
export function authMessage(room: string, nonce: string): string {
  return `${room}:${nonce}`;
}

/** La prueba que manda el cliente (base64). */
export async function makeProof(
  password: string,
  salt: string,
  iterations: number,
  message: string,
): Promise<string> {
  const clientKey = await deriveClientKey(password, fromBase64(salt), iterations);
  const storedKey = await sha256(clientKey);
  const signature = await hmac(storedKey, utf8(message));
  return toBase64(xor(clientKey, signature));
}

/** ¿La prueba encaja con lo guardado? (el servidor no sabe la contraseña). */
export async function verifyProof(
  record: RoomAuthRecord,
  message: string,
  proof: string,
): Promise<boolean> {
  let proofBytes: Uint8Array;
  let storedKey: Uint8Array;
  try {
    proofBytes = fromBase64(proof);
    storedKey = fromBase64(record.storedKey);
  } catch {
    return false;
  }
  if (proofBytes.length !== storedKey.length) return false;
  const signature = await hmac(storedKey, utf8(message));
  const clientKey = xor(proofBytes, signature);
  return timingSafeEqual(await sha256(clientKey), storedKey);
}

/**
 * Un registro que llega de disco (o de un cliente) solo vale si tiene la forma
 * exacta: versión, sal y clave en base64 del tamaño correcto, e iteraciones
 * dentro de rango. Un `iterations: 1` ajeno convertiría la puerta en un adorno.
 */
export function parseRoomAuth(raw: unknown): RoomAuthRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['v'] !== 1) return null;
  const salt = o['salt'];
  const storedKey = o['storedKey'];
  const iterations = o['iterations'];
  if (typeof salt !== 'string' || typeof storedKey !== 'string') return null;
  if (typeof iterations !== 'number' || !Number.isInteger(iterations)) return null;
  if (iterations < AUTH_MIN_ITERATIONS || iterations > AUTH_MAX_ITERATIONS) return null;
  let saltBytes: Uint8Array;
  let keyBytes: Uint8Array;
  try {
    saltBytes = fromBase64(salt);
    keyBytes = fromBase64(storedKey);
  } catch {
    return null;
  }
  if (saltBytes.length < 8 || saltBytes.length > 64) return null;
  if (keyBytes.length !== 32) return null;
  return { v: 1, salt, iterations, storedKey };
}
