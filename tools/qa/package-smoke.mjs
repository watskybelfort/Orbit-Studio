// Smoke test del PAQUETE de Windows (no de la app corriendo).
//
// Por qué no CDP: el proceso empaquetado apaga a propósito el puerto de
// depuración remota — `apps/desktop/src/main/index.ts` calcula
// `debugPort` como `!app.isPackaged ? process.env['ORBIT_DEBUG_PORT'] : undefined`,
// así que un `.exe` instalado NUNCA abre el puerto CDP que usa
// `tools/qa/cdp.mjs`. Eso es una guarda de seguridad deliberada (no exponer
// el protocolo de depuración en la app que corre en la máquina del usuario),
// no un descuido — así que un smoke "abrir la app y hablarle por CDP" no es
// viable en CI sin debilitar esa guarda. Este script hace la comprobación que
// SÍ es viable y además más determinística: que lo que `electron-builder`
// generó tenga el pack de sonidos completo en la ruta exacta que el main
// busca cuando `app.isPackaged` (`factoryDir()` en
// `apps/desktop/src/main/index.ts`, resources/sound-library) — el fallo
// concreto que preocupaba a la auditoría: la app instalada arrancando sin
// sonidos porque `extraResources` se desalineó, con el build de CI en verde
// igual porque nunca empaqueta.
//
// Uso:
//   node tools/qa/package-smoke.mjs [dir-unpacked] [instalador.exe]
//
// Sin argumentos: busca dentro de apps/desktop/dist/ una carpeta *-unpacked
// (la que deja electron-builder con target nsis antes de armar el instalador)
// y un *.exe suelto (el instalador).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const distDir = join(repoRoot, 'apps', 'desktop', 'dist');
const sourceManifestPath = join(
  repoRoot,
  'packages',
  'sound-library',
  'factory',
  'manifest.json',
);

function fail(msg) {
  console.error(`FALLO: ${msg}`);
  process.exit(1);
}

function findUnpackedDir() {
  if (process.argv[2]) return resolve(process.argv[2]);
  if (!existsSync(distDir)) {
    fail(`no existe ${distDir} — ¿corriste "npm run dist -w @orbit/desktop" antes?`);
  }
  const candidate = readdirSync(distDir).find((name) => name.endsWith('-unpacked'));
  if (!candidate) fail(`no encontré ninguna carpeta *-unpacked dentro de ${distDir}`);
  return join(distDir, candidate);
}

function findInstaller() {
  if (process.argv[3]) return resolve(process.argv[3]);
  if (!existsSync(distDir)) return null;
  const candidate = readdirSync(distDir).find((name) => name.toLowerCase().endsWith('.exe'));
  return candidate ? join(distDir, candidate) : null;
}

const unpackedDir = findUnpackedDir();
if (!existsSync(unpackedDir)) fail(`no existe el directorio unpacked: ${unpackedDir}`);
console.log(`— Directorio unpacked: ${unpackedDir}`);

// 1) El pack de sonidos está donde el main lo busca empaquetado.
const packDir = join(unpackedDir, 'resources', 'sound-library');
const manifestPath = join(packDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  fail(
    `falta ${manifestPath} — el pack de sonidos no se copió al empaquetar ` +
      `(extraResources en apps/desktop/electron-builder.yml)`,
  );
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`manifest.json empaquetado no es JSON válido: ${err.message}`);
}
const entries = manifest.entries;
if (!Array.isArray(entries) || entries.length === 0) {
  fail('manifest.json empaquetado no tiene "entries" válidas');
}

// 2) Coincide con el pack fuente — ni parcial ni de una versión vieja.
if (!existsSync(sourceManifestPath)) {
  fail(`no encuentro el manifest fuente en ${sourceManifestPath} para comparar`);
}
const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'));
const sourceEntries = sourceManifest.entries ?? [];
if (entries.length !== sourceEntries.length) {
  fail(
    `el pack empaquetado tiene ${entries.length} entradas pero el pack fuente ` +
      `tiene ${sourceEntries.length} — se desalineó el extraResources`,
  );
}

// 3) Cada archivo que el manifest referencia existe de verdad en el pack.
const missing = [];
for (const entry of entries) {
  if (!existsSync(join(packDir, entry.file))) missing.push(entry.file);
}
if (missing.length > 0) {
  fail(
    `${missing.length} archivo(s) del manifest no están en el pack empaquetado, ` +
      `ej.: ${missing.slice(0, 5).join(', ')}`,
  );
}
console.log(`OK — pack de sonidos completo: ${entries.length} entradas, todas presentes en ${packDir}`);

// 4) El ejecutable principal existe en la raíz del unpacked.
const exeInRoot = readdirSync(unpackedDir).find((name) => name.toLowerCase().endsWith('.exe'));
if (!exeInRoot) fail(`no hay ningún .exe en la raíz de ${unpackedDir}`);
console.log(`OK — ejecutable empaquetado: ${exeInRoot}`);

// 5) Tamaño del instalador (el que se sube a la Release).
const installerPath = findInstaller();
if (installerPath && existsSync(installerPath)) {
  const bytes = statSync(installerPath).size;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  console.log(`OK — instalador: ${installerPath} (${mb} MB)`);
} else {
  console.warn('AVISO: no encontré el .exe del instalador para reportar su tamaño.');
}

console.log('Smoke test de empaquetado: PASÓ.');
