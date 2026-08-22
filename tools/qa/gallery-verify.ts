/**
 * Comprueba un índice firmado con el MISMO código que usa la app: se parsea
 * con `parseGalleryIndex` y se verifica con `verifyIndex`. Sirve para probar el
 * ciclo entero (firmar → publicar → verificar) sin abrir Orbit.
 *
 *   npx tsx tools/qa/gallery-verify.ts galeria.json
 */

import { readFile } from 'node:fs/promises';
import { parseGalleryIndex } from '../../packages/ui/src/state/gallery-index';
import { verifyIndex } from '../../packages/ui/src/state/gallery-signature';

const path = process.argv[2];
if (!path) {
  console.error('Uso: npx tsx tools/qa/gallery-verify.ts <galeria.json>');
  process.exit(1);
}

const index = parseGalleryIndex(await readFile(path, 'utf8'));
if (!index) {
  console.error('Eso no es un índice de galería válido');
  process.exit(1);
}
console.log(`Galería: ${index.name} (${index.plugins.length} plugins)`);
console.log(`Hashes declarados: ${index.plugins.filter((p) => p.sha256).length}`);

if (!index.signature) {
  console.log('Sin firma.');
  process.exit(0);
}
const result = await verifyIndex(index, index.signature);
console.log(result.ok ? `Firma OK · huella ${result.fingerprint}` : `Firma MAL: ${result.reason}`);
process.exit(result.ok ? 0 : 1);
