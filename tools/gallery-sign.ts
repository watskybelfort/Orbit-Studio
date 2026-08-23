/**
 * Firma un índice de galería de plugins.
 *
 * Sin esta herramienta la firma sería teórica: la app sabe verificar, pero
 * nadie podría publicar nada firmado. Aquí está el otro lado.
 *
 *   npx tsx tools/gallery-sign.ts keygen > mi-clave.json
 *   npx tsx tools/gallery-sign.ts sign galeria.json mi-clave.json
 *
 * `sign` baja cada plugin del índice, le calcula el SHA-256, lo escribe en su
 * entrada y firma el resultado. Es a propósito que descargue: lo que se firma
 * tiene que ser lo que hay AHORA en esas URLs, no lo que había cuando se
 * escribió el JSON a mano.
 *
 * La canonicalización y la verificación se IMPORTAN del módulo de la app, no
 * se copian. Si esto tuviera su propia versión de `canonicalIndex`, el día que
 * una de las dos cambiara la galería dejaría de verificar y el motivo sería
 * imposible de ver.
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  SIGNATURE_ALG,
  canonicalIndex,
  fingerprint,
  toBase64,
  fromBase64,
  verifyIndex,
  type IndexSignature,
  type SignableIndex,
} from '../packages/ui/src/state/gallery-signature';
import { parseGalleryIndex } from '../packages/ui/src/state/gallery-index';

const subtle = globalThis.crypto.subtle;

interface KeyFile {
  /** Clave pública en SPKI, base64. Es la que se publica. */
  publicKey: string;
  /** Clave privada en PKCS#8, base64. NO se publica. */
  privateKey: string;
}

async function keygen(): Promise<void> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const publicKey = toBase64(new Uint8Array(await subtle.exportKey('spki', pair.publicKey)));
  const privateKey = toBase64(new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey)));
  const file: KeyFile = { publicKey, privateKey };
  // La huella va por stderr para que `> clave.json` deje SOLO el JSON.
  console.error(`Huella de la clave: ${await fingerprint(publicKey)}`);
  console.error('Publica esa huella donde la gente pueda comprobarla (tu web, tu perfil).');
  console.error('El archivo que sale por stdout lleva la clave PRIVADA: no lo subas a ningún sitio.');
  console.log(JSON.stringify(file, null, 2));
}

async function hashOf(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} respondió ${response.status}`);
  const text = await response.text();
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toBase64(new Uint8Array(digest));
}

async function sign(indexPath: string, keyPath: string): Promise<void> {
  const raw: unknown = JSON.parse(await readFile(indexPath, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error('El índice no es un objeto');
  const index = raw as Record<string, unknown> & SignableIndex;
  if (!Array.isArray(index.plugins)) throw new Error('El índice no trae "plugins"');

  const keyFile = JSON.parse(await readFile(keyPath, 'utf8')) as KeyFile;
  const privateKey = await subtle.importKey(
    'pkcs8',
    fromBase64(keyFile.privateKey).buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  for (const plugin of index.plugins) {
    process.stderr.write(`  · ${plugin.id} … `);
    plugin.sha256 = await hashOf(plugin.url);
    process.stderr.write(`${plugin.sha256.slice(0, 12)}…\n`);
  }

  // La firma se calcula SIN el bloque de firma dentro (es lo que hace el
  // verificador), así que se quita antes por si el archivo ya venía firmado.
  delete (index as Record<string, unknown>)['signature'];

  // Se firma el índice NORMALIZADO, no el crudo. La app canoniza sobre lo que
  // sale de parseGalleryIndex (id en minúsculas, tope de 200, entradas inválidas
  // descartadas); si aquí se firmara el crudo, un id en mayúsculas o una entrada
  // de más producían una firma que la app rechazaba — y el auto-chequeo de abajo
  // no lo pillaba porque también usaba el crudo.
  const normalized = parseGalleryIndex(JSON.stringify(index));
  if (!normalized) throw new Error('El índice no es válido tras normalizar');
  const data = new TextEncoder().encode(canonicalIndex(normalized));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data);
  const signature: IndexSignature = {
    alg: SIGNATURE_ALG,
    key: keyFile.publicKey,
    sig: toBase64(new Uint8Array(sig)),
    signedAt: Date.now(),
  };

  // Se verifica lo que se acaba de firmar CONTRA EL NORMALIZADO (igual que la
  // app): si esto fallara, el archivo saldría roto y nadie se enteraría hasta
  // que alguien lo añadiera en la app.
  const check = await verifyIndex(normalized, signature);
  if (!check.ok) throw new Error(`La firma recién hecha no verifica: ${check.reason}`);

  const out = { ...index, signature };
  await writeFile(indexPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.error(`Firmado: ${indexPath}`);
  console.error(`Huella: ${check.fingerprint}`);
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'keygen') {
    await keygen();
  } else if (command === 'sign' && args.length === 2) {
    await sign(args[0]!, args[1]!);
  } else {
    console.error('Uso:');
    console.error('  npx tsx tools/gallery-sign.ts keygen > mi-clave.json');
    console.error('  npx tsx tools/gallery-sign.ts sign galeria.json mi-clave.json');
    process.exit(1);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
