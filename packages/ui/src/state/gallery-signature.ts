/**
 * Firma de un índice de galería.
 *
 * La galería trae código de terceros. Hasta ahora lo único que la protegía era
 * que el código NO se ejecuta para saber qué es (parseo estático) y que corre
 * en un worklet con bypass: eso limita el daño, pero no dice nada de si lo que
 * te llega es lo que el autor publicó. Un CDN comprometido, un DNS envenenado o
 * un repo con permisos de más cambian el archivo y nadie se entera.
 *
 * Esto lo cierra por el otro lado: el índice va firmado, la firma cubre el
 * **hash de cada plugin**, y al instalar se comprueba que el archivo que llega
 * es exactamente el que se firmó.
 *
 * **Lo que la firma NO hace**, y conviene decirlo alto: no vuelve seguro el
 * código. Un plugin firmado por alguien puede ser igual de malo que uno sin
 * firmar — lo que garantiza es la AUTORÍA y que nadie lo ha tocado por el
 * camino. Quien decide si se fía del autor sigue siendo el usuario.
 *
 * ECDSA P-256 con SHA-256 y no Ed25519: WebCrypto lo tiene en todas partes sin
 * banderas, y aquí la compatibilidad vale más que los 32 bytes de firma.
 */

/** Lo que hay que firmar y verificar, en el orden en que se serializa. */
export interface SignablePlugin {
  id: string;
  url: string;
  /** SHA-256 del archivo, en base64. Vacío si el índice no lo declara. */
  sha256?: string;
}

export interface SignableIndex {
  name: string;
  description?: string;
  plugins: SignablePlugin[];
}

export interface IndexSignature {
  /** Único valor admitido hoy; está para poder cambiar de esquema sin romper. */
  alg: 'ECDSA-P256-SHA256';
  /** Clave pública en SPKI, base64. */
  key: string;
  /** Firma en base64 (r||s, formato "raw" de WebCrypto). */
  sig: string;
  /** Cuándo se firmó (epoch ms). Informativo: no se usa para decidir nada. */
  signedAt?: number;
}

export const SIGNATURE_ALG = 'ECDSA-P256-SHA256';

// ── base64 sin Buffer (esto corre en el renderer) ────────────────────────────

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

// ── Qué se firma ─────────────────────────────────────────────────────────────

/**
 * Texto canónico del índice: lo que de verdad se firma.
 *
 * No se firman los bytes del JSON, y es a propósito. Firmar el archivo tal cual
 * obligaría a que cada espacio y cada orden de claves sobrevivieran intactos
 * hasta el verificador — reformatear el JSON, o que un CDN lo re-serialice,
 * rompería la firma sin que nadie haya hecho nada malo.
 *
 * Aquí se construye una cadena a partir de los campos YA VALIDADOS, en un orden
 * fijo y con los plugins ordenados por id. Eso hace la firma estable frente al
 * formato y, lo importante, deja explícito QUÉ cubre: el nombre de la galería y,
 * por cada plugin, su id, su URL y el hash de su archivo. Lo que no está en esta
 * cadena no está firmado.
 */
export function canonicalIndex(index: SignableIndex): string {
  const lines: string[] = ['orbit-gallery-v1', `name:${index.name}`];
  if (index.description) lines.push(`description:${index.description}`);
  const plugins = [...index.plugins].sort((a, b) => a.id.localeCompare(b.id));
  for (const p of plugins) {
    lines.push(`plugin:${p.id}|${p.url}|${p.sha256 ?? ''}`);
  }
  return lines.join('\n');
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto;
  if (!api?.subtle) throw new Error('Sin WebCrypto no se pueden verificar firmas');
  return api.subtle;
}

/** Copia con ArrayBuffer propio: WebCrypto no admite vistas sobre buffers ajenos. */
function buf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** SHA-256 de un texto UTF-8, en base64. Es lo que se compara al instalar. */
export async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return toBase64(new Uint8Array(await subtle().digest('SHA-256', buf(bytes))));
}

export async function importPublicKey(spkiBase64: string): Promise<CryptoKey> {
  return subtle().importKey(
    'spki',
    buf(fromBase64(spkiBase64)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

export type VerifyResult =
  /** La firma cuadra con la clave que trae el índice. */
  | { ok: true; fingerprint: string }
  /** No cuadra, o el bloque de firma no se sostiene. */
  | { ok: false; reason: string };

/**
 * Comprueba la firma del índice contra la clave que él mismo trae.
 *
 * Ojo con lo que esto significa: que un índice esté "bien firmado" solo dice
 * que quien tiene ESA clave lo firmó. Cualquiera puede generar una clave y
 * firmar lo suyo. Lo que convierte eso en confianza es fijar la clave la
 * primera vez y exigir que no cambie (ver `gallery.ts`).
 */
export async function verifyIndex(
  index: SignableIndex,
  signature: IndexSignature,
): Promise<VerifyResult> {
  if (signature.alg !== SIGNATURE_ALG) {
    return { ok: false, reason: `Algoritmo de firma desconocido: ${String(signature.alg)}` };
  }
  try {
    const key = await importPublicKey(signature.key);
    const data = new TextEncoder().encode(canonicalIndex(index));
    const ok = await subtle().verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      buf(fromBase64(signature.sig)),
      buf(data),
    );
    if (!ok) return { ok: false, reason: 'La firma no cuadra con el contenido del índice' };
    return { ok: true, fingerprint: await fingerprint(signature.key) };
  } catch (err) {
    // Una clave o una firma mal formadas hacen lanzar a WebCrypto: eso es "no
    // verificado", no un fallo de la app.
    return {
      ok: false,
      reason: err instanceof Error ? `Firma ilegible: ${err.message}` : 'Firma ilegible',
    };
  }
}

/**
 * Huella corta y legible de una clave pública, para que una persona pueda
 * compararla de un vistazo: `A1B2 C3D4 E5F6 7890`.
 *
 * Se compara la HUELLA, no la clave entera, porque una clave en base64 nadie la
 * lee; y son 8 bytes del SHA-256, que es de sobra para que no haya dos iguales
 * por accidente.
 */
export async function fingerprint(spkiBase64: string): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', buf(fromBase64(spkiBase64))));
  const hex = [...digest.slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).join(' ');
}
